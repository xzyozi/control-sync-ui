import { TransportError } from "@csu/core";
import type {
  AcceptedEvent,
  ConnectionHandlers,
  ControlSnapshot,
  NotificationConnection,
  ServerNotification,
  StoredEvent,
  TransportPort,
} from "@csu/core";
import {
  type AbortControllerConstructor,
  EVENT_SOURCE_CLOSED,
  type EventSourceConstructor,
  type FetchLike,
  type ResponseLike,
} from "./web-types";

// 実行時のグローバル。使う分だけを宣言する（型は、web-types.ts を参照）。
declare const fetch: FetchLike;
declare const EventSource: EventSourceConstructor;
declare const AbortController: AbortControllerConstructor;
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

export interface HttpTransportOptions {
  /** サーバーの基準 URL（末尾の `/` は、あってもなくてもよい）。 */
  readonly baseUrl: string;
  /** メッセージの `schemaVersion`（IF §2.2。v0.1 は "1"）。 */
  readonly schemaVersion: string;
  /** V-05: HTTP リクエストのタイムアウト（既定 10 秒）。 */
  readonly timeoutMs?: number;
  /** 注入用。省略した場合は、グローバルを使う。 */
  readonly fetch?: FetchLike;
  readonly EventSource?: EventSourceConstructor;
  readonly AbortController?: AbortControllerConstructor;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    this.fetchFn = options.fetch ?? fetch;
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
    if (
      !isRecord(body) ||
      typeof body.controlSeq !== "number" ||
      !isRecord(body.control)
    ) {
      throw new TransportError("invalid response from the server", "INVALID_RESPONSE");
    }
    return body as unknown as ControlSnapshot;
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
    if (!isRecord(body) || !Array.isArray(body.accepted)) {
      throw new TransportError("invalid response from the server", "INVALID_RESPONSE");
    }
    return body.accepted as AcceptedEvent[];
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
    // EventSource は、独自ヘッダーを送れないため、共通項目は、クエリパラメータで送る。
    const params = [
      `targetId=${encodeURIComponent(args.targetId)}`,
      `schemaVersion=${encodeURIComponent(this.options.schemaVersion)}`,
      `requestId=${encodeURIComponent(args.requestId)}`,
    ].join("&");
    const source = new this.eventSourceCtor(
      `${this.roomUrl(args.roomId)}/notifications?${params}`,
    );

    source.onopen = () => handlers.onOpen();
    source.onmessage = (event) => {
      const notification = this.parseNotification(event.data);
      if (notification !== null) {
        handlers.onNotification(notification);
      }
    };
    source.onerror = () => {
      // CLOSED の場合は、ブラウザが再接続しない。クライアントは、IF-001 で原因を判別する。
      handlers.onError({ closed: source.readyState === EVENT_SOURCE_CLOSED });
    };
    return { close: () => source.close() };
  }

  // ---- 内部 ----

  private roomUrl(roomId: string): string {
    return `${this.base}/rooms/${encodeURIComponent(roomId)}`;
  }

  private parseNotification(data: string): ServerNotification | null {
    try {
      const parsed: unknown = JSON.parse(data);
      if (
        isRecord(parsed) &&
        (parsed.type === "CONTROL_UPDATED" || parsed.type === "EVENTS_APPENDED") &&
        typeof parsed.controlSeq === "number"
      ) {
        return {
          type: parsed.type,
          controlSeq: parsed.controlSeq,
          ...(typeof parsed.eventSeq === "number"
            ? { eventSeq: parsed.eventSeq }
            : {}),
        };
      }
    } catch {
      // 不正な通知は、無視する（接続は維持する）。
    }
    return null;
  }

  /**
   * HTTP リクエストを実行する。成功の応答は、JSON（本文なしの場合は undefined）を返す。
   * - 通信の失敗、タイムアウト、HTTP 5xx: `code` なしの TransportError（再試行できる）。
   * - 4xx: IF の共通エラー形式（`code`、`controlSeq`）を、TransportError にする。
   */
  private async request(
    url: string,
    init: { method: string; body?: string },
    requestId: string,
  ): Promise<unknown> {
    const controller = new this.abortControllerCtor();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: ResponseLike;
    try {
      response = await this.fetchFn(url, {
        method: init.method,
        headers: {
          "X-Schema-Version": this.options.schemaVersion,
          "X-Request-Id": requestId,
          ...(init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: controller.signal,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "network failure";
      throw new TransportError(message);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (response.ok) {
      return text === "" ? undefined : (JSON.parse(text) as unknown);
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
        return new TransportError(
          typeof body.message === "string" ? body.message : body.code,
          body.code,
          typeof body.controlSeq === "number" ? body.controlSeq : undefined,
        );
      }
    } catch {
      // 本文が JSON でない場合は、下の汎用のエラーにする。
    }
    return new TransportError(`unexpected response: HTTP ${status}`, `HTTP_${status}`);
  }
}
