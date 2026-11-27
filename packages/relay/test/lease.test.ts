import { describe, expect, it } from "vitest";
import { ALL_FILTER, createFixture, env, errorCodeOf, goOnline } from "./helpers";

describe("lease と controlSeq の発行", () => {
  it("TC-010 / TC-111: 保持者が変わる操作だけが controlSeq を発行する", () => {
    const { relay } = createFixture();
    const seq = () => relay.getControl("room-a", { targetId: "t1" }, env()).controlSeq;

    expect(seq()).toBe(0);

    // 新しい ACQUIRE は発行する。
    expect(relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env()))
      .toEqual({ holderId: "op-1", controlSeq: 1 });

    // 同じ操作者の ACQUIRE（更新として扱う）と RENEW は、発行しない。
    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());
    relay.lease("room-a", { operatorId: "op-1", action: "RENEW" }, env());
    expect(seq()).toBe(1);

    // RELEASE は発行する。
    expect(relay.lease("room-a", { operatorId: "op-1", action: "RELEASE" }, env()))
      .toEqual({ holderId: null, controlSeq: 2 });
  });

  it("別の操作者の ACQUIRE は LOCK_HELD_BY_OTHER で、状態は変わらない", () => {
    const { relay } = createFixture();
    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());

    expect(
      errorCodeOf(() =>
        relay.lease("room-a", { operatorId: "op-2", action: "ACQUIRE" }, env()),
      ),
    ).toBe("LOCK_HELD_BY_OTHER");
    expect(relay.getControl("room-a", { targetId: "t1" }, env()).control.holderId).toBe("op-1");
  });

  it("保持者でない操作者の RENEW と RELEASE は LOCK_NOT_HELD", () => {
    const { relay } = createFixture();
    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());

    for (const action of ["RENEW", "RELEASE"]) {
      expect(
        errorCodeOf(() => relay.lease("room-a", { operatorId: "op-2", action }, env())),
      ).toBe("LOCK_NOT_HELD");
    }
    // 誰も保持していない場合も、同じ。
    const other = createFixture().relay;
    expect(
      errorCodeOf(() => other.lease("room-a", { operatorId: "op-1", action: "RENEW" }, env())),
    ).toBe("LOCK_NOT_HELD");
  });

  it("不正な action は INVALID_MESSAGE", () => {
    const { relay } = createFixture();
    expect(
      errorCodeOf(() => relay.lease("room-a", { operatorId: "op-1", action: "STEAL" }, env())),
    ).toBe("INVALID_MESSAGE");
  });

  it("TC-005 / TC-112: 期限の時刻に解放され、controlSeq の発行と通知が行われ、別の操作者が取得できる", () => {
    const { relay, clock } = createFixture();
    const received = goOnline(relay, "room-a", "t1");
    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());
    received.length = 0;

    // 期限（30 秒）の直前は、まだ解放されない。
    clock.advance(29_999);
    relay.tick();
    expect(received).toHaveLength(0);

    // 期限の時刻に、tick だけで（次のアクセスを待たずに）解放され、通知される。
    clock.advance(1);
    relay.tick();
    expect(received).toEqual([
      { schemaVersion: "1", type: "CONTROL_UPDATED", controlSeq: 2 },
    ]);

    expect(
      relay.lease("room-a", { operatorId: "op-2", action: "ACQUIRE" }, env()).holderId,
    ).toBe("op-2");
  });

  it("RENEW で期限が延びる（lease heartbeat）。更新のたびに controlSeq は増えない", () => {
    const { relay, clock } = createFixture();
    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());

    for (let i = 0; i < 3; i += 1) {
      clock.advance(10_000);
      relay.lease("room-a", { operatorId: "op-1", action: "RENEW" }, env());
    }
    // 取得から 30 秒を超えているが、更新したので、保持している。
    const snapshot = relay.getControl("room-a", { targetId: "t1" }, env());
    expect(snapshot.control.holderId).toBe("op-1");
    expect(snapshot.controlSeq).toBe(1);
  });

  it("tick が遅れても、期限切れの lease は、次のアクセスで解放される", () => {
    const { relay, clock } = createFixture();
    goOnline(relay, "room-a", "t1");
    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());

    clock.advance(31_000);
    // tick を呼ばずに、元の保持者が変更しようとしても、拒否される。
    expect(
      errorCodeOf(() =>
        relay.changeControl(
          "room-a",
          { operatorId: "op-1", targetId: "t1", sendFilter: ALL_FILTER },
          env(),
        ),
      ),
    ).toBe("LOCK_NOT_HELD");
  });

  it("nextExpiry は、最も早い期限を返す。保持者がいなければ null", () => {
    const { relay, clock } = createFixture();
    expect(relay.nextExpiry()).toBeNull();

    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());
    expect(relay.nextExpiry()).toBe(clock.now() + 30_000);
  });
});
