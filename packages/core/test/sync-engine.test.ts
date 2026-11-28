import { describe, expect, it, vi } from "vitest";
import { TransportError } from "../src/index";
import {
  addPending,
  createEngine,
  flush,
  openConnection,
} from "./sync-helpers";

const ALL_CONTROL = {
  controlSeq: 1,
  control: { sendFilter: { mode: "ALL" as const }, holderId: null },
};
const stale = (latest: number) =>
  new TransportError("stale", "STALE_CONTROL_SEQ", latest);
const network = () => new TransportError("network");

describe("SyncEngine: Control-First Sync", () => {
  it("TC-105: 接続が開くたびに IF-001 が完了してから IF-002 が実行される（初回と自動再接続）", async () => {
    const f = createEngine();
    f.transport.snapshot = ALL_CONTROL;
    await addPending(f.storage, "e1");

    await openConnection(f);
    expect(f.transport.calls.filter((c) => c !== "presence")).toEqual([
      "connect",
      "fetch",
      "push",
    ]);
    expect(f.transport.pushed).toEqual([{ controlSeq: 1, eventIds: ["e1"] }]);
    expect(f.engine.state).toBe("Ready");

    // 自動再接続（open が再び発生）。未送信のイベントを追加して、もう一度確かめる。
    await addPending(f.storage, "e2");
    f.transport.handlers?.onOpen();
    await flush();
    const calls = f.transport.calls.filter((c) => c !== "presence");
    expect(calls.slice(-2)).toEqual(["fetch", "push"]);
    expect(f.transport.pushed.at(-1)?.eventIds).toEqual(["e2"]);
  });

  it("送信対象が0件の場合は、IF-002 を呼ばず、Ready になる", async () => {
    const f = createEngine();
    await addPending(f.storage, "e1");
    // sendFilter は NONE（初期）のまま。
    await openConnection(f);

    expect(f.transport.calls).not.toContain("push");
    expect(f.engine.state).toBe("Ready");
    // イベントは、未送信のまま残る。
    expect(await f.storage.readPending("room-a")).toHaveLength(1);
  });

  it("送信が受理されると、イベントは送信済み（SENT）になる", async () => {
    const f = createEngine();
    f.transport.snapshot = ALL_CONTROL;
    await addPending(f.storage, "e1");
    await openConnection(f);

    expect(await f.storage.readPending("room-a")).toHaveLength(0);
  });

  it("TC-109: 接続中は presence heartbeat を5秒間隔で送り、disconnect で止まる", async () => {
    const f = createEngine();
    await openConnection(f);
    const count = () => f.transport.calls.filter((c) => c === "presence").length;

    // open 直後に1回。
    expect(count()).toBe(1);
    f.scheduler.advance(5_000);
    expect(count()).toBe(2);
    f.scheduler.advance(10_000);
    expect(count()).toBe(4);

    f.engine.disconnect();
    f.scheduler.advance(30_000);
    expect(count()).toBe(4);
    expect(f.engine.state).toBe("Disconnected");
    expect(f.transport.closedConnections).toBe(1);
  });

  it("TC-119: CONTROL_UPDATED を受けると、IF-001 で取得し直し、新しいフィルタで再評価される", async () => {
    const f = createEngine();
    await addPending(f.storage, "e1");
    await openConnection(f); // sendFilter NONE: 送られない。
    expect(f.transport.pushed).toHaveLength(0);

    // サーバーで、フィルタが ALL に変わり、通知が届く。
    f.transport.snapshot = ALL_CONTROL;
    f.transport.handlers?.onNotification({
      type: "CONTROL_UPDATED",
      controlSeq: 1,
    });
    await flush();

    expect(f.transport.pushed).toEqual([{ controlSeq: 1, eventIds: ["e1"] }]);
    expect(f.control.getControlSeq()).toBe(1);
  });

  it("EVENTS_APPENDED の通知では、何もしない", async () => {
    const f = createEngine();
    await openConnection(f);
    const before = f.transport.calls.length;
    f.transport.handlers?.onNotification({
      type: "EVENTS_APPENDED",
      controlSeq: 0,
      eventSeq: 1,
    });
    await flush();
    expect(f.transport.calls.length).toBe(before);
  });
});

