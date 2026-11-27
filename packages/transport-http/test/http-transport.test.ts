import { TransportError } from "@csu/core";
import type { ServerNotification, StoredEvent } from "@csu/core";
import { describe, expect, it } from "vitest";
import { HttpTransport } from "../src/index";
import type {
  EventSourceLike,
  FetchLike,
  MessageEventLike,
  RequestInitLike,
  ResponseLike,
} from "../src/web-types";

interface Call {
  url: string;
  init: RequestInitLike | undefined;
}

function response(status: number, body?: unknown, raw?: string): ResponseLike {
  const text = raw ?? (body === undefined ? "" : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

function makeFetch(
  handler: (call: Call) => ResponseLike | Promise<ResponseLike>,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEventLike) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

class FakeAbortController {
  static instances: FakeAbortController[] = [];
  readonly signal = {};
  aborted = false;
  constructor() {
    FakeAbortController.instances.push(this);
  }
  abort(): void {
    this.aborted = true;
  }
}

function makeTransport(fetch: FetchLike): HttpTransport {
  FakeEventSource.instances = [];
  FakeAbortController.instances = [];
  return new HttpTransport({
    baseUrl: "https://example.test/api/",
    schemaVersion: "1",
    fetch,
    EventSource: FakeEventSource,
    AbortController: FakeAbortController,
  });
}

async function catchError(promise: Promise<unknown>): Promise<TransportError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(TransportError);
    return e as TransportError;
  }
  throw new Error("expected rejection");
}

describe("HttpTransport.fetchControl (IF-001)", () => {
  it("GET と共通ヘッダーで送り、応答を返す", async () => {
    const snapshot = { controlSeq: 3, control: { lockHolder: null } };
    const { fetch, calls } = makeFetch(() => response(200, snapshot));
    const transport = makeTransport(fetch);

    const result = await transport.fetchControl({
      roomId: "r 1",
      targetId: "t/1",
      requestId: "req-1",
    });

    expect(result).toEqual(snapshot);
    expect(calls[0]?.url).toBe(
      "https://example.test/api/rooms/r%201/control?targetId=t%2F1",
    );
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.headers).toEqual({
      "X-Schema-Version": "1",
      "X-Request-Id": "req-1",
    });
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("本文が想定外なら INVALID_RESPONSE", async () => {
    const { fetch } = makeFetch(() => response(200, { foo: 1 }));
    const error = await catchError(
      makeTransport(fetch).fetchControl({
        roomId: "r",
        targetId: "t",
        requestId: "q",
      }),
    );
    expect(error.code).toBe("INVALID_RESPONSE");
  });
});

describe("HttpTransport.pushEvents (IF-002)", () => {
  const events = [
    { eventId: "e1", payload: { a: 1 }, extra: "ignored" },
    { eventId: "e2", payload: { b: 2 } },
  ] as unknown as StoredEvent[];

  it("eventId と payload だけを POST し、accepted を返す", async () => {
    const accepted = [
      { eventId: "e1", eventSeq: 1 },
      { eventId: "e2", eventSeq: 2 },
    ];
    const { fetch, calls } = makeFetch(() => response(200, { accepted }));

    const result = await makeTransport(fetch).pushEvents({
      roomId: "r",
      targetId: "t",
      controlSeq: 5,
      events,
      requestId: "q",
    });

    expect(result).toEqual(accepted);
    expect(calls[0]?.url).toBe("https://example.test/api/rooms/r/events");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.init?.body ?? "")).toEqual({
      targetId: "t",
      controlSeq: 5,
      events: [
        { eventId: "e1", payload: { a: 1 } },
        { eventId: "e2", payload: { b: 2 } },
      ],
    });
  });

  it("409 の共通エラーを code と controlSeq 付きで投げる", async () => {
    const { fetch } = makeFetch(() =>
      response(409, {
        code: "STALE_CONTROL_SEQ",
        message: "stale",
        requestId: "q",
        controlSeq: 9,
      }),
    );
    const error = await catchError(
      makeTransport(fetch).pushEvents({
        roomId: "r",
        targetId: "t",
        controlSeq: 5,
        events,
        requestId: "q",
      }),
    );
    expect(error.code).toBe("STALE_CONTROL_SEQ");
    expect(error.controlSeq).toBe(9);
    expect(error.message).toBe("stale");
  });

  it("accepted が無い応答は INVALID_RESPONSE", async () => {
    const { fetch } = makeFetch(() => response(200, {}));
    const error = await catchError(
      makeTransport(fetch).pushEvents({
        roomId: "r",
        targetId: "t",
        controlSeq: 1,
        events,
        requestId: "q",
      }),
    );
    expect(error.code).toBe("INVALID_RESPONSE");
  });
});

