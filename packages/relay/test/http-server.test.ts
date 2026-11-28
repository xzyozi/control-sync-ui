import { afterEach, describe, expect, it } from "vitest";
import {
  RelayCore,
  type IncomingRequest,
  type RelayOptions,
  type RelayServer,
  type RelayServerOptions,
  type ServerResponseLike,
  createRelayHandler,
  startRelayServer,
} from "../src/index";

// lib に DOM を含めず、@types/node にも依存しないため、Node 20+ のグローバルを最小限宣言する。
interface TestStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

interface TestResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: { getReader(): TestStreamReader } | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

interface TestAbortController {
  readonly signal: unknown;
  abort(): void;
}

declare function fetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: unknown;
  },
): Promise<TestResponse>;
declare const AbortController: new () => TestAbortController;
declare const TextDecoder: new () => { decode(input?: Uint8Array): string };
declare const TextEncoder: new () => { encode(input?: string): Uint8Array };
declare function setTimeout(callback: () => void, ms: number): unknown;

const servers: RelayServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await server.close();
    }
  }
});

async function startTestServer(
  options: RelayOptions = {},
  serverOptions: RelayServerOptions = {},
): Promise<{ relay: RelayCore; server: RelayServer }> {
  const relay = new RelayCore(options);
  relay.createRoom("room-a");
  const server = await startRelayServer(relay, serverOptions);
  servers.push(server);
  return { relay, server };
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  } = {},
): Promise<{ status: number; headers: TestResponse["headers"]; body: unknown }> {
  const headers: Record<string, string> = {
    "X-Schema-Version": "1",
    "X-Request-Id": "req-1",
    ...(init.headers ?? {}),
  };
  let body: string | undefined;
  if (init.rawBody !== undefined) {
    body = init.rawBody;
    headers["Content-Type"] = "application/json";
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text === "" ? undefined : (JSON.parse(text) as unknown),
  };
}

class SseReader {
  private readonly reader: TestStreamReader;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(res: TestResponse) {
    if (res.body === null) {
      throw new Error("expected response body stream");
    }
    this.reader = res.body.getReader();
  }

