import {
  ControlStore,
  DomainStore,
  DuplicateEventError,
  ReactiveOutbox,
  type DomainEventInput,
  type Reducer,
  type StoredEvent,
} from "@csu/core";
import { describe, expect, it } from "vitest";
import {
  IndexedDbStoragePort,
  StorageBlockedError,
  StorageCorruptionError,
  UnsupportedStorageVersionError,
} from "../src/index";
import { FakeIndexedDbFactory, fakeKeyRange } from "./fake-idb";

function makeEvent(
  eventId: string,
  roomId = "room-a",
  type = "add",
  amount = 1,
): DomainEventInput {
  return {
    eventId,
    roomId,
    payload: { type, amount },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const sumReducer: Reducer<number> = (state, event: StoredEvent) => {
  const amount = event.payload.amount;
  return state + (typeof amount === "number" ? amount : 0);
};

async function openPort(
  factory: FakeIndexedDbFactory,
  options: { dbName?: string; now?: () => string; onVersionChange?: () => void } = {},
): Promise<IndexedDbStoragePort> {
  return IndexedDbStoragePort.open({
    indexedDB: factory,
    keyRange: fakeKeyRange,
    ...options,
  });
}

describe("IndexedDbStoragePort", () => {
  it("TC-101: DomainStore の追記・復元・開き直しで決定論的に同じ状態を得る", async () => {
    const factory = new FakeIndexedDbFactory();
    const port1 = await openPort(factory);
    const live = new DomainStore(port1, "room-a", sumReducer, 0);
    await live.apply({
      eventId: "e1",
      payload: { type: "add", amount: 3 },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await live.apply({
      eventId: "e2",
      payload: { type: "add", amount: 5 },
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    expect(live.state).toBe(8);
    port1.close();

    // 同じ DB を開き直しても、イベントログから同じ状態を復元できる。
    const port2 = await openPort(factory);
    const reopened = new DomainStore(port2, "room-a", sumReducer, 0);
    expect(await reopened.restore()).toBe(8);
    expect((await port2.readAll("room-a")).map((e) => e.localSeq)).toEqual([
      1, 2,
    ]);
    port2.close();
  });

  it("TC-201 / TC-102: events と delivery の追記途中で失敗した場合、どちらも保存されず状態も更新されない", async () => {
    const factory = new FakeIndexedDbFactory();
    const port = await openPort(factory);
    const store = new DomainStore(port, "room-a", sumReducer, 10);

    // events への書き込み後に delivery への書き込みを失敗させる。
    factory.onStoreWrite = (storeName) =>
      storeName === "delivery"
        ? { name: "AbortError", message: "simulated abort mid-transaction" }
        : null;

    await expect(
      store.apply({
        eventId: "e-fail",
        payload: { type: "add", amount: 7 },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("simulated abort mid-transaction");

    expect(store.state).toBe(10);
    // events にも delivery にも残らない（原子性の保証）。
    expect(factory.countRecords("csu-sync", "events")).toBe(0);
    expect(factory.countRecords("csu-sync", "delivery")).toBe(0);
    port.close();
  });

  it("TC-202 / TC-121: 同じ eventId の二重追記で ConstraintError を DuplicateEventError に変換し、DomainStore は追記済みとして扱う", async () => {
    const factory = new FakeIndexedDbFactory();
    const port = await openPort(factory);

    const stored = await port.append(makeEvent("e1"));
    expect(stored.localSeq).toBe(1);
    await expect(port.append(makeEvent("e1"))).rejects.toBeInstanceOf(
      DuplicateEventError,
    );
    expect(factory.countRecords("csu-sync", "events")).toBe(1);
    expect(factory.countRecords("csu-sync", "delivery")).toBe(1);

    // DomainStore 経由でもエラーにならず、状態が二重に更新されない。
    const domain = new DomainStore(port, "room-a", sumReducer, 0);
    await domain.restore();
    expect(await domain.apply({
      eventId: "e1",
      payload: { type: "add", amount: 99 },
    })).toBe(1);
    expect(domain.state).toBe(1);
    port.close();
  });

  it("TC-203: meta.storageVersion が '1' より新しい DB を開くとデータを変更せずエラー停止する", async () => {
    const factory = new FakeIndexedDbFactory();
    const initial = await openPort(factory);
    await initial.append(makeEvent("e1"));
    initial.close();

    // 既存 DB の meta.storageVersion を "2" に書き換える。
    factory.seedMeta("csu-sync", "storageVersion", "2");

    await expect(openPort(factory)).rejects.toBeInstanceOf(
      UnsupportedStorageVersionError,
    );
    // 既存データは変更されない。
    expect(factory.dumpRecords("csu-sync", "events")).toHaveLength(1);
    expect(factory.dumpRecords("csu-sync", "meta")).toEqual([
      { key: "storageVersion", value: "2" },
    ]);
  });

  it("TC-117: Room ごとの readAll / readPending と markSent の冪等性・updatedAt を保証する", async () => {
    const factory = new FakeIndexedDbFactory();
    let tick = 0;
    const port = await openPort(factory, {
      now: () => {
        tick += 1;
        return `2026-01-01T00:00:0${tick}.000Z`;
      },
    });

    await port.append(makeEvent("e1", "room-a", "temperature"));
    await port.append(makeEvent("e2", "room-b", "temperature"));
    await port.append(makeEvent("e3", "room-a", "humidity"));

    const control = new ControlStore();
    control.applyControl(1, { sendFilter: { mode: "ALL" }, holderId: null });
    const outboxA = new ReactiveOutbox(port, control, "room-a", "t1");
    expect((await outboxA.evaluate()).events.map((e) => e.eventId)).toEqual([
      "e1",
      "e3",
    ]);

    // markSent で e1 を SENT にし、二重呼び出しは最初の eventSeq と updatedAt を保持する（DS §3.1）。
    await port.markSent("e1", 10);
    await port.markSent("e1", 99);
    const deliveries = factory.dumpRecords("csu-sync", "delivery");
    const d1 = deliveries.find((d) => d.eventId === "e1");
    expect(d1).toMatchObject({
      status: "SENT",
      eventSeq: 10,
      updatedAt: "2026-01-01T00:00:04.000Z",
    });

    // e1 は readPending から外れるが、readAll には残る。
    expect((await port.readPending("room-a")).map((e) => e.eventId)).toEqual([
      "e3",
    ]);
    expect((await port.readAll("room-a")).map((e) => e.eventId)).toEqual([
      "e1",
      "e3",
    ]);
    // 未知の eventId はエラーを返す。
    await expect(port.markSent("missing", 1)).rejects.toThrow("unknown event");
    port.close();
  });

  it("blocked・versionchange・破損（delivery に対応する event 欠落）を検出する", async () => {
    const factory = new FakeIndexedDbFactory();
    const port = await openPort(factory);
    await port.append(makeEvent("e1"));

    // events が欠落した不整合状態（DS §3.1 の 5）を再現する。
    factory.deleteRecordForTest("csu-sync", "events", 1);
    await expect(port.readPending("room-a")).rejects.toBeInstanceOf(
      StorageCorruptionError,
    );

    // versionchange で接続を閉じてコールバックを呼ぶ（DS §3.2）。
    let versionChanged = 0;
    const port2 = await openPort(factory, {
      onVersionChange: () => {
        versionChanged += 1;
      },
    });
    const req = factory.open("csu-sync", 2);
    await new Promise<void>((resolve) => {
      req.onsuccess = () => resolve();
    });
    expect(versionChanged).toBe(1);
    port.close();
    port2.close();

    // blocked で StorageBlockedError を返す（DS §3.2）。
    factory.blockNextOpen = true;
    await expect(openPort(factory)).rejects.toBeInstanceOf(StorageBlockedError);
  });
});
