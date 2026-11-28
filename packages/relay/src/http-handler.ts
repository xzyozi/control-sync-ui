import { RelayError } from "./errors";
import type { IncomingRequest, ServerResponseLike } from "./node-types";
import type { RelayCore } from "./relay-core";
import type { Envelope, Notification } from "./types";
import { isRecord } from "./validation";

declare const console: { error: (...data: unknown[]) => void };
declare const TextDecoder: new (
  label?: string,
  options?: { fatal?: boolean },
) => {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
};
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const ROOM_ROUTE_RE =
  /^\/rooms\/([^/]+)\/(control|events|notifications|presence|lease)$/;
// HTTP ヘッダー値として安全な可視 ASCII と半角スペースのみを許可する（CR/LF や非 ASCII で ERR_INVALID_CHAR を防ぐ）。
const SAFE_HEADER_VALUE_RE = /^[\x20-\x7E]+$/;

export interface RelayHttpOptions {
  /**
   * 現在時刻（ミリ秒）の供給元。lease 期限タイマーの計算に使う。
   * テスト等で `RelayCore` に偽時計を渡す場合は、同じ `now` 関数を指定すること
   * （`RelayCore` より進んだ時刻を返すと、期限前でも即時再試行が繰り返される）。
   */
  readonly now?: () => number;
  /** POST 本文の最大バイト数（既定 1 MiB）。 */
  readonly maxBodyBytes?: number;
  /**
   * CORS の `Access-Control-Allow-Origin` 値（既定 `"*"`）。
   * `null` を指定すると CORS ヘッダーを付与しない。
   */
  readonly corsOrigin?: string | null;
  /** 想定外の内部例外を処理する。既定は標準エラーへの出力。 */
  readonly onInternalError?: (error: unknown) => void;
}

export interface RelayHttpController {
  /** Node.js の `http.createServer` に渡すリクエストハンドラ。 */
  readonly handler: (req: IncomingRequest, res: ServerResponseLike) => void;
  /** `relay.nextExpiry()` に合わせて lease 期限タイマーを再設定する。 */
  scheduleLeaseExpiry(): void;
  /** タイマーと開いているすべての SSE 接続を閉じる。 */
  close(): void;
  /** 現在開いている SSE 接続数。 */
  activeStreamCount(): number;
}

interface ParsedUrl {
  readonly pathname: string;
  readonly query: Map<string, string>;
}

function decodePart(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new RelayError("INVALID_MESSAGE", "invalid URL encoding");
  }
}

function parseRequestUrl(rawUrl: string): ParsedUrl {
  const qIndex = rawUrl.indexOf("?");
  const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const query = new Map<string, string>();
  if (qIndex !== -1) {
    const search = rawUrl.slice(qIndex + 1);
    for (const part of search.split("&")) {
      if (part === "") {
        continue;
      }
      const eqIndex = part.indexOf("=");
      if (eqIndex === -1) {
        query.set(decodePart(part.replace(/\+/g, " ")), "");
      } else {
        const key = decodePart(part.slice(0, eqIndex).replace(/\+/g, " "));
        const value = decodePart(part.slice(eqIndex + 1).replace(/\+/g, " "));
        query.set(key, value);
      }
    }
  }
  return { pathname, query };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length === 1) {
    return value[0];
  }
  return undefined;
}

function isSafeHeaderValue(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    SAFE_HEADER_VALUE_RE.test(value)
  );
}

function assertSafeRequestId(requestId: string | undefined): void {
  if (
    requestId !== undefined &&
    requestId.length > 0 &&
    !SAFE_HEADER_VALUE_RE.test(requestId)
  ) {
    throw new RelayError(
      "INVALID_MESSAGE",
      "requestId must contain only printable ASCII characters",
    );
  }
}

function httpEnvelope(req: IncomingRequest): Envelope {
  return {
    schemaVersion: headerValue(req.headers["x-schema-version"]),
    requestId: headerValue(req.headers["x-request-id"]),
  };
}

