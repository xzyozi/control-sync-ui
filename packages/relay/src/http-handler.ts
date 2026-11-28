import { RelayError } from "./errors";
import type { IncomingRequest, ServerResponseLike } from "./node-types";
import type { RelayCore } from "./relay-core";
import type { Envelope, Notification } from "./types";
import { isRecord } from "./validation";

declare const console: { error: (...data: unknown[]) => void };
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const ROOM_ROUTE_RE =
  /^\/rooms\/([^/]+)\/(control|events|notifications|presence|lease)$/;

export interface RelayHttpOptions {
  /** 現在時刻（ミリ秒）の供給元。lease 期限タイマーの計算に使う。 */
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

function httpEnvelope(req: IncomingRequest): Envelope {
  return {
    schemaVersion: headerValue(req.headers["x-schema-version"]),
    requestId: headerValue(req.headers["x-request-id"]),
  };
}

function chunkSizeAndText(chunk: unknown): { bytes: number; text: string } {
  if (typeof chunk === "string") {
    return { bytes: chunk.length, text: chunk };
  }
  if (
    typeof chunk === "object" &&
    chunk !== null &&
    "byteLength" in chunk &&
    typeof (chunk as { byteLength: unknown }).byteLength === "number"
  ) {
    const buf = chunk as {
      readonly byteLength: number;
      toString(encoding?: string): string;
    };
    return { bytes: buf.byteLength, text: buf.toString("utf8") };
  }
  throw new RelayError("INVALID_MESSAGE", "unsupported request body chunk");
}

function readJsonBody(
  req: IncomingRequest,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener?.("data", onData);
      req.removeListener?.("end", onEnd);
      req.removeListener?.("error", onError);
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
        const { bytes, text } = chunkSizeAndText(chunk);
        totalBytes += bytes;
        if (totalBytes > maxBodyBytes) {
          // ソケットを即座に破棄すると 400 応答前に切断されるため、破棄せず読み捨ててエラー応答を返す。
          req.resume?.();
          fail(new RelayError("INVALID_MESSAGE", "request body too large"));
          return;
        }
        chunks.push(text);
      } catch (error) {
        fail(error);
      }
    };

    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
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

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
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
  if (requestId !== undefined && requestId.length > 0) {
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
  if (requestId !== undefined && requestId.length > 0) {
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
    req: IncomingRequest,
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
        res.end();
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
    activeStreams.add(closeStream);

    // GET リクエスト完了時ではなく、レスポンス切断時に購読を解除する。
    res.on("close", closeStream);

    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(env.requestId ? { "X-Request-Id": env.requestId } : {}),
      ...(corsOrigin !== null
        ? {
            "Access-Control-Allow-Origin": corsOrigin,
            "Access-Control-Expose-Headers": "X-Request-Id",
          }
        : {}),
    };
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
  };

  const handleRequest = async (
    req: IncomingRequest,
    res: ServerResponseLike,
  ): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    let requestId = headerValue(req.headers["x-request-id"]);

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
            requestId: requestId ?? "",
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
        openSseStream(
          req,
          res,
          roomId,
          query.get("targetId") ?? "",
          sseEnv,
        );
        scheduleLeaseExpiry();
        return;
      }

      const env = httpEnvelope(req);
      requestId = env.requestId;

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
      if (error instanceof RelayError) {
        scheduleLeaseExpiry();
        writeJson(
          res,
          error.httpStatus,
          {
            code: error.code,
            message: error.message,
            requestId: requestId ?? "",
            ...(error.controlSeq !== undefined
              ? { controlSeq: error.controlSeq }
              : {}),
          },
          requestId,
          corsOrigin,
        );
        return;
      }
      onInternalError(error);
      writeJson(
        res,
        500,
        {
          code: "INTERNAL_ERROR",
          message: "internal server error",
          requestId: requestId ?? "",
        },
        requestId,
        corsOrigin,
      );
    }
  };

  return {
    handler: (req, res) => {
      void handleRequest(req, res);
    },
    scheduleLeaseExpiry,
    close,
    activeStreamCount: () => activeStreams.size,
  };
}