describe("SyncEngine: STALE_CONTROL_SEQ", () => {
  it("TC-106: 拒否されたイベントは破棄されず、IF-001 で取得し直した後に新しいフィルタで再評価される", async () => {
    const f = createEngine();
    await addPending(f.storage, "e1", "temperature");
    // 初回は ALL(seq=1) で送信するが STALE_CONTROL_SEQ(2) で拒否され、
    // 再取得した TYPES(humidity, seq=2) には合わないため送信されない。
    f.transport.fetchSnapshots = [
      ALL_CONTROL,
      {
        controlSeq: 2,
        control: { sendFilter: { mode: "TYPES", types: ["humidity"] }, holderId: null },
      },
    ];
    f.transport.pushErrors = [stale(2)];

    await openConnection(f);

    const calls = f.transport.calls.filter((c) => c !== "presence" && c !== "connect");
    expect(calls).toEqual(["fetch", "push", "fetch"]);
    expect(f.transport.pushed).toEqual([]);
    expect(f.control.getControlSeq()).toBe(2);
    // イベントは破棄されず、未送信のまま残る。
    expect(await f.storage.readPending("room-a")).toHaveLength(1);

    // その後、対象を含むフィルタ（TYPES: temperature, seq=3）に変わると送信される。
    f.transport.snapshot = {
      controlSeq: 3,
      control: { sendFilter: { mode: "TYPES", types: ["temperature"] }, holderId: null },
    };
    f.transport.handlers?.onNotification({
      type: "CONTROL_UPDATED",
      controlSeq: 3,
    });
    await flush();

    expect(f.transport.pushed).toEqual([{ controlSeq: 3, eventIds: ["e1"] }]);
    expect(await f.storage.readPending("room-a")).toHaveLength(0);
  });

  it("TC-120: 連続は上限（3回）まで再評価され、受理されると連続回数と失敗の回数が0に戻る", async () => {
    const f = createEngine();
    f.transport.snapshot = ALL_CONTROL;
    await addPending(f.storage, "e1");
    // 3回続けて拒否され、4回目で受理される。
    f.transport.pushErrors = [stale(1), stale(1), stale(1)];

    await openConnection(f);

    expect(f.transport.calls.filter((c) => c === "push")).toHaveLength(4);
    expect(f.engine.state).toBe("Ready");
    expect(f.transport.connections).toBe(1);
  });

  it("TC-120: 連続が上限（3回）を超えると通信エラー1回として数え、再試行の上限（V-06）で Stopped になる", async () => {
    const f = createEngine();
    f.transport.snapshot = ALL_CONTROL;
    await addPending(f.storage, "e1");
    // 初回接続で V-11（3回）を超える 4 回目で Retrying（失敗1回目）へ移る。
    // その後も STALE_CONTROL_SEQ が続くと、V-06（3回の再試行）の上限で Stopped になる。
    f.transport.pushErrors = [
      stale(1),
      stale(1),
      stale(1),
      stale(1),
      stale(1),
      stale(1),
      stale(1),
    ];

    await openConnection(f);
    expect(f.engine.state).toBe("Retrying");
    expect(f.transport.closedConnections).toBe(1);

    // 1回目（1秒後）
    f.scheduler.advance(1_000);
    expect(f.transport.connections).toBe(2);
    f.transport.handlers?.onOpen();
    await flush();
    expect(f.engine.state).toBe("Retrying");

    // 2回目（2秒後）
    f.scheduler.advance(2_000);
    expect(f.transport.connections).toBe(3);
    f.transport.handlers?.onOpen();
    await flush();
    expect(f.engine.state).toBe("Retrying");

    // 3回目（4秒後）→ 上限超過で Stopped
    f.scheduler.advance(4_000);
    expect(f.transport.connections).toBe(4);
    f.transport.handlers?.onOpen();
    await flush();
    expect(f.engine.state).toBe("Stopped");
    expect(f.stops).toEqual([{ reason: "RETRY_LIMIT", error: undefined }]);
  });
});

