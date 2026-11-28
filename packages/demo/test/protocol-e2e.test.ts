import {
  ControlStore,
  DomainStore,
  type Scheduler,
  SyncEngine,
  type SyncState,
} from "@csu/core";
import {
  RelayCore,
  type RelayOptions,
  type RelayServer,
  startRelayServer,
} from "@csu/relay";
import { IndexedDbStoragePort } from "@csu/storage-indexeddb";
import { type AuthTokenProvider, HttpTransport } from "@csu/transport-http";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeIndexedDbFactory,
  fakeKeyRange,
} from "../../storage-indexeddb/test/fake-idb";
import {
  DEMO_SCHEMA_VERSION,
  INITIAL_DEMO_STATE,
  demoReducer,
} from "../src/shared";
import { NodeSseEventSource } from "./sse-client";

const servers: RelayServer[] = [];
const engines: SyncEngine[] = [];
const ports: IndexedDbStoragePort[] = [];

afterEach(async () => {
  while (engines.length > 0) {
    engines.pop()?.disconnect();
  }
  while (ports.length > 0) {
    ports.pop()?.close();
  }
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await server.close();
    }
  }
});

const realScheduler: Scheduler = {
  setTimeout: (cb, ms) => {
    const id = setTimeout(cb, ms);
    return () => clearTimeout(id);
  },
  setInterval: (cb, ms) => {
    const id = setInterval(cb, ms);
    return () => clearInterval(id);
  },
};

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

async function startTestRelay(options: RelayOptions = {}): Promise<{
  relay: RelayCore;
  server: RelayServer;
}> {
  const relay = new RelayCore(options);
  relay.createRoom("room-a");
  relay.createRoom("room-b");
  const server = await startRelayServer(relay);
  servers.push(server);
  return { relay, server };
}

