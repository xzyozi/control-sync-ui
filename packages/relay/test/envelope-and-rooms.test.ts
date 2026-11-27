import { describe, expect, it } from "vitest";
import type { RelayCore } from "../src/index";
import {
  ALL_FILTER,
  createFixture,
  env,
  errorCodeOf,
  errorOf,
  goOnline,
} from "./helpers";

/** IF-001〜IF-006 を、与えた共通項目で呼ぶ。 */
function callAll(relay: RelayCore, makeEnv: () => ReturnType<typeof env>): (() => unknown)[] {
  return [
    () => relay.getControl("room-a", { targetId: "t1" }, makeEnv()),
    () =>
      relay.pushEvents(
        "room-a",
        { targetId: "t1", controlSeq: 0, events: [{ eventId: "e1", payload: {} }] },
        makeEnv(),
      ),
    () => relay.connect("room-a", { targetId: "t1" }, () => undefined, makeEnv()),
    () => relay.presence("room-a", { targetId: "t1" }, makeEnv()),
    () => relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, makeEnv()),
    () =>
      relay.changeControl(
        "room-a",
        { operatorId: "op-1", targetId: "t1", sendFilter: ALL_FILTER },
        makeEnv(),
      ),
  ];
}

describe("共通項目の検証（F-008）", () => {
  it("TC-007 / TC-114: schemaVersion が一致しないと SCHEMA_VERSION_MISMATCH（HTTP 400）で、サーバーの状態は変化しない", () => {
    const { relay } = createFixture();
    for (const call of callAll(relay, () => env({ schemaVersion: "2" }))) {
      const error = errorOf(call);
      expect(error?.code).toBe("SCHEMA_VERSION_MISMATCH");
      expect(error?.httpStatus).toBe(400);
    }
    const snapshot = relay.getControl("room-a", { targetId: "t1" }, env());
    expect(snapshot.controlSeq).toBe(0);
    expect(snapshot.control).toEqual({ sendFilter: { mode: "NONE" }, holderId: null });
  });

  it("TC-114: schemaVersion または requestId の欠落は INVALID_MESSAGE", () => {
    const { relay } = createFixture();
    const missing = [
      { schemaVersion: undefined },
      { requestId: undefined },
      { schemaVersion: "" },
      { requestId: "" },
    ];
    for (const overrides of missing) {
      for (const call of callAll(relay, () => env(overrides))) {
        const error = errorOf(call);
        expect(error?.code).toBe("INVALID_MESSAGE");
        expect(error?.httpStatus).toBe(400);
      }
    }

    // 検証に失敗した受信は、他の機能を呼び出さず、状態は変わらない（TC-114）。
    const snapshot = relay.getControl("room-a", { targetId: "t1" }, env());
    expect(snapshot.controlSeq).toBe(0);
    expect(snapshot.control).toEqual({ sendFilter: { mode: "NONE" }, holderId: null });
  });

  it("共通項目の検証は、Room の確認より先に行う（不一致の schemaVersion は、存在しない Room でも SCHEMA_VERSION_MISMATCH）", () => {
    const { relay } = createFixture();
    expect(
      errorCodeOf(() => relay.getControl("nope", { targetId: "t1" }, env({ schemaVersion: "2" }))),
    ).toBe("SCHEMA_VERSION_MISMATCH");
    expect(errorCodeOf(() => relay.getControl("nope", { targetId: "t1" }, env()))).toBe(
      "ROOM_NOT_FOUND",
    );
  });
});

describe("Room の分離と更新通知", () => {
  it("TC-008: Room A への操作は、Room B の制御状態、イベント、通知に影響しない", () => {
    const { relay } = createFixture();
    const receivedB = goOnline(relay, "room-b", "t1");
    const receivedA = goOnline(relay, "room-a", "t1");
    receivedA.length = 0;
    receivedB.length = 0;

    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());
    relay.changeControl(
      "room-a",
      { operatorId: "op-1", targetId: "t1", sendFilter: ALL_FILTER },
      env(),
    );
    relay.pushEvents(
      "room-a",
      { targetId: "t1", controlSeq: 2, events: [{ eventId: "e1", payload: {} }] },
      env(),
    );

    // Room B は、何も変わらない。
    const snapshotB = relay.getControl("room-b", { targetId: "t1" }, env());
    expect(snapshotB.controlSeq).toBe(0);
    expect(snapshotB.control).toEqual({ sendFilter: { mode: "NONE" }, holderId: null });
    expect(receivedB).toHaveLength(0);

    // Room B の最初のイベントは、eventSeq 1（Room A の eventSeq とは独立）。
    expect(
      relay.pushEvents(
        "room-b",
        { targetId: "t1", controlSeq: 0, events: [{ eventId: "e1", payload: {} }] },
        env(),
      ).accepted,
    ).toEqual([{ eventId: "e1", eventSeq: 1 }]);
    // 同じ eventId でも、Room が違えば、別のイベント。
    expect(receivedA.length).toBeGreaterThan(0);
  });

  it("TC-011: 制御状態の更新に CONTROL_UPDATED、イベントの追加に EVENTS_APPENDED が通知される", () => {
    const { relay } = createFixture();
    const received = goOnline(relay, "room-a", "t1");

    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());
    relay.changeControl(
      "room-a",
      { operatorId: "op-1", targetId: "t1", sendFilter: ALL_FILTER },
      env(),
    );
    relay.pushEvents(
      "room-a",
      { targetId: "t1", controlSeq: 2, events: [{ eventId: "e1", payload: {} }] },
      env(),
    );

    expect(received).toEqual([
      { schemaVersion: "1", type: "CONTROL_UPDATED", controlSeq: 1 },
      { schemaVersion: "1", type: "CONTROL_UPDATED", controlSeq: 2 },
      { schemaVersion: "1", type: "EVENTS_APPENDED", controlSeq: 2, eventSeq: 1 },
    ]);
  });

  it("接続を閉じた端末には、通知されない。再送（既知の eventId）だけの場合も通知されない", () => {
    const { relay } = createFixture();
    const received: unknown[] = [];
    const close = relay.connect("room-a", { targetId: "t1" }, (n) => received.push(n), env());

    relay.pushEvents(
      "room-a",
      { targetId: "t1", controlSeq: 0, events: [{ eventId: "e1", payload: {} }] },
      env(),
    );
    expect(received).toHaveLength(1);

    // 同じ eventId の再送は、何も追加されないので、通知もしない。
    relay.pushEvents(
      "room-a",
      { targetId: "t1", controlSeq: 0, events: [{ eventId: "e1", payload: {} }] },
      env(),
    );
    expect(received).toHaveLength(1);

    close();
    relay.pushEvents(
      "room-a",
      { targetId: "t1", controlSeq: 0, events: [{ eventId: "e2", payload: {} }] },
      env(),
    );
    expect(received).toHaveLength(1);
  });

  it("存在しない Room は ROOM_NOT_FOUND。createRoom は冪等", () => {
    const { relay } = createFixture();
    expect(errorCodeOf(() => relay.presence("nope", { targetId: "t1" }, env()))).toBe(
      "ROOM_NOT_FOUND",
    );

    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());
    relay.createRoom("room-a");
    expect(relay.getControl("room-a", { targetId: "t1" }, env()).control.holderId).toBe("op-1");
  });
});