describe("HttpTransport.sendPresence (IF-004)", () => {
  it("204 を成功として扱う", async () => {
    const { fetch, calls } = makeFetch(() => response(204));
    await makeTransport(fetch).sendPresence({
      roomId: "r",
      targetId: "t",
      requestId: "q",
    });
    expect(calls[0]?.url).toBe("https://example.test/api/rooms/r/presence");
    expect(JSON.parse(calls[0]?.init?.body ?? "")).toEqual({ targetId: "t" });
  });
});

describe("エラーの分類", () => {
  const args = { roomId: "r", targetId: "t", requestId: "q" };

  it("5xx は code なし（再試行できる失敗）", async () => {
    const { fetch } = makeFetch(() => response(503, undefined, "oops"));
    const error = await catchError(makeTransport(fetch).sendPresence(args));
    expect(error.code).toBeUndefined();
  });

  it("通信の失敗は code なし", async () => {
    const { fetch } = makeFetch(() => {
      throw new Error("network down");
    });
    const error = await catchError(makeTransport(fetch).sendPresence(args));
    expect(error.code).toBeUndefined();
    expect(error.message).toBe("network down");
  });

  it("JSON でない 4xx は HTTP_<status>", async () => {
    const { fetch } = makeFetch(() => response(404, undefined, "<html>"));
    const error = await catchError(makeTransport(fetch).sendPresence(args));
    expect(error.code).toBe("HTTP_404");
  });

  it("タイムアウト用の AbortController を使い、完了後にタイマーを解除する", async () => {
    const { fetch, calls } = makeFetch(() => response(204));
    await makeTransport(fetch).sendPresence(args);
    expect(FakeAbortController.instances).toHaveLength(1);
    expect(FakeAbortController.instances[0]?.aborted).toBe(false);
    expect(calls[0]?.init?.signal).toBe(FakeAbortController.instances[0]?.signal);
  });
});

describe("HttpTransport.connect (IF-003 SSE)", () => {
  function setup() {
    const { fetch } = makeFetch(() => response(204));
    const transport = makeTransport(fetch);
    const opened: number[] = [];
    const notifications: ServerNotification[] = [];
    const errors: { closed: boolean }[] = [];
    const connection = transport.connect(
      { roomId: "r", targetId: "t", requestId: "q" },
      {
        onOpen: () => opened.push(1),
        onNotification: (n) => notifications.push(n),
        onError: (e) => errors.push(e),
      },
    );
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("no EventSource");
    return { source, connection, opened, notifications, errors };
  }

  it("共通項目をクエリパラメータで送る", () => {
    const { source } = setup();
    expect(source.url).toBe(
      "https://example.test/api/rooms/r/notifications?targetId=t&schemaVersion=1&requestId=q",
    );
  });

  it("onopen と通知を中継し、不正な通知は無視する", () => {
    const { source, opened, notifications } = setup();
    source.onopen?.();
    source.onmessage?.({
      data: JSON.stringify({ type: "EVENTS_APPENDED", controlSeq: 2, eventSeq: 7 }),
    });
    source.onmessage?.({
      data: JSON.stringify({ type: "CONTROL_UPDATED", controlSeq: 3 }),
    });
    source.onmessage?.({ data: "not json" });
    source.onmessage?.({ data: JSON.stringify({ type: "OTHER", controlSeq: 1 }) });

    expect(opened).toHaveLength(1);
    expect(notifications).toEqual([
      { type: "EVENTS_APPENDED", controlSeq: 2, eventSeq: 7 },
      { type: "CONTROL_UPDATED", controlSeq: 3 },
    ]);
  });

  it("onerror は readyState から closed を判定する", () => {
    const { source, errors } = setup();
    source.readyState = 0;
    source.onerror?.();
    source.readyState = 2;
    source.onerror?.();
    expect(errors).toEqual([{ closed: false }, { closed: true }]);
  });

  it("close は EventSource を閉じる", () => {
    const { source, connection } = setup();
    connection.close();
    expect(source.closed).toBe(true);
  });
});