describe("SyncEngine: 再試行と停止", () => {
  it("TC-107: 通信エラーは、同じ手順で、1、2、4秒の待ち時間で再試行され、上限（3回）を超えると Stopped になる", async () => {
    const f = createEngine();
    f.transport.fetchErrors = [network(), network(), network(), network()];

    await openConnection(f);
    expect(f.engine.state).toBe("Retrying");

    // 1回目の再試行は 1 秒後。
    f.scheduler.advance(999);
    expect(f.transport.connections).toBe(1);
    f.scheduler.advance(1);
    expect(f.transport.connections).toBe(2);
    f.transport.handlers?.onOpen();
    await flush();

    // 2回目は 2 秒後。
    f.scheduler.advance(2_000);
    expect(f.transport.connections).toBe(3);
    f.transport.handlers?.onOpen();
    await flush();

    // 3回目は 4 秒後。
    f.scheduler.advance(4_000);
    expect(f.transport.connections).toBe(4);
    f.transport.handlers?.onOpen();
    await flush();

    // 上限（3回の再試行）を超えたので、Stopped。保存済みのイベントは保持される。
    expect(f.engine.state).toBe("Stopped");
    expect(f.stops).toEqual([{ reason: "RETRY_LIMIT", error: undefined }]);
  });

  it("再試行の待ち時間には、±20% の揺らぎが入る", async () => {
    // random=0 → 0.8 倍、random→1 に近い → 1.2 倍。
    const low = createEngine({ random: () => 0 });
    low.transport.fetchErrors = [network()];
    await openConnection(low);
    low.scheduler.advance(799);
    expect(low.transport.connections).toBe(1);
    low.scheduler.advance(1);
    expect(low.transport.connections).toBe(2);

    const high = createEngine({ random: () => 0.999 });
    high.transport.fetchErrors = [network()];
    await openConnection(high);
    high.scheduler.advance(1_199);
    expect(high.transport.connections).toBe(1);
    high.scheduler.advance(1);
    expect(high.transport.connections).toBe(2);

    // random を省略した既定値では Math.random が使われる（揺らぎが 0 固定でない）。
    const spy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const def = createEngine({ random: undefined });
      def.transport.fetchErrors = [network()];
      await openConnection(def);
      def.scheduler.advance(799);
      expect(def.transport.connections).toBe(1);
      def.scheduler.advance(1);
      expect(def.transport.connections).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("TC-107: 通信エラーの後は、同じ手順をやり直しつつ失敗したリクエストと同じ requestId で再試行する", async () => {
    const f = createEngine();
    f.transport.snapshot = ALL_CONTROL;
    await addPending(f.storage, "e1");
    f.transport.fetchErrors = [network()];
    await openConnection(f);
    f.scheduler.advance(1_000);
    f.transport.handlers?.onOpen();
    await flush();

    const fetchIds = f.transport.callLogs
      .filter((c) => c.op === "fetch")
      .map((c) => c.requestId);
    expect(fetchIds).toHaveLength(2);
    expect(fetchIds[0]).toBe(fetchIds[1]);

    // pushEvents の通信エラーも、同じ requestId で再試行される。
    await addPending(f.storage, "e2");
    f.transport.pushErrors = [network()];
    f.engine.notifyLocalEvents();
    await flush();
    expect(f.engine.state).toBe("Retrying");

    f.scheduler.advance(1_000);
    f.transport.handlers?.onOpen();
    await flush();

    const pushIds = f.transport.callLogs
      .filter((c) => c.op === "push")
      .map((c) => c.requestId);
    expect(pushIds).toHaveLength(3);
    expect(pushIds[1]).toBe(pushIds[2]);
  });

  it("TC-108: SCHEMA_VERSION_MISMATCH を受けると、再試行せずに Stopped になり、永続状態は変化しない", async () => {
    const f = createEngine();
    await addPending(f.storage, "e1");
    f.transport.fetchErrors = [
      new TransportError("mismatch", "SCHEMA_VERSION_MISMATCH"),
    ];
    await openConnection(f);

    expect(f.engine.state).toBe("Stopped");
    expect(f.stops).toEqual([
      { reason: "SCHEMA_VERSION_MISMATCH", error: undefined },
    ]);
    // 永続状態・制御状態は変化しない。
    expect(await f.storage.readPending("room-a")).toHaveLength(1);
    expect(f.control.getControlSeq()).toBe(0);
    // 再試行のタイマーも、残らない。
    f.scheduler.advance(60_000);
    expect(f.transport.connections).toBe(1);
  });

  it("presence の SCHEMA_VERSION_MISMATCH でも Stopped になる。その他の presence の失敗では止まらない", async () => {
    const mismatch = createEngine();
    mismatch.transport.presenceError = new TransportError(
      "mismatch",
      "SCHEMA_VERSION_MISMATCH",
    );
    await openConnection(mismatch);
    expect(mismatch.engine.state).toBe("Stopped");

    const flaky = createEngine();
    flaky.transport.presenceError = network();
    await openConnection(flaky);
    flaky.scheduler.advance(10_000);
    await flush();
    expect(flaky.engine.state).toBe("Ready");
  });

  it("再試行しても同じ結果になるエラー（INVALID_MESSAGE、ROOM_NOT_FOUND）は、再試行せずに Stopped になる", async () => {
    for (const code of ["INVALID_MESSAGE", "ROOM_NOT_FOUND"]) {
      const f = createEngine();
      f.transport.fetchErrors = [new TransportError("bad", code)];
      await openConnection(f);
      expect(f.engine.state).toBe("Stopped");
      expect(f.stops[0]?.reason).toBe("INVALID_REQUEST");
    }
  });

  it("想定外のエラー（ストレージの失敗など）は、未処理の拒否にならず、Stopped（UNEXPECTED）になる", async () => {
    const f = createEngine();
    f.transport.snapshot = ALL_CONTROL;
    await addPending(f.storage, "e1");
    f.storage.readPending = async () => {
      throw new Error("storage broken");
    };
    await openConnection(f);

    expect(f.engine.state).toBe("Stopped");
    expect(f.stops[0]?.reason).toBe("UNEXPECTED");
    expect((f.stops[0]?.error as Error).message).toBe("storage broken");
  });

  it("成功すると、失敗の回数が0に戻る（途中の失敗が、累積しない）", async () => {
    const f = createEngine();
    f.transport.snapshot = ALL_CONTROL;
    await addPending(f.storage, "e1");
    f.transport.fetchErrors = [network(), network()];

    await openConnection(f);
    f.scheduler.advance(1_000);
    f.transport.handlers?.onOpen();
    await flush();
    f.scheduler.advance(2_000);
    f.transport.handlers?.onOpen();
    await flush();
    expect(f.engine.state).toBe("Ready");

    // 成功した後に、また失敗が続いても、1 秒から再開する（カウンタが戻っている）。
    await addPending(f.storage, "e2");
    f.transport.fetchErrors = [network()];
    f.transport.handlers?.onOpen();
    await flush();
    expect(f.engine.state).toBe("Retrying");
    f.scheduler.advance(1_000);
    expect(f.transport.connections).toBe(4);
  });
});

describe("SyncEngine: 切断と接続の状態", () => {
  it("disconnect で、進行中の再試行がキャンセルされる", async () => {
    const f = createEngine();
    f.transport.fetchErrors = [network()];
    await openConnection(f);
    expect(f.engine.state).toBe("Retrying");

    f.engine.disconnect();
    f.scheduler.advance(10_000);
    expect(f.engine.state).toBe("Disconnected");
    expect(f.transport.connections).toBe(1);
  });

  it("切断した後に、古い接続からの通知は、無視される", async () => {
    const f = createEngine();
    await openConnection(f);
    const oldHandlers = f.transport.handlers;
    f.engine.disconnect();

    const before = f.transport.calls.length;
    oldHandlers?.onNotification({ type: "CONTROL_UPDATED", controlSeq: 5 });
    oldHandlers?.onOpen();
    await flush();
    expect(f.transport.calls.length).toBe(before);
    expect(f.engine.state).toBe("Disconnected");
  });

  it("接続が CLOSED（再接続されない）の場合は、IF-001 を実行して原因を判別する", async () => {
    const f = createEngine();
    await openConnection(f);
    const before = f.transport.calls.filter((c) => c === "fetch").length;

    // サーバーが、Room を失った（ROOM_NOT_FOUND）。IF-001 で、原因が分かる。
    f.transport.fetchErrors = [new TransportError("gone", "ROOM_NOT_FOUND")];
    f.transport.handlers?.onError({ closed: true });
    await flush();

    expect(f.transport.calls.filter((c) => c === "fetch").length).toBe(
      before + 1,
    );
    expect(f.engine.state).toBe("Stopped");
    expect(f.stops[0]?.reason).toBe("INVALID_REQUEST");
  });

  it("接続が CLOSED でも IF-001 が成功すれば、Retrying へ移って SSE を張り直す", async () => {
    const f = createEngine();
    await openConnection(f);

    f.transport.handlers?.onError({ closed: true });
    await flush();

    expect(f.engine.state).toBe("Retrying");
    f.scheduler.advance(1_000);
    expect(f.transport.connections).toBe(2);
    f.transport.handlers?.onOpen();
    await flush();
    expect(f.engine.state).toBe("Ready");
  });

  it("通知エラーで SCHEMA_VERSION_MISMATCH を受けたら、IF-001 を呼ばずに Stopped になる", async () => {
    const f = createEngine();
    await openConnection(f);
    const before = f.transport.calls.filter((c) => c === "fetch").length;

    f.transport.handlers?.onError({
      closed: true,
      code: "SCHEMA_VERSION_MISMATCH",
    });
    await flush();

    expect(f.transport.calls.filter((c) => c === "fetch").length).toBe(before);
    expect(f.engine.state).toBe("Stopped");
    expect(f.stops).toEqual([
      { reason: "SCHEMA_VERSION_MISMATCH", error: undefined },
    ]);
  });

  it("Pulling 中の CONTROL_UPDATED など未定義イベントは無視して記録する", async () => {
    const f = createEngine();
    f.engine.connect();
    f.transport.handlers?.onOpen();
    // まだ fetchControl が解決していない Pulling 状態。
    expect(f.engine.state).toBe("Pulling");
    f.transport.handlers?.onNotification({
      type: "CONTROL_UPDATED",
      controlSeq: 9,
    });
    await flush();

    expect(f.ignored).toEqual([{ state: "Pulling", event: "CONTROL_UPDATED" }]);
  });

  it("onStateChange が例外を投げても未処理の拒否にならず、同期処理を継続できる", async () => {
    const callbackErrors: unknown[] = [];
    const f = createEngine({
      onStateChange: (state) => {
        if (state === "Ready") {
          throw new Error("ui error");
        }
      },
      onCallbackError: (err) => callbackErrors.push(err),
    });
    await openConnection(f);

    expect(f.engine.state).toBe("Ready");
    expect(callbackErrors).toHaveLength(1);
    expect((callbackErrors[0] as Error).message).toBe("ui error");
  });

  it("接続の切断（自動再接続あり）では、再試行の待ち時間の後に、接続を張り直す", async () => {
    const f = createEngine();
    await openConnection(f);
    f.transport.handlers?.onError({ closed: false });
    expect(f.engine.state).toBe("Retrying");

    f.scheduler.advance(1_000);
    expect(f.transport.connections).toBe(2);
  });

  it("connect は、Disconnected のときだけ有効（二重に呼んでも、接続は1つ）", async () => {
    const f = createEngine();
    f.engine.connect();
    f.engine.connect();
    expect(f.transport.connections).toBe(1);
  });

  it("状態は、Disconnected、Connecting、Pulling、Ready の順に遷移する", async () => {
    const f = createEngine();
    await openConnection(f);
    expect(f.states).toEqual(["Connecting", "Pulling", "Ready"]);
  });

  it("notifyLocalEvents で、Ready のときに、新しいイベントを送る", async () => {
    const f = createEngine();
    f.transport.snapshot = ALL_CONTROL;
    await openConnection(f);
    await addPending(f.storage, "e1");

    f.engine.notifyLocalEvents();
    await flush();
    expect(f.transport.pushed).toEqual([{ controlSeq: 1, eventIds: ["e1"] }]);
  });
});