async function createTargetClient(args: {
  baseUrl: string;
  roomId: string;
  targetId: string;
  idbFactory?: FakeIndexedDbFactory;
  schemaVersion?: string;
  presenceIntervalMs?: number;
  authToken?: AuthTokenProvider;
}) {
  const factory = args.idbFactory ?? new FakeIndexedDbFactory();
  const storage = await IndexedDbStoragePort.open({
    dbName: `db-${args.roomId}-${args.targetId}`,
    indexedDB: factory,
    keyRange: fakeKeyRange,
  });
  ports.push(storage);

  const domain = new DomainStore(
    storage,
    args.roomId,
    demoReducer,
    INITIAL_DEMO_STATE,
  );
  await domain.restore();

  const control = new ControlStore();
  const transport = new HttpTransport({
    baseUrl: args.baseUrl,
    schemaVersion: args.schemaVersion ?? DEMO_SCHEMA_VERSION,
    ...(args.authToken !== undefined ? { authToken: args.authToken } : {}),
    EventSource: NodeSseEventSource,
  });

  let reqSeq = 0;
  const states: SyncState[] = [];
  const stoppedReasons: string[] = [];
  const engine = new SyncEngine({
    roomId: args.roomId,
    targetId: args.targetId,
    storage,
    controlStore: control,
    transport,
    scheduler: realScheduler,
    presenceIntervalMs: args.presenceIntervalMs ?? 200,
    retryDelaysMs: [40, 80, 120],
    newRequestId: () => {
      reqSeq += 1;
      return `${args.targetId}-req-${reqSeq}`;
    },
    onStateChange: (s) => states.push(s),
    onStopped: (reason) => stoppedReasons.push(reason),
  });
  engines.push(engine);

  return {
    factory,
    storage,
    domain,
    control,
    engine,
    states,
    stoppedReasons,
  };
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Schema-Version": DEMO_SCHEMA_VERSION,
      "X-Request-Id": `op-${Date.now()}-${Math.random()}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("4パッケージ結合 Protocol E2E (FR-01〜FR-05)", () => {
  it("FR-01〜FR-04: lease・フィルタ変更・SSE再評価・IndexedDB復元が実HTTP/SSEで連動する", async () => {
    const { server } = await startTestRelay();
    const idbFactory = new FakeIndexedDbFactory();
    const target = await createTargetClient({
      baseUrl: server.baseUrl,
      roomId: "room-a",
      targetId: "t-1",
      idbFactory,
    });

    target.engine.connect();
    await waitUntil(() => target.engine.state === "Ready");
    expect(target.control.getControlSeq()).toBe(0);
    expect(target.control.getControl().sendFilter).toEqual({ mode: "NONE" });

    // NONE フィルタではローカルに未送信として留まる（FR-03）。
    await target.domain.apply({
      eventId: "e1",
      payload: { type: "temperature", amount: 10 },
    });
    await target.domain.apply({
      eventId: "e2",
      payload: { type: "humidity", amount: 5 },
    });
    target.engine.notifyLocalEvents();
    await new Promise<void>((r) => setTimeout(r, 40));
    expect((await target.storage.readPending("room-a")).length).toBe(2);

    // TC-001: lease 未取得の操作者は LOCK_NOT_HELD (403) で拒否される。
    const noLock = await postJson(server.baseUrl, "/rooms/room-a/control", {
      operatorId: "op-1",
      targetId: "t-1",
      sendFilter: { mode: "ALL" },
    });
    expect(noLock.status).toBe(403);
    expect(noLock.body.code).toBe("LOCK_NOT_HELD");

    // TC-010: ACQUIRE で controlSeq が増え、同じ操作者の ACQUIRE / RENEW では増えない。
    const acq = await postJson(server.baseUrl, "/rooms/room-a/lease", {
      operatorId: "op-1",
      action: "ACQUIRE",
    });
    expect(acq.status).toBe(200);
    expect(acq.body.controlSeq).toBe(1);

    const renew = await postJson(server.baseUrl, "/rooms/room-a/lease", {
      operatorId: "op-1",
      action: "RENEW",
    });
    expect(renew.status).toBe(200);
    expect(renew.body.controlSeq).toBe(1);

    // TYPES=["temperature"] に変更すると SSE 経由で対象端末が Pull し、e1 のみ送信される（FR-03 / FR-04）。
    const filterTypes = await postJson(
      server.baseUrl,
      "/rooms/room-a/control",
      {
        operatorId: "op-1",
        targetId: "t-1",
        sendFilter: { mode: "TYPES", types: ["temperature"] },
      },
    );
    expect(filterTypes.status).toBe(200);
    expect(filterTypes.body.controlSeq).toBe(2);

    await waitUntil(
      async () => (await target.storage.readPending("room-a")).length === 1,
    );
    expect(
      (await target.storage.readPending("room-a")).map((e) => e.eventId),
    ).toEqual(["e2"]);

    // ALL に変更すると残りの e2 も送信される。
    const filterAll = await postJson(
      server.baseUrl,
      "/rooms/room-a/control",
      {
        operatorId: "op-1",
        targetId: "t-1",
        sendFilter: { mode: "ALL" },
      },
    );
    expect(filterAll.status).toBe(200);
    expect(filterAll.body.controlSeq).toBe(3);
    await waitUntil(
      async () => (await target.storage.readPending("room-a")).length === 0,
    );

    // FR-01 / TC-101: 接続を閉じて開き直しても IndexedDB から同じ状態（total=15）を復元できる。
    target.engine.disconnect();
    target.storage.close();
    const reopened = await createTargetClient({
      baseUrl: server.baseUrl,
      roomId: "room-a",
      targetId: "t-1",
      idbFactory,
    });
    expect(reopened.domain.state.total).toBe(15);
    expect(reopened.domain.state.eventCount).toBe(2);
    expect((await reopened.storage.readPending("room-a")).length).toBe(0);
  });

  it("FR-02 / TC-005 / TC-112: lease の TTL 期限切れで自動解放され別操作者が取得できる", async () => {
    const { server } = await startTestRelay({ leaseTtlMs: 80 });
    const target = await createTargetClient({
      baseUrl: server.baseUrl,
      roomId: "room-a",
      targetId: "t-1",
    });
    target.engine.connect();
    await waitUntil(() => target.engine.state === "Ready");

    const acq1 = await postJson(server.baseUrl, "/rooms/room-a/lease", {
      operatorId: "op-1",
      action: "ACQUIRE",
    });
    expect(acq1.body.controlSeq).toBe(1);

    // op-1 が保持中は op-2 は LOCK_HELD_BY_OTHER。
    const conflict = await postJson(server.baseUrl, "/rooms/room-a/lease", {
      operatorId: "op-2",
      action: "ACQUIRE",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("LOCK_HELD_BY_OTHER");

    // 期限切れ後に op-1 が解放済みになり、target が SSE で controlSeq=2 (holderId=null) を受け取る。
    await waitUntil(() => target.control.getControlSeq() >= 2);
    expect(target.control.getControl().holderId).toBeNull();

    const acq2 = await postJson(server.baseUrl, "/rooms/room-a/lease", {
      operatorId: "op-2",
      action: "ACQUIRE",
    });
    expect(acq2.status).toBe(200);
    expect(acq2.body.holderId).toBe("op-2");
    expect(acq2.body.controlSeq).toBe(3);
  });

  it("FR-05 / TC-006: 対象端末の切断・presence期限切れで即座に TARGET_OFFLINE (409) を返す", async () => {
    const { server } = await startTestRelay({ presenceTtlMs: 80 });
    const target = await createTargetClient({
      baseUrl: server.baseUrl,
      roomId: "room-a",
      targetId: "t-1",
      presenceIntervalMs: 40,
    });
    target.engine.connect();
    await waitUntil(() => target.engine.state === "Ready");

    await postJson(server.baseUrl, "/rooms/room-a/lease", {
      operatorId: "op-1",
      action: "ACQUIRE",
    });

    // オンライン中は変更可能。
    const onlineChange = await postJson(
      server.baseUrl,
      "/rooms/room-a/control",
      {
        operatorId: "op-1",
        targetId: "t-1",
        sendFilter: { mode: "ALL" },
      },
    );
    expect(onlineChange.status).toBe(200);

    // 切断して presence TTL を過ぎると TARGET_OFFLINE になり要求は滞留しない。
    target.engine.disconnect();
    await new Promise<void>((r) => setTimeout(r, 110));

    const offlineChange = await postJson(
      server.baseUrl,
      "/rooms/room-a/control",
      {
        operatorId: "op-1",
        targetId: "t-1",
        sendFilter: { mode: "NONE" },
      },
    );
    expect(offlineChange.status).toBe(409);
    expect(offlineChange.body.code).toBe("TARGET_OFFLINE");
  });

  it("FR-04 / TC-008 / TC-013: Room 分離と、オフラインだった別端末の再接続時 Pull 先行を保証する", async () => {
    const { server } = await startTestRelay();
    const targetX = await createTargetClient({
      baseUrl: server.baseUrl,
      roomId: "room-a",
      targetId: "t-x",
    });
    const targetB = await createTargetClient({
      baseUrl: server.baseUrl,
      roomId: "room-b",
      targetId: "t-b",
    });

    targetX.engine.connect();
    targetB.engine.connect();
    await waitUntil(
      () =>
        targetX.engine.state === "Ready" && targetB.engine.state === "Ready",
    );

    await postJson(server.baseUrl, "/rooms/room-a/lease", {
      operatorId: "op-1",
      action: "ACQUIRE",
    });
    // t-y が未接続でも、オンラインの t-x 指定の制御変更は許可される（TC-013）。
    const res = await postJson(server.baseUrl, "/rooms/room-a/control", {
      operatorId: "op-1",
      targetId: "t-x",
      sendFilter: { mode: "ALL" },
    });
    expect(res.status).toBe(200);
    expect(res.body.controlSeq).toBe(2);

    await waitUntil(() => targetX.control.getControlSeq() === 2);
    // Room B には影響しない（TC-008）。
    expect(targetB.control.getControlSeq()).toBe(0);
    expect(targetB.control.getControl().sendFilter).toEqual({ mode: "NONE" });

    // オフラインだった t-y が後から接続すると、Control-First Sync で controlSeq=2 を Pull してから未送信イベントを送る。
    const targetY = await createTargetClient({
      baseUrl: server.baseUrl,
      roomId: "room-a",
      targetId: "t-y",
    });
    await targetY.domain.apply({
      eventId: "ey-1",
      payload: { type: "add", amount: 7 },
    });
    targetY.engine.connect();
    await waitUntil(
      async () =>
        targetY.control.getControlSeq() === 2 &&
        (await targetY.storage.readPending("room-a")).length === 0,
    );
    expect(targetY.states.indexOf("Pulling")).toBeLessThan(
      targetY.states.indexOf("Ready"),
    );
  });

  it("NFR-03 / TC-007 / TC-108: schemaVersion 不一致時に永続状態を変えず安全に Stopped になる", async () => {
    const { server } = await startTestRelay();
    const target = await createTargetClient({
      baseUrl: server.baseUrl,
      roomId: "room-a",
      targetId: "t-mismatch",
      schemaVersion: "999",
    });
    await target.domain.apply({
      eventId: "e-keep",
      payload: { type: "add", amount: 42 },
    });

    target.engine.connect();
    await waitUntil(() => target.engine.state === "Stopped");
    expect(target.stoppedReasons).toEqual(["SCHEMA_VERSION_MISMATCH"]);
    expect(target.domain.state.total).toBe(42);
    expect((await target.storage.readPending("room-a")).length).toBe(1);
  });

  it("#8 / TC-014〜TC-017 / TC-124 / TC-308: 認証・テナント分離・不変条件検証が 4 パッケージ結合で連動する", async () => {
    const relay = new RelayCore({
      schemaVersion: DEMO_SCHEMA_VERSION,
      requireTenant: true,
      onValidatePushEvents: ({ events }) => {
        for (const ev of events) {
          if (typeof ev.payload.amount !== "number" || ev.payload.amount <= 0) {
            return { valid: false, message: "amount must be positive" };
          }
        }
      },
    });
    relay.createRoom("room-a", { tenantId: "tenant-1" });
    relay.createRoom("room-a", { tenantId: "tenant-2" });

    const principals = new Map([
      [
        "tok-t1",
        { subject: "u-t1", tenantId: "tenant-1", targetIds: ["t-1"] },
      ],
      [
        "tok-op1",
        { subject: "u-op1", tenantId: "tenant-1", operatorIds: ["op-1"] },
      ],
      [
        "tok-t2",
        { subject: "u-t2", tenantId: "tenant-2", targetIds: ["t-1"] },
      ],
    ]);
    const server = await startRelayServer(relay, {
      authenticate: ({ token }) =>
        token !== undefined ? principals.get(token) : null,
    });
    servers.push(server);

    // 1. トークンなしの対象端末は UNAUTHORIZED で安全に停止する。
    const unauthTarget = await createTargetClient({
      baseUrl: server.baseUrl,
      roomId: "room-a",
      targetId: "t-1",
    });
    unauthTarget.engine.connect();
    await waitUntil(() => unauthTarget.engine.state === "Stopped");
    expect(unauthTarget.stoppedReasons).toEqual(["UNAUTHORIZED"]);

    // 2. 認証済みの tenant-1 / tenant-2 端末は同名 room-a でも分離される。
    const target1 = await createTargetClient({
      baseUrl: server.baseUrl,
      roomId: "room-a",
      targetId: "t-1",
      authToken: "tok-t1",
    });
    const target2 = await createTargetClient({
      baseUrl: server.baseUrl,
      roomId: "room-a",
      targetId: "t-1",
      authToken: "tok-t2",
    });
    target1.engine.connect();
    target2.engine.connect();
    await waitUntil(
      () =>
        target1.engine.state === "Ready" && target2.engine.state === "Ready",
    );

    const leaseRes = await postJson(
      server.baseUrl,
      "/rooms/room-a/lease",
      { operatorId: "op-1", action: "ACQUIRE" },
      { Authorization: "Bearer tok-op1" },
    );
    expect(leaseRes.status).toBe(200);

    const ctrlRes = await postJson(
      server.baseUrl,
      "/rooms/room-a/control",
      {
        operatorId: "op-1",
        targetId: "t-1",
        sendFilter: { mode: "ALL" },
      },
      { Authorization: "Bearer tok-op1" },
    );
    expect(ctrlRes.status).toBe(200);

    await waitUntil(() => target1.control.getControlSeq() === 2);
    expect(target2.control.getControlSeq()).toBe(0);

    // 3. 妥当なイベントは送信され、不変条件違反（amount <= 0）は INVARIANT_VIOLATION で停止・未送信保持される。
    await target1.domain.apply({
      eventId: "e-good",
      payload: { type: "add", amount: 5 },
    });
    target1.engine.notifyLocalEvents();
    await waitUntil(
      async () => (await target1.storage.readPending("room-a")).length === 0,
    );

    await target1.domain.apply({
      eventId: "e-bad",
      payload: { type: "add", amount: -1 },
    });
    target1.engine.notifyLocalEvents();
    await waitUntil(() => target1.engine.state === "Stopped");
    expect(target1.stoppedReasons).toEqual(["INVARIANT_VIOLATION"]);
    expect((await target1.storage.readPending("room-a")).length).toBe(1);
  });
});
