import {
  TransportError,
  type AcceptedEvent,
  type ConnectionHandlers,
  type ControlSnapshot,
  type NotificationConnection,
  type SendFilter,
  type ServerErrorCode,
  type ServerNotification,
  type StoredEvent,
  type TransportErrorCode,
  type TransportPort,
} from "@csu/core";
import {
  EVENT_SOURCE_CLOSED,
  type AbortControllerConstructor,
  type EventSourceConstructor,
  type FetchLike,
  type ResponseLike,
} from "./web-types.js";

// 実行時のグローバル。使う分だけを宣言する（型は、web-types.ts を参照）。
declare const fetch: FetchLike;
declare const EventSource: EventSourceConstructor;
declare const AbortController: AbortControllerConstructor;
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** 認証トークンの供給元（静的文字列、同期/非同期プロバイダ）。 */
export type AuthTokenProvider =
  | string
  | (() => string | undefined | Promise<string | undefined>);

export interface HttpTransportOptions {
  /** サーバーの基準 URL（末尾の `/` は、あってもなくてもよい）。 */
  readonly baseUrl: string;
  /** メッセージの `schemaVersion`（IF §2.2。v0.1 は "1"）。 */
  readonly schemaVersion: string;
  /** V-05: HTTP リクエストのタイムアウト（既定 10 秒）。 */
  readonly timeoutMs?: number;
  /** Bearer 認証トークン（IF §3、#8）。HTTP はヘッダー、SSE は `token` クエリで送る。 */
  readonly authToken?: AuthTokenProvider;
  /** Cookie 等を使う場合の資格情報送信設定（省略時は既定動作）。 */
  readonly withCredentials?: boolean;
  /** 注入用。省略した場合は、グローバルを使う。 */
  readonly fetch?: FetchLike;
  readonly EventSource?: EventSourceConstructor;
  readonly AbortController?: AbortControllerConstructor;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const SERVER_ERROR_CODES = new Set<ServerErrorCode>([
  "INVALID_MESSAGE",
  "SCHEMA_VERSION_MISMATCH",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "LOCK_NOT_HELD",
  "ROOM_NOT_FOUND",
  "STALE_CONTROL_SEQ",
  "LOCK_HELD_BY_OTHER",
  "TARGET_OFFLINE",
  "INVARIANT_VIOLATION",
]);

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function invalidResponse(
  message = "invalid response from the server",
): TransportError {
  return new TransportError(message, "INVALID_RESPONSE");
}

function parseSendFilter(value: unknown): SendFilter | null {
  if (!isRecord(value)) {
    return null;
  }
  const mode = value.mode;
  if (mode !== "ALL" && mode !== "NONE" && mode !== "TYPES") {
    return null;
  }
  if (value.types !== undefined && !isStringArray(value.types)) {
    return null;
  }
  if (value.targetIds !== undefined && !isStringArray(value.targetIds)) {
    return null;
  }
  return {
    mode,
    ...(value.types !== undefined ? { types: value.types } : {}),
    ...(value.targetIds !== undefined ? { targetIds: value.targetIds } : {}),
  };
}

function parseControlSnapshot(body: unknown): ControlSnapshot {
  if (
    !isRecord(body) ||
    typeof body.controlSeq !== "number" ||
    !Number.isInteger(body.controlSeq) ||
    body.controlSeq < 0 ||
    !isRecord(body.control)
  ) {
    throw invalidResponse();
  }
  const holderId = body.control.holderId;
  if (holderId !== null && typeof holderId !== "string") {
    throw invalidResponse();
  }
  const sendFilter = parseSendFilter(body.control.sendFilter);
  if (sendFilter === null) {
    throw invalidResponse();
  }
  return {
    controlSeq: body.controlSeq,
    control: {
      sendFilter,
      holderId,
    },
  };
}

function parseAcceptedEvents(body: unknown): readonly AcceptedEvent[] {
  if (!isRecord(body) || !Array.isArray(body.accepted)) {
    throw invalidResponse();
  }
  const accepted: AcceptedEvent[] = [];
  for (const item of body.accepted) {
    if (
      !isRecord(item) ||
      typeof item.eventId !== "string" ||
      item.eventId.length === 0 ||
      typeof item.eventSeq !== "number" ||
      !Number.isInteger(item.eventSeq) ||
      item.eventSeq < 1
    ) {
      throw invalidResponse();
    }
    accepted.push({
      eventId: item.eventId,
      eventSeq: item.eventSeq,
    });
  }
  return accepted;
}

function isServerErrorCode(value: string): value is ServerErrorCode {
  return SERVER_ERROR_CODES.has(value as ServerErrorCode);
}

type ParsedNotification =
  | { readonly kind: "notification"; readonly notification: ServerNotification }
  | { readonly kind: "mismatch" }
  | { readonly kind: "invalid" };

/**
 * TransportPort の HTTP と SSE の実装（BD C-010）。IF/API仕様書の契約に従う。
 * 共通項目の `schemaVersion` と `requestId` は、HTTP ではヘッダー、SSE では
 * クエリパラメータで送る（IF §2.2）。
 */
export class HttpTransport implements TransportPort {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchLike;
  private readonly eventSourceCtor: EventSourceConstructor;
  private readonly abortControllerCtor: AbortControllerConstructor;