  async nextEvent(): Promise<unknown> {
    for (;;) {
      const sep = this.buffer.indexOf("\n\n");
      if (sep !== -1) {
        const frame = this.buffer.slice(0, sep);
        this.buffer = this.buffer.slice(sep + 2);
        const dataLines = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length > 0) {
          return JSON.parse(dataLines.join("\n")) as unknown;
        }
        continue;
      }
      const chunk = await this.reader.read();
      if (chunk.done) {
        throw new Error("SSE stream closed before next event");
      }
      this.buffer += this.decoder.decode(chunk.value);
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

async function openSse(
  baseUrl: string,
  roomId = "room-a",
  targetId = "t1",
): Promise<{ res: TestResponse; sse: SseReader; abort: () => void }> {
  const controller = new AbortController();
  const res = await fetch(
    `${baseUrl}/rooms/${encodeURIComponent(roomId)}/notifications?targetId=${encodeURIComponent(targetId)}&schemaVersion=1&requestId=sse-1`,
    { signal: controller.signal },
  );
  return {
    res,
    sse: new SseReader(res),
    abort: () => controller.abort(),
  };
}

const waitMs = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe("Relay HTTP / SSE サーバー（IF-001〜IF-006）", () => {
  it("IF-001〜IF-006 の一通りのフローと SSE 更新通知が動作する", async () => {
    const { relay, server } = await startTestServer();
    relay.createRoom("room 1");

    // IF-001: 初期制御状態の取得（X-Request-Id を応答に返す）。
    const initial = await jsonRequest(
      server.baseUrl,
      "/rooms/room%201/control?targetId=t1",
      { headers: { "X-Request-Id": "req-pull-1" } },
    );
    expect(initial.status).toBe(200);
    expect(initial.headers.get("X-Request-Id")).toBe("req-pull-1");
    expect(initial.body).toEqual({
      controlSeq: 0,
      control: { sendFilter: { mode: "NONE" }, holderId: null },
    });

    // IF-003: SSE 接続を開く。
    const { res: sseRes, sse, abort } = await openSse(server.baseUrl, "room-a", "t1");
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("Content-Type")).toContain("text/event-stream");
    expect(sseRes.headers.get("X-Request-Id")).toBe("sse-1");

    // IF-004: presence heartbeat（204 本文なし）。
    const presenceRes = await jsonRequest(
      server.baseUrl,
      "/rooms/room-a/presence",
      { method: "POST", body: { targetId: "t1" } },
    );
    expect(presenceRes.status).toBe(204);
    expect(presenceRes.body).toBeUndefined();

    // IF-005: lease 取得 → SSE に CONTROL_UPDATED が届く。
    const leaseRes = await jsonRequest(server.baseUrl, "/rooms/room-a/lease", {
      method: "POST",
      body: { operatorId: "op-1", action: "ACQUIRE" },
    });
    expect(leaseRes.status).toBe(200);
    expect(leaseRes.body).toEqual({ holderId: "op-1", controlSeq: 1 });
    expect(await sse.nextEvent()).toEqual({
      schemaVersion: "1",
      type: "CONTROL_UPDATED",
      controlSeq: 1,
    });

    // IF-006: 送信対象フィルタ変更（同じ X-Request-Id の再送は冪等）。
    const change1 = await jsonRequest(server.baseUrl, "/rooms/room-a/control", {
      method: "POST",
      headers: { "X-Request-Id": "ctrl-req-1" },
      body: {
        operatorId: "op-1",
        targetId: "t1",
        sendFilter: { mode: "ALL" },
      },
    });
    expect(change1.status).toBe(200);
    expect(change1.body).toEqual({ controlSeq: 2 });
    expect(await sse.nextEvent()).toEqual({
      schemaVersion: "1",
      type: "CONTROL_UPDATED",
      controlSeq: 2,
    });

    const changeDup = await jsonRequest(
      server.baseUrl,
      "/rooms/room-a/control",
      {
        method: "POST",
        headers: { "X-Request-Id": "ctrl-req-1" },
        body: {
          operatorId: "op-1",
          targetId: "t1",
          sendFilter: { mode: "NONE" },
        },
      },
    );
    expect(changeDup.status).toBe(200);
    expect(changeDup.body).toEqual({ controlSeq: 2 });

    // IF-002: イベント送信 → SSE に EVENTS_APPENDED、古い controlSeq は 409 STALE_CONTROL_SEQ。
    const pushRes = await jsonRequest(server.baseUrl, "/rooms/room-a/events", {
      method: "POST",
      body: {
        targetId: "t1",
        controlSeq: 2,
        events: [{ eventId: "e1", payload: { type: "temperature" } }],
      },
    });
    expect(pushRes.status).toBe(200);
    expect(pushRes.body).toEqual({
      accepted: [{ eventId: "e1", eventSeq: 1 }],
    });
    expect(await sse.nextEvent()).toEqual({
      schemaVersion: "1",
      type: "EVENTS_APPENDED",
      controlSeq: 2,
      eventSeq: 1,
    });

    const staleRes = await jsonRequest(
      server.baseUrl,
      "/rooms/room-a/events",
      {
        method: "POST",
        headers: { "X-Request-Id": "stale-req" },
        body: {
          targetId: "t1",
          controlSeq: 1,
          events: [{ eventId: "e2", payload: { type: "temperature" } }],
        },
      },
    );
    expect(staleRes.status).toBe(409);
    expect(staleRes.headers.get("X-Request-Id")).toBe("stale-req");
    expect(staleRes.body).toMatchObject({
      code: "STALE_CONTROL_SEQ",
      requestId: "stale-req",
      controlSeq: 2,
    });

    await sse.close();
    abort();
  });

  it("IF-003 接続失敗時は SSE を開始せず通常の HTTP エラー応答を返す", async () => {
    const { server } = await startTestServer();

    const mismatch = await fetch(
      `${server.baseUrl}/rooms/room-a/notifications?targetId=t1&schemaVersion=99&requestId=q1`,
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.headers.get("Content-Type")).toContain("application/json");
    expect(await mismatch.json()).toMatchObject({
      code: "SCHEMA_VERSION_MISMATCH",
      requestId: "q1",
    });

    const missingRoom = await fetch(
      `${server.baseUrl}/rooms/unknown/notifications?targetId=t1&schemaVersion=1&requestId=q2`,
    );
    expect(missingRoom.status).toBe(404);
    expect(await missingRoom.json()).toMatchObject({
      code: "ROOM_NOT_FOUND",
      requestId: "q2",
    });
  });

  it("SSE を切断すると即座にオフラインになり、IF-006 が TARGET_OFFLINE を返す", async () => {
    const { server } = await startTestServer();
    const { sse, abort } = await openSse(server.baseUrl);
    await jsonRequest(server.baseUrl, "/rooms/room-a/presence", {
      method: "POST",
      body: { targetId: "t1" },
    });
    await jsonRequest(server.baseUrl, "/rooms/room-a/lease", {
      method: "POST",
      body: { operatorId: "op-1", action: "ACQUIRE" },
    });
    await sse.nextEvent();

    await sse.close();
    abort();
    await waitMs(30);

    const res = await jsonRequest(server.baseUrl, "/rooms/room-a/control", {
      method: "POST",
      body: {
        operatorId: "op-1",
        targetId: "t1",
        sendFilter: { mode: "ALL" },
      },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "TARGET_OFFLINE" });
  });

  it("TC-005 / TC-112: lease の期限時刻にタイマーで解放され、SSE で通知される", async () => {
    const { server } = await startTestServer({ leaseTtlMs: 60 });
    const { sse, abort } = await openSse(server.baseUrl);

    await jsonRequest(server.baseUrl, "/rooms/room-a/lease", {
      method: "POST",
      body: { operatorId: "op-1", action: "ACQUIRE" },
    });
    expect(await sse.nextEvent()).toEqual({
      schemaVersion: "1",
      type: "CONTROL_UPDATED",
      controlSeq: 1,
    });

    // 追加の HTTP アクセスを行わずに待っても、期限切れの通知が届く。
    expect(await sse.nextEvent()).toEqual({
      schemaVersion: "1",
      type: "CONTROL_UPDATED",
      controlSeq: 2,
    });
    const snapshot = await jsonRequest(
      server.baseUrl,
      "/rooms/room-a/control?targetId=t1",
    );
    expect(snapshot.body).toMatchObject({
      controlSeq: 2,
      control: { holderId: null },
    });

    await sse.close();
    abort();
  });

  it("共通項目の欠落・不正 JSON・サイズ超過・ルート不一致・メソッド不一致・CORS を処理する", async () => {
    const { server } = await startTestServer({}, { maxBodyBytes: 64 });

    // CORS プリフライト
    const preflight = await fetch(`${server.baseUrl}/rooms/room-a/control`, {
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");

    // X-Request-Id 欠落
    const missingEnv = await fetch(
      `${server.baseUrl}/rooms/room-a/control?targetId=t1`,
      { headers: { "X-Schema-Version": "1" } },
    );
    expect(missingEnv.status).toBe(400);
    expect(await missingEnv.json()).toMatchObject({
      code: "INVALID_MESSAGE",
      requestId: "",
    });

    // 不正 JSON・非オブジェクト JSON・サイズ超過
    const badJson = await jsonRequest(server.baseUrl, "/rooms/room-a/lease", {
      method: "POST",
      rawBody: "{broken",
    });
    expect(badJson.status).toBe(400);
    expect(badJson.body).toMatchObject({ code: "INVALID_MESSAGE" });

    const nonObject = await jsonRequest(server.baseUrl, "/rooms/room-a/lease", {
      method: "POST",
      rawBody: "[1,2,3]",
    });
    expect(nonObject.status).toBe(400);
    expect(nonObject.body).toMatchObject({ code: "INVALID_MESSAGE" });

    const tooLarge = await jsonRequest(
      server.baseUrl,
      "/rooms/room-a/presence",
      {
        method: "POST",
        body: { targetId: "x".repeat(100) },
      },
    );
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body).toMatchObject({ code: "INVALID_MESSAGE" });

    // 未定義ルートと未対応メソッド
    const notFound = await jsonRequest(server.baseUrl, "/unknown");
    expect(notFound.status).toBe(404);
    expect(notFound.body).toMatchObject({ code: "NOT_FOUND" });

    const wrongMethod = await jsonRequest(
      server.baseUrl,
      "/rooms/room-a/lease",
      { method: "GET" },
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toContain("POST");
  });

  it("不正な requestId（改行・非ASCII）でもクラッシュせず 400 INVALID_MESSAGE を返す", async () => {
    const { server } = await startTestServer();

    const crlf = await fetch(
      `${server.baseUrl}/rooms/room-a/notifications?targetId=t1&schemaVersion=1&requestId=bad%0d%0aid`,
    );
    expect(crlf.status).toBe(400);
    expect(await crlf.json()).toMatchObject({
      code: "INVALID_MESSAGE",
      requestId: "",
    });

    const nonAscii = await fetch(
      `${server.baseUrl}/rooms/room-a/notifications?targetId=t1&schemaVersion=1&requestId=${encodeURIComponent("日本語")}`,
    );
    expect(nonAscii.status).toBe(400);
    expect(await nonAscii.json()).toMatchObject({
      code: "INVALID_MESSAGE",
      requestId: "",
    });
  });

  it("SSE 接続が開いたままでも server.close() がハングせず終了し、corsOrigin: null で CORS ヘッダーを省く", async () => {
    const { server } = await startTestServer({}, { corsOrigin: null });
    const { res, sse, abort } = await openSse(server.baseUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();

    // 開いたまま close() を呼んでも即座に解決する。
    await server.close();
    await sse.close().catch(() => undefined);
    abort();
  });

  it("チャンク境界で分断されたマルチバイト UTF-8 ボディ、途中切断、SSE 書き込み失敗を安全に処理する", async () => {
    const relay = new RelayCore();
    relay.createRoom("room-a");
    const controller = createRelayHandler(relay);

    function createMockReqRes(init: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      throwOnWriteHead?: boolean;
    }) {
      const reqListeners = new Map<string, ((...args: unknown[]) => void)[]>();
      const resListeners = new Map<string, ((...args: unknown[]) => void)[]>();
      const responseHeaders = new Map<string, string>();
      let endedBody = "";
      let ended = false;

      const req: IncomingRequest = {
        method: init.method,
        url: init.url,
        headers: init.headers ?? {},
        on: (event, listener) => {
          const list = reqListeners.get(event) ?? [];
          list.push(listener);
          reqListeners.set(event, list);
          return req;
        },
        removeListener: (event, listener) => {
          const list = reqListeners.get(event);
          if (list !== undefined) {
            reqListeners.set(
              event,
              list.filter((l) => l !== listener),
            );
          }
          return req;
        },
      };

      const res: ServerResponseLike = {
        statusCode: 200,
        get writableEnded() {
          return ended;
        },
        setHeader: (name, value) => {
          responseHeaders.set(name.toLowerCase(), value);
        },
        writeHead: (status, headers) => {
          if (init.throwOnWriteHead) {
            throw new Error("writeHead failed");
          }
          res.statusCode = status;
          if (headers !== undefined) {
            for (const [k, v] of Object.entries(headers)) {
              responseHeaders.set(k.toLowerCase(), v);
            }
          }
        },
        write: () => true,
        end: (chunk) => {
          if (chunk !== undefined) {
            endedBody += chunk;
          }
          ended = true;
        },
        on: (event, listener) => {
          const list = resListeners.get(event) ?? [];
          list.push(listener);
          resListeners.set(event, list);
          return res;
        },
      };

      const emitReq = (event: string, ...args: unknown[]) => {
        for (const fn of [...(reqListeners.get(event) ?? [])]) {
          fn(...args);
        }
      };
      return {
        req,
        res,
        emitReq,
        getStatus: () => res.statusCode,
        getHeader: (name: string) => responseHeaders.get(name.toLowerCase()),
        getEndedBody: () => endedBody,
      };
    }

    // 1. マルチバイト UTF-8 文字（日本語・絵文字）をバイト途中で2分割した Uint8Array チャンクで送信
    const utf8 = createMockReqRes({
      method: "POST",
      url: "/rooms/room-a/events",
      headers: {
        "x-schema-version": "1",
        "x-request-id": "utf8-1",
      },
    });
    controller.handler(utf8.req, utf8.res);
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        targetId: "t1",
        controlSeq: 0,
        events: [{ eventId: "e-jp", payload: { type: "日本語テスト🔥" } }],
      }),
    );
    const splitAt = bytes.indexOf(0xf0) + 2; // 4バイト絵文字の途中で分割
    utf8.emitReq("data", bytes.subarray(0, splitAt));
    utf8.emitReq("data", bytes.subarray(splitAt));
    utf8.emitReq("end");
    await waitMs(10);
    expect(utf8.getStatus()).toBe(200);
    expect(utf8.getHeader("x-request-id")).toBe("utf8-1");
    expect(JSON.parse(utf8.getEndedBody())).toEqual({
      accepted: [{ eventId: "e-jp", eventSeq: 1 }],
    });

    // 2. POST ボディ途中でクライアントが切断（close）してもハングせず 400 で終了する
    const aborted = createMockReqRes({
      method: "POST",
      url: "/rooms/room-a/presence",
      headers: {
        "x-schema-version": "1",
        "x-request-id": "abort-1",
      },
    });
    controller.handler(aborted.req, aborted.res);
    aborted.emitReq("data", new TextEncoder().encode('{"targetId":'));
    aborted.emitReq("close");
    await waitMs(10);
    expect(aborted.getStatus()).toBe(400);
    expect(JSON.parse(aborted.getEndedBody())).toMatchObject({
      code: "INVALID_MESSAGE",
      requestId: "abort-1",
    });

    // 3. SSE writeHead 失敗時に activeStreams がリークしない
    const internalErrors: unknown[] = [];
    const sseController = createRelayHandler(relay, {
      onInternalError: (e) => internalErrors.push(e),
    });
    const failedSse = createMockReqRes({
      method: "GET",
      url: "/rooms/room-a/notifications?targetId=t1&schemaVersion=1&requestId=sse-fail",
      throwOnWriteHead: true,
    });
    sseController.handler(failedSse.req, failedSse.res);
    await waitMs(10);
    expect(sseController.activeStreamCount()).toBe(0);
    expect(internalErrors).toHaveLength(1);

    controller.close();
    sseController.close();
  });
});