function readJsonBody(
  req: IncomingRequest,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener?.("data", onData);
      req.removeListener?.("end", onEnd);
      req.removeListener?.("error", onError);
      req.removeListener?.("close", onAbort);
      req.removeListener?.("aborted", onAbort);
    };

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onData = (chunk: unknown) => {
      try {
        let bytes: number;
        let text: string;
        if (chunk instanceof Uint8Array) {
          bytes = chunk.byteLength;
          totalBytes += bytes;
          if (totalBytes > maxBodyBytes) {
            // ソケットを即座に破棄すると 400 応答前に切断されるため、破棄せず読み捨ててエラー応答を返す。
            req.resume?.();
            fail(new RelayError("INVALID_MESSAGE", "request body too large"));
            return;
          }
          text = decoder.decode(chunk, { stream: true });
        } else if (typeof chunk === "string") {
          bytes = chunk.length;
          totalBytes += bytes;
          if (totalBytes > maxBodyBytes) {
            req.resume?.();
            fail(new RelayError("INVALID_MESSAGE", "request body too large"));
            return;
          }
          text = chunk;
        } else {
          fail(new RelayError("INVALID_MESSAGE", "unsupported request body chunk"));
          return;
        }
        chunks.push(text);
      } catch {
        req.resume?.();
        fail(new RelayError("INVALID_MESSAGE", "request body must be valid UTF-8"));
      }
    };

    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        chunks.push(decoder.decode());
      } catch {
        reject(new RelayError("INVALID_MESSAGE", "request body must be valid UTF-8"));
        return;
      }
      const raw = chunks.join("");
      if (raw.length === 0) {
        reject(new RelayError("INVALID_MESSAGE", "request body is required"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(new RelayError("INVALID_MESSAGE", "request body must be valid JSON"));
        return;
      }
      if (!isRecord(parsed)) {
        reject(
          new RelayError("INVALID_MESSAGE", "request body must be a JSON object"),
        );
        return;
      }
      resolve(parsed);
    };

    const onError = (error: unknown) => {
      fail(error);
    };

    const onAbort = () => {
      fail(
        new RelayError(
          "INVALID_MESSAGE",
          "request aborted before body completed",
        ),
      );
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onAbort);
    req.on("aborted", onAbort);
  });
}