  constructor(private readonly options: HttpTransportOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // グローバルの fetch をメソッドとして呼ぶとブラウザで Illegal invocation になるため、束縛せず包む。
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.eventSourceCtor = options.EventSource ?? EventSource;
    this.abortControllerCtor = options.AbortController ?? AbortController;
  }

  /** IF-001: 制御状態の取得。 */
  async fetchControl(args: {
    roomId: string;
    targetId: string;
    requestId: string;
  }): Promise<ControlSnapshot> {
    const query = `?targetId=${encodeURIComponent(args.targetId)}`;
    const body = await this.request(
      `${this.roomUrl(args.roomId)}/control${query}`,
      { method: "GET" },
      args.requestId,
    );
    return parseControlSnapshot(body);
  }

  /** IF-002: イベントの送信。 */
  async pushEvents(args: {
    roomId: string;
    targetId: string;
    controlSeq: number;
    events: readonly StoredEvent[];
    requestId: string;
  }): Promise<readonly AcceptedEvent[]> {
    const body = await this.request(
      `${this.roomUrl(args.roomId)}/events`,
      {
        method: "POST",
        body: JSON.stringify({
          targetId: args.targetId,
          controlSeq: args.controlSeq,
          events: args.events.map((e) => ({
            eventId: e.eventId,
            payload: e.payload,
          })),
        }),
      },
      args.requestId,
    );
    return parseAcceptedEvents(body);
  }

  /** IF-004: presence heartbeat（応答の本文はない。204）。 */
  async sendPresence(args: {
    roomId: string;
    targetId: string;
    requestId: string;
  }): Promise<void> {
    await this.request(
      `${this.roomUrl(args.roomId)}/presence`,
      { method: "POST", body: JSON.stringify({ targetId: args.targetId }) },
      args.requestId,
    );
  }

  /** IF-003: 更新通知の接続（SSE）。`requestId` は、接続単位。 */
  connect(
    args: { roomId: string; targetId: string; requestId: string },
    handlers: ConnectionHandlers,
  ): NotificationConnection {
    const openWithToken = (token: string | undefined): EventSourceLike => {
      // EventSource は、独自ヘッダーを送れないため、共通項目・トークンは、クエリパラメータで送る。
      const params = [
        `targetId=${encodeURIComponent(args.targetId)}`,
        `schemaVersion=${encodeURIComponent(this.options.schemaVersion)}`,
        `requestId=${encodeURIComponent(args.requestId)}`,
        ...(typeof token === "string" && token.length > 0
          ? [`token=${encodeURIComponent(token)}`]
          : []),
      ].join("&");
      const url = `${this.roomUrl(args.roomId)}/notifications?${params}`;
      const source =
        this.options.withCredentials !== undefined
          ? new this.eventSourceCtor(url, {
              withCredentials: this.options.withCredentials,
            })
          : new this.eventSourceCtor(url);

      source.onopen = () => handlers.onOpen();
      source.onmessage = (event) => {
        const parsed = this.parseNotification(event.data);
        if (parsed.kind === "notification") {
          handlers.onNotification(parsed.notification);
        } else if (parsed.kind === "mismatch") {
          source.close();
          handlers.onError({ closed: true, code: "SCHEMA_VERSION_MISMATCH" });
        }
      };
      source.onerror = () => {
        // CLOSED の場合は、ブラウザが再接続しない。クライアントは、IF-001 で原因を判別する。
        handlers.onError({ closed: source.readyState === EVENT_SOURCE_CLOSED });
      };
      return source;
    };

    const rawToken =
      typeof this.options.authToken === "function"
        ? this.options.authToken()
        : this.options.authToken;

    if (!isPromiseLike<string | undefined>(rawToken)) {
      const source = openWithToken(rawToken);
      return { close: () => source.close() };
    }

    let closed = false;
    let activeSource: EventSourceLike | null = null;
    void rawToken.then(
      (token) => {
        if (closed) {
          return;
        }
        activeSource = openWithToken(token);
      },
      () => {
        if (closed) {
          return;
        }
        handlers.onError({ closed: true, code: "UNAUTHORIZED" });
      },
    );
    return {
      close: () => {
        closed = true;
        activeSource?.close();
      },
    };
  }

