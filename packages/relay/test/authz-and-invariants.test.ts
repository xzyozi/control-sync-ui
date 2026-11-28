import { describe, expect, it } from "vitest";
import {
  RelayCore,
  type RelayAuditEvent,
  type RelayPrincipal,
} from "../src/index";
import { ALL_FILTER, env, errorCodeOf, errorOf } from "./helpers";

describe("テナント物理分離と認可（#8）", () => {
  it("同じ roomId でも tenantId ごとに制御状態・イベント・通知が物理分離される", () => {
    const relay = new RelayCore({ requireTenant: true });
    relay.createRoom("shared-room", { tenantId: "tenant-a" });
    relay.createRoom("shared-room", { tenantId: "tenant-b" });

    const principalA: RelayPrincipal = {
      subject: "user-a",
      tenantId: "tenant-a",
    };
    const principalB: RelayPrincipal = {
      subject: "user-b",
      tenantId: "tenant-b",
    };

    const eventsA: unknown[] = [];
    const eventsB: unknown[] = [];
    relay.connect(
      "shared-room",
      { targetId: "t1" },
      (n) => eventsA.push(n),
      env(),
      { principal: principalA },
    );
    relay.connect(
      "shared-room",
      { targetId: "t1" },
      (n) => eventsB.push(n),
      env(),
      { principal: principalB },
    );
    relay.presence("shared-room", { targetId: "t1" }, env(), {
      principal: principalA,
    });

    relay.lease(
      "shared-room",
      { operatorId: "op-a", action: "ACQUIRE" },
      env(),
      { principal: principalA },
    );
    relay.changeControl(
      "shared-room",
      { operatorId: "op-a", targetId: "t1", sendFilter: ALL_FILTER },
      env(),
      { principal: principalA },
    );
    const pushedA = relay.pushEvents(
      "shared-room",
      {
        targetId: "t1",
        controlSeq: 2,
        events: [{ eventId: "e1", payload: { type: "temp" } }],
      },
      env(),
      { principal: principalA },
    );
    expect(pushedA.accepted).toEqual([{ eventId: "e1", eventSeq: 1 }]);

    // tenant-b 側の同名 Room には一切影響しない。
    const snapB = relay.getControl("shared-room", { targetId: "t1" }, env(), {
      principal: principalB,
    });
    expect(snapB).toEqual({
      controlSeq: 0,
      control: { sendFilter: { mode: "NONE" }, holderId: null },
    });
    expect(eventsA).toHaveLength(3);
    expect(eventsB).toHaveLength(0);

    // requireTenant: true のとき tenantId なしは 403 FORBIDDEN。
    const missingTenant = errorOf(() =>
      relay.getControl("shared-room", { targetId: "t1" }, env()),
    );
    expect(missingTenant?.code).toBe("FORBIDDEN");
    expect(missingTenant?.httpStatus).toBe(403);
  });

  it("principal の allowedRoomIds / targetIds / operatorIds および authorize フックでなりすましを防ぐ", () => {
    const relay = new RelayCore({
      authorize: (ctx) => {
        if (
          ctx.operation === "changeControl" &&
          !(ctx.principal?.scopes ?? []).includes("control:write")
        ) {
          return false;
        }
        return true;
      },
    });
    relay.createRoom("room-a");
    relay.createRoom("room-b");

    const restricted: RelayPrincipal = {
      subject: "sub-1",
      allowedRoomIds: ["room-a"],
      targetIds: ["t1"],
      operatorIds: ["op-1"],
      scopes: ["read"],
    };

    // 許可外の Room（存在しない Room でも存在有無を漏らさず 403）
    expect(
      errorCodeOf(() =>
        relay.getControl("room-b", { targetId: "t1" }, env(), {
          principal: restricted,
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      errorCodeOf(() =>
        relay.getControl("nonexistent", { targetId: "t1" }, env(), {
          principal: restricted,
        }),
      ),
    ).toBe("FORBIDDEN");

    // 許可外の targetId / operatorId（なりすまし防止）
    expect(
      errorCodeOf(() =>
        relay.presence("room-a", { targetId: "t2" }, env(), {
          principal: restricted,
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      errorCodeOf(() =>
        relay.lease(
          "room-a",
          { operatorId: "op-admin", action: "ACQUIRE" },
          env(),
          { principal: restricted },
        ),
      ),
    ).toBe("FORBIDDEN");

    // 許可された操作者で lease を取り、scope 不足で changeControl を拒否する。
    relay.connect("room-a", { targetId: "t1" }, () => undefined, env(), {
      principal: restricted,
    });
    relay.presence("room-a", { targetId: "t1" }, env(), {
      principal: restricted,
    });
    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env(), {
      principal: restricted,
    });

    expect(
      errorCodeOf(() =>
        relay.changeControl(
          "room-a",
          { operatorId: "op-1", targetId: "t1", sendFilter: ALL_FILTER },
          env(),
          { principal: restricted },
        ),
      ),
    ).toBe("FORBIDDEN");
  });
});

describe("サーバー側不変条件検証フックと監査ログ（#8）", () => {
  it("onValidatePushEvents が拒否した場合 422 INVARIANT_VIOLATION を返し、1件も永続化しない", () => {
    const audits: RelayAuditEvent[] = [];
    const relay = new RelayCore({
      onValidatePushEvents: ({ events }) => {
        for (const item of events) {
          if (typeof item.payload.amount !== "number" || item.payload.amount <= 0) {
            return { valid: false, message: "amount must be positive" };
          }
        }
      },
      onAudit: (ev) => audits.push(ev),
    });
    relay.createRoom("room-a");

    const err = errorOf(() =>
      relay.pushEvents(
        "room-a",
        {
          targetId: "t1",
          controlSeq: 0,
          events: [
            { eventId: "e1", payload: { type: "sale", amount: 100 } },
            { eventId: "e2", payload: { type: "sale", amount: -5 } },
          ],
        },
        env({ requestId: "req-bad" }),
        { principal: { subject: "device-1" } },
      ),
    );
    expect(err?.code).toBe("INVARIANT_VIOLATION");
    expect(err?.httpStatus).toBe(422);
    expect(err?.message).toBe("amount must be positive");

    // 原子性: 1件目の e1 も保存されていない（再送しても eventSeq 1 が割り当たる）。
    const ok = relay.pushEvents(
      "room-a",
      {
        targetId: "t1",
        controlSeq: 0,
        events: [{ eventId: "e1", payload: { type: "sale", amount: 100 } }],
      },
      env({ requestId: "req-ok" }),
      { principal: { subject: "device-1" } },
    );
    expect(ok.accepted).toEqual([{ eventId: "e1", eventSeq: 1 }]);

    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      operation: "pushEvents",
      roomId: "room-a",
      subject: "device-1",
      requestId: "req-bad",
      targetId: "t1",
      outcome: "DENIED",
      errorCode: "INVARIANT_VIOLATION",
    });
    expect(audits[1]).toMatchObject({
      operation: "pushEvents",
      outcome: "ALLOWED",
      requestId: "req-ok",
    });
  });

  it("onValidateChangeControl / onValidateLease が例外を投げた場合も INVARIANT_VIOLATION で状態を変更しない", () => {
    const relay = new RelayCore({
      onValidateLease: ({ action }) => {
        if (action === "RELEASE") {
          throw new Error("release blocked by policy");
        }
      },
      onValidateChangeControl: ({ sendFilter }) => {
        if (sendFilter.mode === "ALL") {
          return { valid: false, message: "ALL filter is forbidden" };
        }
      },
    });
    relay.createRoom("room-a");
    relay.connect("room-a", { targetId: "t1" }, () => undefined, env());
    relay.presence("room-a", { targetId: "t1" }, env());
    relay.lease("room-a", { operatorId: "op-1", action: "ACQUIRE" }, env());

    const ctrlErr = errorOf(() =>
      relay.changeControl(
        "room-a",
        { operatorId: "op-1", targetId: "t1", sendFilter: ALL_FILTER },
        env(),
      ),
    );
    expect(ctrlErr?.code).toBe("INVARIANT_VIOLATION");
    expect(ctrlErr?.httpStatus).toBe(422);
    expect(
      relay.getControl("room-a", { targetId: "t1" }, env()).control.sendFilter,
    ).toEqual({ mode: "NONE" });

    const leaseErr = errorOf(() =>
      relay.lease("room-a", { operatorId: "op-1", action: "RELEASE" }, env()),
    );
    expect(leaseErr?.code).toBe("INVARIANT_VIOLATION");
    expect(
      relay.getControl("room-a", { targetId: "t1" }, env()).control.holderId,
    ).toBe("op-1");
  });
});