function applyCors(
  res: ServerResponseLike,
  corsOrigin: string | null,
): void {
  if (corsOrigin === null) {
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Schema-Version, X-Request-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
}

function writeJson(
  res: ServerResponseLike,
  status: number,
  body: unknown,
  requestId: string | undefined,
  corsOrigin: string | null,
): void {
  if (res.writableEnded) {
    return;
  }
  res.statusCode = status;
  applyCors(res, corsOrigin);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (isSafeHeaderValue(requestId)) {
    res.setHeader("X-Request-Id", requestId);
  }
  res.end(JSON.stringify(body));
}

function writeEmpty(
  res: ServerResponseLike,
  status: number,
  requestId: string | undefined,
  corsOrigin: string | null,
): void {
  if (res.writableEnded) {
    return;
  }
  res.statusCode = status;
  applyCors(res, corsOrigin);
  if (isSafeHeaderValue(requestId)) {
    res.setHeader("X-Request-Id", requestId);
  }
  res.end();
}

/**
 * IF-001〜IF-006 を処理する HTTP / SSE リクエストハンドラを作成する。
 * lease の期限切れ解放タイマー（DD V-09）も管理する。
 */
export function createRelayHandler(
  relay: RelayCore,
  options: RelayHttpOptions = {},
): RelayHttpController {
  const now = options.now ?? (() => Date.now());
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const corsOrigin = options.corsOrigin === undefined ? "*" : options.corsOrigin;
  const onInternalError =
    options.onInternalError ??
    ((error) => console.error("[relay] unexpected http error:", error));

  let closed = false;
  let expiryTimer: unknown = null;
  const activeStreams = new Set<() => void>();

  const clearTimer = () => {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  };

  const scheduleLeaseExpiry = () => {
    clearTimer();
    if (closed) {
      return;
    }
    const next = relay.nextExpiry();
    if (next === null) {
      return;
    }
    const delay = Math.max(0, next - now());
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      if (closed) {
        return;
      }
      relay.tick();
      scheduleLeaseExpiry();
    }, delay);
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearTimer();
    for (const closeStream of [...activeStreams]) {
      closeStream();
    }
    activeStreams.clear();
  };

  const openSseStream = (
    res: ServerResponseLike,
    roomId: string,
    targetId: string,
    env: Envelope,
  ) => {
    let streamClosed = false;
    let disconnectRelay: (() => void) | null = null;

    const closeStream = () => {
      if (streamClosed) {
        return;
      }
      streamClosed = true;
      activeStreams.delete(closeStream);
      disconnectRelay?.();
      disconnectRelay = null;
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // 既に閉じられたソケットの終了失敗は無視する。
        }
      }
    };

    const listener = (notification: Notification) => {
      if (streamClosed || res.writableEnded) {
        closeStream();
        return;
      }
      try {
        res.write(`data: ${JSON.stringify(notification)}\n\n`);
      } catch {
        closeStream();
      }
    };

    // 共通項目・Room・targetId の検証を先に行い、失敗時は通常の HTTP エラーを返す（IF §4.3.3）。
    disconnectRelay = relay.connect(roomId, { targetId }, listener, env);
    if (closed) {
      disconnectRelay();
      disconnectRelay = null;
      throw new Error("relay handler is closed");
    }
    activeStreams.add(closeStream);

    // GET リクエスト完了時ではなく、レスポンス切断・エラー時に購読を解除する。
    res.on("close", closeStream);
    res.on("error", closeStream);

    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(isSafeHeaderValue(env.requestId)
        ? { "X-Request-Id": env.requestId }
        : {}),
      ...(corsOrigin !== null
        ? {
            "Access-Control-Allow-Origin": corsOrigin,
            "Access-Control-Expose-Headers": "X-Request-Id",
          }
        : {}),
    };
    try {
      if (res.writeHead !== undefined) {
        res.writeHead(200, headers);
      } else {
        res.statusCode = 200;
        for (const [k, v] of Object.entries(headers)) {
          res.setHeader(k, v);
        }
      }
      // 接続確立をクライアント側へ即座に伝える。
      res.write(": connected\n\n");
    } catch (error) {
      closeStream();
      throw error;
    }
  };

  const handleRequest = async (
    req: IncomingRequest,
    res: ServerResponseLike,
  ): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    let requestId = headerValue(req.headers["x-request-id"]);

    if (closed) {
      writeJson(
        res,
        503,
        {
          code: "SERVER_CLOSED",
          message: "server is shutting down",
          requestId: isSafeHeaderValue(requestId) ? requestId : "",
        },
        requestId,
        corsOrigin,
      );
      return;
    }

    if (method === "OPTIONS") {
      writeEmpty(res, 204, requestId, corsOrigin);
      return;
    }

    try {
      const { pathname, query } = parseRequestUrl(req.url ?? "/");
      const match = ROOM_ROUTE_RE.exec(pathname);
      if (match === null) {
        writeJson(
          res,
          404,
          {
            code: "NOT_FOUND",
            message: "route not found",
            requestId: isSafeHeaderValue(requestId) ? requestId : "",
          },
          requestId,
          corsOrigin,
        );
        return;
      }

      const rawRoomId = match[1] ?? "";
      const endpoint = match[2] ?? "";
      const roomId = decodePart(rawRoomId);

      if (endpoint === "notifications") {
        const sseEnv: Envelope = {
          schemaVersion: query.get("schemaVersion"),
          requestId: query.get("requestId"),
        };
        requestId = sseEnv.requestId;
        assertSafeRequestId(requestId);
        if (method !== "GET") {
          res.setHeader("Allow", "GET, OPTIONS");
          writeJson(
            res,
            405,
            {
              code: "METHOD_NOT_ALLOWED",
              message: "method not allowed",
              requestId: requestId ?? "",
            },
            requestId,
            corsOrigin,
          );
          return;
        }
        openSseStream(res, roomId, query.get("targetId") ?? "", sseEnv);
        scheduleLeaseExpiry();
        return;
      }

      const env = httpEnvelope(req);
      requestId = env.requestId;
      assertSafeRequestId(requestId);

      if (endpoint === "control") {
        if (method === "GET") {
          const snapshot = relay.getControl(
            roomId,
            { targetId: query.get("targetId") ?? "" },
            env,
          );
          scheduleLeaseExpiry();
          writeJson(res, 200, snapshot, requestId, corsOrigin);
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(req, maxBodyBytes);
          const result = relay.changeControl(
            roomId,
            {
              operatorId: body.operatorId as string,
              targetId: body.targetId as string,
              sendFilter: body.sendFilter,
            },
            env,
          );
          scheduleLeaseExpiry();
          writeJson(res, 200, result, requestId, corsOrigin);
          return;
        }
        res.setHeader("Allow", "GET, POST, OPTIONS");
        writeJson(
          res,
          405,
          {
            code: "METHOD_NOT_ALLOWED",
            message: "method not allowed",
            requestId: requestId ?? "",
          },
          requestId,
          corsOrigin,
        );
        return;
      }

      if (method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        writeJson(
          res,
          405,
          {
            code: "METHOD_NOT_ALLOWED",
            message: "method not allowed",
            requestId: requestId ?? "",
          },
          requestId,
          corsOrigin,
        );
        return;
      }

      const body = await readJsonBody(req, maxBodyBytes);
      switch (endpoint) {
        case "events": {
          const result = relay.pushEvents(
            roomId,
            {
              targetId: body.targetId as string,
              controlSeq: body.controlSeq as number,
              events: body.events,
            },
            env,
          );
          scheduleLeaseExpiry();
          writeJson(res, 200, result, requestId, corsOrigin);
          return;
        }
        case "presence": {
          relay.presence(
            roomId,
            { targetId: body.targetId as string },
            env,
          );
          scheduleLeaseExpiry();
          writeEmpty(res, 204, requestId, corsOrigin);
          return;
        }
        case "lease": {
          const result = relay.lease(
            roomId,
            {
              operatorId: body.operatorId as string,
              action: body.action as string,
            },
            env,
          );
          scheduleLeaseExpiry();
          writeJson(res, 200, result, requestId, corsOrigin);
          return;
        }
      }
    } catch (error) {
      const safeRequestId = isSafeHeaderValue(requestId) ? requestId : "";
      if (error instanceof RelayError) {
        scheduleLeaseExpiry();
        writeJson(
          res,
          error.httpStatus,
          {
            code: error.code,
            message: error.message,
            requestId: safeRequestId,
            ...(error.controlSeq !== undefined
              ? { controlSeq: error.controlSeq }
              : {}),
          },
          safeRequestId,
          corsOrigin,
        );
        return;
      }
      onInternalError(error);
      try {
        writeJson(
          res,
          500,
          {
            code: "INTERNAL_ERROR",
            message: "internal server error",
            requestId: safeRequestId,
          },
          safeRequestId,
          corsOrigin,
        );
      } catch (writeError) {
        onInternalError(writeError);
      }
    }
  };

  return {
    handler: (req, res) => {
      void handleRequest(req, res).catch((error) => {
        onInternalError(error);
      });
    },
    scheduleLeaseExpiry,
    close,
    activeStreamCount: () => activeStreams.size,
  };
}