  // ---- 内部 ----

  private async resolveAuthToken(): Promise<string | undefined> {
    if (this.options.authToken === undefined) {
      return undefined;
    }
    try {
      const token =
        typeof this.options.authToken === "function"
          ? await this.options.authToken()
          : this.options.authToken;
      return typeof token === "string" && token.length > 0 ? token : undefined;
    } catch {
      throw new TransportError("failed to resolve auth token", "UNAUTHORIZED");
    }
  }

  private roomUrl(roomId: string): string {
    return `${this.base}/rooms/${encodeURIComponent(roomId)}`;
  }

  private parseNotification(data: string): ParsedNotification {
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed) || typeof parsed.schemaVersion !== "string") {
        return { kind: "invalid" };
      }
      if (parsed.schemaVersion !== this.options.schemaVersion) {
        return { kind: "mismatch" };
      }
      if (
        (parsed.type !== "CONTROL_UPDATED" && parsed.type !== "EVENTS_APPENDED") ||
        typeof parsed.controlSeq !== "number" ||
        !Number.isInteger(parsed.controlSeq) ||
        parsed.controlSeq < 0
      ) {
        return { kind: "invalid" };
      }
      if (
        parsed.eventSeq !== undefined &&
        (typeof parsed.eventSeq !== "number" ||
          !Number.isInteger(parsed.eventSeq) ||
          parsed.eventSeq < 1)
      ) {
        return { kind: "invalid" };
      }
      return {
        kind: "notification",
        notification: {
          type: parsed.type,
          controlSeq: parsed.controlSeq,
          ...(typeof parsed.eventSeq === "number"
            ? { eventSeq: parsed.eventSeq }
            : {}),
        },
      };
    } catch {
      // 不正な通知は、無視する（接続は維持する）。
      return { kind: "invalid" };
    }
  }

  /**
   * HTTP リクエストを実行する。成功の応答は、JSON（本文なしの場合は undefined）を返す。
   * - 通信の失敗、本文読み込みの失敗、タイムアウト、HTTP 5xx: `code` なしの TransportError（再試行できる）。
   * - 2xx の不正な JSON: `INVALID_RESPONSE` の TransportError。
   * - 4xx: IF の共通エラー形式（`code`、`controlSeq`）を、TransportError にする。
   */
  private async request(
    url: string,
    init: { method: string; body?: string },
    requestId: string,
  ): Promise<unknown> {
    const token = await this.resolveAuthToken();
    const controller = new this.abortControllerCtor();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: ResponseLike;
    let text: string;
    try {
      response = await this.fetchFn(url, {
        method: init.method,
        headers: {
          "X-Schema-Version": this.options.schemaVersion,
          "X-Request-Id": requestId,
          ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(this.options.withCredentials === true
          ? { credentials: "include" }
          : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: controller.signal,
      });
      // 本文の読み込みも、タイムアウト（V-05）および通信エラー分類の対象に含める。
      text = await response.text();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "network failure";
      throw new TransportError(message);
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      if (text === "") {
        return undefined;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw invalidResponse("invalid JSON response from the server");
      }
    }
    if (response.status >= 500) {
      throw new TransportError(`server error: HTTP ${response.status}`);
    }
    throw this.toError(response.status, text);
  }

  /** 4xx の応答を、IF の共通エラー形式から、TransportError にする。 */
  private toError(status: number, text: string): TransportError {
    try {
      const body: unknown = JSON.parse(text);
      if (isRecord(body) && typeof body.code === "string") {
        const code: TransportErrorCode = isServerErrorCode(body.code)
          ? body.code
          : `HTTP_${status}`;
        return new TransportError(
          typeof body.message === "string" ? body.message : body.code,
          code,
          typeof body.controlSeq === "number" ? body.controlSeq : undefined,
        );
      }
    } catch {
      // 本文が JSON でない場合は、下の汎用のエラーにする。
    }
    return new TransportError(`unexpected response: HTTP ${status}`, `HTTP_${status}`);
  }
}
