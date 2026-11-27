import { describe, expect, it } from "vitest";
import { ALL_FILTER, TYPES_FILTER, createFixture, env, errorCodeOf, goOnline } from "./helpers";
import type { Fixture } from "./helpers";

/** op-1 が lease を保持し、t1 がオンラインの状態を作る。 */
function ready(): Fixture {
  const fixture = createFixture();
  goOnline(fixture.relay, "room-a", "t1");
  fixture.relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());
  return fixture;
}

const change = (
  fixture: Fixture,
  overrides: { operatorId?: string; targetId?: string; sendFilter?: unknown } = {},
  requestEnv = env(),
) =>
  fixture.relay.changeControl(
    "room-a",
    {
      operatorId: overrides.operatorId ?? "op-1",
      targetId: overrides.targetId ?? "t1",
      sendFilter: overrides.sendFilter ?? ALL_FILTER,
    },
    requestEnv,
  );

describe("IF-006 送信対象フィルタの変更", () => {
  it("TC-002: 変更するたびに、controlSeq が増加し、重複しない", () => {
    const fixture = ready();
    const first = change(fixture).controlSeq;
    const second = change(fixture, { sendFilter: TYPES_FILTER }).controlSeq;
    expect(second).toBe(first + 1);

    const snapshot = fixture.relay.getControl("room-a", { targetId: "t1" }, env());
    expect(snapshot.controlSeq).toBe(second);
    expect(snapshot.control.sendFilter).toEqual(TYPES_FILTER);
  });

  it("TC-001: lease を持たない操作者の変更は LOCK_NOT_HELD で、controlSeq は増えない", () => {
    const fixture = ready();
    const before = fixture.relay.getControl("room-a", { targetId: "t1" }, env()).controlSeq;

    expect(errorCodeOf(() => change(fixture, { operatorId: "op-2" }))).toBe("LOCK_NOT_HELD");

    const after = fixture.relay.getControl("room-a", { targetId: "t1" }, env());
    expect(after.controlSeq).toBe(before);
    expect(after.control.sendFilter).toEqual({ mode: "NONE" });
  });

  it("TC-118: 判定の順序は、ロック、オンライン判定の順（保持者でなければ、オフラインより先に LOCK_NOT_HELD）", () => {
    const fixture = ready();
    // t9 は、オフライン。
    expect(errorCodeOf(() => change(fixture, { operatorId: "op-2", targetId: "t9" }))).toBe(
      "LOCK_NOT_HELD",
    );
    // 保持者でも、オフラインなら TARGET_OFFLINE。
    expect(errorCodeOf(() => change(fixture, { targetId: "t9" }))).toBe("TARGET_OFFLINE");
  });

  it("TC-006 / TC-113: 接続がない、または presence の期限が切れた端末は TARGET_OFFLINE で、変更は適用されない", () => {
    const { relay, clock } = createFixture();
    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());
    const request = { operatorId: "op-1", targetId: "t1", sendFilter: ALL_FILTER };

    // 接続も presence もない。
    expect(errorCodeOf(() => relay.changeControl("room-a", request, env()))).toBe("TARGET_OFFLINE");

    // 接続だけ（presence なし）。
    relay.connect("room-a", { targetId: "t1" }, () => undefined, env());
    expect(errorCodeOf(() => relay.changeControl("room-a", request, env()))).toBe("TARGET_OFFLINE");

    // 接続と presence があれば、受け付けられる。
    relay.presence("room-a", { targetId: "t1" }, env());
    relay.lease("room-a", { operatorId: "op-1", action: "RENEW" }, env());
    expect(relay.changeControl("room-a", request, env()).controlSeq).toBeGreaterThan(0);

    // presence の期限（15 秒）が切れると、再びオフライン。
    clock.advance(15_000);
    relay.lease("room-a", { operatorId: "op-1", action: "RENEW" }, env());
    expect(errorCodeOf(() => relay.changeControl("room-a", request, env()))).toBe("TARGET_OFFLINE");

    // オフラインの拒否では、フィルタは変わっていない（最初の成功の ALL のまま）。
    expect(relay.getControl("room-a", { targetId: "t1" }, env()).control.sendFilter).toEqual(
      ALL_FILTER,
    );
  });

  it("接続を閉じると、presence が有効でもオフライン", () => {
    const { relay } = createFixture();
    const close = relay.connect("room-a", { targetId: "t1" }, () => undefined, env());
    relay.presence("room-a", { targetId: "t1" }, env());
    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());
    close();

    expect(
      errorCodeOf(() =>
        relay.changeControl(
          "room-a",
          { operatorId: "op-1", targetId: "t1", sendFilter: ALL_FILTER },
          env(),
        ),
      ),
    ).toBe("TARGET_OFFLINE");
  });

  it("TC-013: 同じ Room の他の端末がオフラインでも、対象の端末がオンラインなら拒否されない", () => {
    const fixture = ready();
    // t2 は、接続も presence もない（オフライン）。t1 はオンライン。
    const result = change(fixture, { targetId: "t1" });
    expect(result.controlSeq).toBeGreaterThan(0);

    // t2 は、再接続時の IF-001 で、最新の controlSeq を取得できる。
    const snapshot = fixture.relay.getControl("room-a", { targetId: "t2" }, env());
    expect(snapshot.controlSeq).toBe(result.controlSeq);
  });

  it("TC-115: 同じ requestId の再送は、二重に適用されず、最初の応答と同じ controlSeq を返す", () => {
    const fixture = ready();
    const requestEnv = env({ requestId: "retry-1" });

    const first = change(fixture, { sendFilter: ALL_FILTER }, requestEnv);
    const second = change(fixture, { sendFilter: ALL_FILTER }, requestEnv);

    expect(second).toEqual(first);
    expect(
      fixture.relay.getControl("room-a", { targetId: "t1" }, env()).controlSeq,
    ).toBe(first.controlSeq);
  });

  it("保持期間（10 分）を過ぎた requestId は、新しい要求として扱う", () => {
    const fixture = ready();
    const requestEnv = env({ requestId: "retry-2" });
    const first = change(fixture, {}, requestEnv);

    fixture.clock.advance(600_000);
    // lease と presence は、期限が切れているので、更新し直す。
    fixture.relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());
    goOnline(fixture.relay, "room-a", "t1");

    const again = change(fixture, {}, requestEnv);
    expect(again.controlSeq).toBeGreaterThan(first.controlSeq);
  });

  it("不正な sendFilter は INVALID_MESSAGE", () => {
    const fixture = ready();
    const invalid: unknown[] = [
      null,
      "ALL",
      { mode: "SOME" },
      { mode: "TYPES" },
      { mode: "TYPES", types: [] },
      { mode: "ALL", targetIds: [] },
      { mode: "ALL", types: [1] },
    ];
    for (const sendFilter of invalid) {
      expect(errorCodeOf(() => change(fixture, { sendFilter }))).toBe("INVALID_MESSAGE");
    }
  });
});
