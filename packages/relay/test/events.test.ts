import { describe, expect, it } from "vitest";
import {
  ALL_FILTER,
  createFixture,
  env,
  errorCodeOf,
  errorOf,
  goOnline,
} from "./helpers";

const event = (eventId: string) => ({ eventId, payload: { type: "temperature" } });

describe("IF-002 イベントの送信", () => {
  it("TC-012 / TC-110: eventSeq は、同じ Room の中で、一意に増加する", () => {
    const { relay } = createFixture();
    const first = relay.pushEvents(
      "room-a",
      { targetId: "t1", controlSeq: 0, events: [event("e1"), event("e2")] },
      env(),
    );
    const second = relay.pushEvents(
      "room-a",
      { targetId: "t1", controlSeq: 0, events: [event("e3")] },
      env(),
    );

    expect(first.accepted).toEqual([
      { eventId: "e1", eventSeq: 1 },
      { eventId: "e2", eventSeq: 2 },
    ]);
    expect(second.accepted).toEqual([{ eventId: "e3", eventSeq: 3 }]);
  });

  it("TC-004 / TC-110: 同じ eventId の再送は、二重に追加されず、最初の eventSeq を返す", () => {
    const { relay } = createFixture();
    const request = { targetId: "t1", controlSeq: 0, events: [event("e1")] };

    const first = relay.pushEvents("room-a", request, env());
    const again = relay.pushEvents("room-a", request, env());
    expect(again).toEqual(first);

    // 二重に追加されていないので、次の新しいイベントは eventSeq 2。
    const next = relay.pushEvents(
      "room-a",
      { targetId: "t1", controlSeq: 0, events: [event("e2")] },
      env(),
    );
    expect(next.accepted).toEqual([{ eventId: "e2", eventSeq: 2 }]);
  });

  it("eventId は端末ごとに判定する。別の端末の同じ eventId は、別のイベントとして追加される", () => {
    const { relay } = createFixture();
    const push = (targetId: string, eventId: string) =>
      relay.pushEvents(
        "room-a",
        { targetId, controlSeq: 0, events: [event(eventId)] },
        env(),
      ).accepted;

    expect(push("t1", "e1")).toEqual([{ eventId: "e1", eventSeq: 1 }]);
    // 別の端末（t2）の同じ eventId は、別のイベント（eventSeq 2）。
    expect(push("t2", "e1")).toEqual([{ eventId: "e1", eventSeq: 2 }]);
    // 同じ端末（t1）の再送は、最初の eventSeq を返し、二重に追加しない。
    expect(push("t1", "e1")).toEqual([{ eventId: "e1", eventSeq: 1 }]);
    expect(push("t2", "e2")).toEqual([{ eventId: "e2", eventSeq: 3 }]);
  });

  it("1つのリクエストの中で同じ eventId が重複しても、二重に追加されず、最初の eventSeq を返す", () => {
    const { relay } = createFixture();
    const result = relay.pushEvents(
      "room-a",
      { targetId: "t1", controlSeq: 0, events: [event("e1"), event("e2"), event("e1")] },
      env(),
    );
    expect(result.accepted).toEqual([
      { eventId: "e1", eventSeq: 1 },
      { eventId: "e2", eventSeq: 2 },
      { eventId: "e1", eventSeq: 1 },
    ]);
  });

  it("通知の listener が例外を投げても、処理は成功し、他の listener に通知され、onListenerError に渡される", () => {
    const errors: unknown[] = [];
    const { relay } = createFixture({ onListenerError: (error) => errors.push(error) });
    const received: unknown[] = [];
    relay.connect(
      "room-a",
      { targetId: "t1" },
      () => {
        throw new Error("listener failed");
      },
      env(),
    );
    relay.connect("room-a", { targetId: "t2" }, (n) => received.push(n), env());

    // lease の取得（状態の更新）は、listener の失敗に関係なく成功する。
    const result = relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());
    expect(result).toEqual({ holderId: "op-1", controlSeq: 1 });
    expect(received).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("listener failed");
  });

  it("TC-003: 古い controlSeq は STALE_CONTROL_SEQ（最新値つき）、大きい値は INVALID_MESSAGE。いずれもイベントは追加されない", () => {
    const { relay } = createFixture();
    goOnline(relay, "room-a", "t1");
    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());
    const latest = relay.changeControl(
      "room-a",
      { operatorId: "op-1", targetId: "t1", sendFilter: ALL_FILTER },
      env(),
    ).controlSeq;

    // 古い値（最新値より小さい）。応答に、サーバーの最新値が含まれる。
    const stale = errorOf(() =>
      relay.pushEvents(
        "room-a",
        { targetId: "t1", controlSeq: latest - 1, events: [event("e1")] },
        env(),
      ),
    );
    expect(stale?.code).toBe("STALE_CONTROL_SEQ");
    expect(stale?.httpStatus).toBe(409);
    expect(stale?.controlSeq).toBe(latest);

    // サーバーが発行していない、大きい値。
    expect(
      errorCodeOf(() =>
        relay.pushEvents(
          "room-a",
          { targetId: "t1", controlSeq: latest + 1, events: [event("e1")] },
          env(),
        ),
      ),
    ).toBe("INVALID_MESSAGE");

    // 拒否されたイベントは追加されていないので、最初の eventSeq は 1。
    const accepted = relay.pushEvents(
      "room-a",
      { targetId: "t1", controlSeq: latest, events: [event("e1")] },
      env(),
    );
    expect(accepted.accepted).toEqual([{ eventId: "e1", eventSeq: 1 }]);
  });

  it("不正なメッセージ（controlSeq、events の形式）は INVALID_MESSAGE", () => {
    const { relay } = createFixture();
    const invalid: Record<string, unknown>[] = [
      { targetId: "t1", controlSeq: -1, events: [event("e1")] },
      { targetId: "t1", controlSeq: 1.5, events: [event("e1")] },
      { targetId: "t1", controlSeq: "0", events: [event("e1")] },
      { targetId: "t1", controlSeq: 0, events: [] },
      { targetId: "t1", controlSeq: 0, events: "e1" },
      { targetId: "t1", controlSeq: 0, events: [{ eventId: "e1" }] },
      { targetId: "t1", controlSeq: 0, events: [{ payload: {} }] },
      { targetId: "", controlSeq: 0, events: [event("e1")] },
    ];
    for (const request of invalid) {
      expect(
        errorCodeOf(() =>
          relay.pushEvents(
            "room-a",
            request as { targetId: string; controlSeq: number; events: unknown },
            env(),
          ),
        ),
      ).toBe("INVALID_MESSAGE");
    }
  });
});
