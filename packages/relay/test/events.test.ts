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
