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
  type IdbDatabaseLike,
  type IdbFactoryLike,
  type IdbOpenDbRequestLike,
  type IdbTransactionLike,
} from "../src/index";
import { FakeIndexedDbFactory, fakeKeyRange } from "./fake-idb";

declare function queueMicrotask(callback: () => void): void;

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

  it("append で delivery 側の ConstraintError を StorageCorruptionError として検出し events もロールバックする", async () => {
    const factory = new FakeIndexedDbFactory();
    const port = await openPort(factory);

    factory.onStoreWrite = (storeName) =>
      storeName === "delivery"
        ? { name: "ConstraintError", message: "delivery already exists" }
        : null;

    await expect(port.append(makeEvent("e1"))).rejects.toBeInstanceOf(
      StorageCorruptionError,
    );
    expect(factory.countRecords("csu-sync", "events")).toBe(0);
    expect(factory.countRecords("csu-sync", "delivery")).toBe(0);
    port.close();
  });

  it("readPending の破損検出時に tx.abort を呼ばず InvalidStateError や未処理 Rejection を起こさない", async () => {
    const factory = new FakeIndexedDbFactory();
    const wrappedFactory: IdbFactoryLike = {
      open(name, version) {
        const req = factory.open(name, version);
        const origOnSuccess = () => req.onsuccess;
        return {
          get result() {
            const db = req.result;
            return {
              get version() {
                return db.version;
              },
              objectStoreNames: db.objectStoreNames,
              get onversionchange() {
                return db.onversionchange;
              },
              set onversionchange(fn) {
                db.onversionchange = fn;
              },
              createObjectStore: (s, opts) => db.createObjectStore(s, opts),
              close: () => db.close(),
              transaction(storeNames, mode) {
                const tx = db.transaction(storeNames, mode);
                return {
                  get error() {
                    return tx.error;
                  },
                  get oncomplete() {
                    return tx.oncomplete;
                  },
                  set oncomplete(fn) {
                    tx.oncomplete = fn;
                  },
                  get onabort() {
                    return tx.onabort;
                  },
                  set onabort(fn) {
                    tx.onabort = fn;
                  },
                  get onerror() {
                    return tx.onerror;
                  },
                  set onerror(fn) {
                    tx.onerror = fn;
                  },
                  objectStore: (storeName) => tx.objectStore(storeName),
                  abort() {
                    // 実ブラウザではリクエスト完了後の readonly tx.abort() で InvalidStateError が発生する。
                    const err = new Error("Transaction is already finishing");
                    err.name = "InvalidStateError";
                    throw err;
                  },
                };
              },
            } satisfies IdbDatabaseLike;
          },
          get error() {
            return req.error;
          },
          get onsuccess() {
            return origOnSuccess();
          },
          set onsuccess(fn) {
            req.onsuccess = fn;
          },
          get onerror() {
            return req.onerror;
          },
          set onerror(fn) {
            req.onerror = fn;
          },
          get onupgradeneeded() {
            return req.onupgradeneeded;
          },
          set onupgradeneeded(fn) {
            req.onupgradeneeded = fn;
          },
          get onblocked() {
            return req.onblocked;
          },
          set onblocked(fn) {
            req.onblocked = fn;
          },
        };
      },
    };

    const port = await IndexedDbStoragePort.open({
      indexedDB: wrappedFactory,
      keyRange: fakeKeyRange,
    });
    await port.append(makeEvent("e1"));
    factory.deleteRecordForTest("csu-sync", "events", 1);

    await expect(port.readPending("room-a")).rejects.toBeInstanceOf(
      StorageCorruptionError,
    );
    port.close();
  });

  it("3件以上のイベントを readAll / readPending で最後まで読み出せ、append 戻り値は5フィールドのみを持つ", async () => {
    const factory = new FakeIndexedDbFactory();
    const port = await openPort(factory);

    const extraInput = {
      ...makeEvent("e1", "room-a", "add", 1),
      extraField: "ignored",
    } as DomainEventInput;
    const appended = await port.append(extraInput);
    expect(Object.keys(appended).sort()).toEqual([
      "createdAt",
      "eventId",
      "localSeq",
      "payload",
      "roomId",
    ]);

    await port.append(makeEvent("e2", "room-a", "add", 2));
    await port.append(makeEvent("e3", "room-a", "add", 3));
    await port.append(makeEvent("e4", "room-a", "add", 4));

    expect((await port.readAll("room-a")).map((e) => e.eventId)).toEqual([
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
    expect((await port.readPending("room-a")).map((e) => e.eventId)).toEqual([
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
    port.close();
  });

  it("VersionError（上位スキーマ版）で UnsupportedStorageVersionError、meta 欠落で StorageCorruptionError を返す", async () => {
    const factory = new FakeIndexedDbFactory();
    const setupPort = await openPort(factory);
    setupPort.close();

    // meta.storageVersion が欠落している場合は StorageCorruptionError。
    factory.deleteRecordForTest("csu-sync", "meta", "storageVersion");
    await expect(openPort(factory)).rejects.toBeInstanceOf(
      StorageCorruptionError,
    );

    // 既存 DB の IndexedDB バージョンが DB_SCHEMA_VERSION より大きい場合は UnsupportedStorageVersionError。
    const upgradeReq = factory.open("csu-sync", 2);
    await new Promise<void>((resolve) => {
      upgradeReq.onsuccess = () => {
        upgradeReq.result.close();
        resolve();
      };
    });
    await expect(openPort(factory)).rejects.toBeInstanceOf(
      UnsupportedStorageVersionError,
    );
  });

  it("同時 open() の共有と、open() 失敗後の再試行が成功する", async () => {
    const factory = new FakeIndexedDbFactory();
    const port = new IndexedDbStoragePort({
      indexedDB: factory,
      keyRange: fakeKeyRange,
    });

    factory.blockNextOpen = true;
    await expect(port.open()).rejects.toBeInstanceOf(StorageBlockedError);

    // 失敗後の再試行で並行 open() が接続を共有し、同じ動作を行う。
    await Promise.all([port.open(), port.open()]);
    const stored = await port.append(makeEvent("e1"));
    expect(stored.localSeq).toBe(1);
    port.close();
  });

  it("onblocked 後に遅れて onsuccess が発火した接続は即座に close() される", async () => {
    let closedCount = 0;
    const delayedReqs: IdbOpenDbRequestLike[] = [];

    const fakeDb: IdbDatabaseLike = {
      version: 1,
      objectStoreNames: { contains: () => true },
      onversionchange: null,
      createObjectStore: () => {
        throw new Error("not implemented");
      },
      transaction: () => {
        throw new Error("not implemented");
      },
      close: () => {
        closedCount += 1;
      },
    };

    const blockedFactory: IdbFactoryLike = {
      open() {
        const req: IdbOpenDbRequestLike = {
          result: fakeDb,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          onblocked: null,
        };
        delayedReqs.push(req);
        queueMicrotask(() => {
          req.onblocked?.({});
        });
        return req;
      },
    };

    await expect(
      IndexedDbStoragePort.open({
        indexedDB: blockedFactory,
        keyRange: fakeKeyRange,
      }),
    ).rejects.toBeInstanceOf(StorageBlockedError);

    expect(closedCount).toBe(0);
    delayedReqs[0]?.onsuccess?.({});
    expect(closedCount).toBe(1);
  });

  it("open() 進行中に close() を呼ぶと後から開いた接続も閉じられてリークしない", async () => {
    const factory = new FakeIndexedDbFactory();
    let openedDbClosed = 0;
    const openSuccessCallbacks: Array<() => void> = [];
    let useRealFactory = false;

    const gatedFactory: IdbFactoryLike = {
      open(name, version) {
        if (useRealFactory) {
          return factory.open(name, version);
        }
        const innerReq = factory.open(name, version);
        let onsuccessHandler = innerReq.onsuccess;
        const proxyReq: IdbOpenDbRequestLike = {
          get result() {
            const db = innerReq.result;
            return {
              get version() {
                return db.version;
              },
              objectStoreNames: db.objectStoreNames,
              get onversionchange() {
                return db.onversionchange;
              },
              set onversionchange(fn) {
                db.onversionchange = fn;
              },
              createObjectStore: (s, opts) => db.createObjectStore(s, opts),
              transaction: (s, mode) => db.transaction(s, mode),
              close() {
                openedDbClosed += 1;
                db.close();
              },
            };
          },
          get error() {
            return innerReq.error;
          },
          get onsuccess() {
            return onsuccessHandler;
          },
          set onsuccess(fn) {
            onsuccessHandler = fn;
          },
          get onerror() {
            return innerReq.onerror;
          },
          set onerror(fn) {
            innerReq.onerror = fn;
          },
          get onupgradeneeded() {
            return innerReq.onupgradeneeded;
          },
          set onupgradeneeded(fn) {
            innerReq.onupgradeneeded = fn;
          },
          get onblocked() {
            return innerReq.onblocked;
          },
          set onblocked(fn) {
            innerReq.onblocked = fn;
          },
        };
        innerReq.onsuccess = (ev) => {
          openSuccessCallbacks.push(() => onsuccessHandler?.(ev));
        };
        return proxyReq;
      },
    };

    const port = new IndexedDbStoragePort({
      indexedDB: gatedFactory,
      keyRange: fakeKeyRange,
    });
    const openingPromise = port.open();
    // openDatabase の request 完了前に close() を呼ぶ。
    port.close();
    // マイクロタスクで innerReq.onsuccess が走った後、遅れて open 完了を通知する。
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    openSuccessCallbacks[0]?.();

    await expect(openingPromise).rejects.toThrow("closed while opening");
    expect(openedDbClosed).toBe(1);

    // 再度 open() した場合は新しい接続が正常に開ける。
    useRealFactory = true;
    await port.open();
    expect((await port.append(makeEvent("e-after-close"))).localSeq).toBe(1);
    port.close();
  });

  it("append / markSent は tx.onerror 時点では reject せず tx.onabort 後に reject する", async () => {
    const activeTxs: IdbTransactionLike[] = [];
    const txError = { name: "AbortError", message: "simulated abort" };

    const mockFactory: IdbFactoryLike = {
      open() {
        const db: IdbDatabaseLike = {
          version: 1,
          objectStoreNames: { contains: () => true },
          onversionchange: null,
          createObjectStore: () => {
            throw new Error("not implemented");
          },
          close: () => {},
          transaction(storeNames) {
            const names = typeof storeNames === "string" ? [storeNames] : storeNames;
            if (names.length === 1 && names[0] === "meta") {
              const metaTx: IdbTransactionLike = {
                error: null,
                oncomplete: null,
                onabort: null,
                onerror: null,
                objectStore: () => ({
                  createIndex: () => {
                    throw new Error("not implemented");
                  },
                  index: () => {
                    throw new Error("not implemented");
                  },
                  add: () => {
                    throw new Error("not implemented");
                  },
                  put: () => {
                    throw new Error("not implemented");
                  },
                  get: () => {
                    const req = {
                      result: { key: "storageVersion", value: "1" },
                      error: null,
                      onsuccess: null as ((ev: unknown) => void) | null,
                      onerror: null as ((ev: unknown) => void) | null,
                    };
                    queueMicrotask(() => {
                      req.onsuccess?.({});
                      metaTx.oncomplete?.({});
                    });
                    return req;
                  },
                  openCursor: () => {
                    throw new Error("not implemented");
                  },
                }),
              };
              return metaTx;
            }

            const rwTx: IdbTransactionLike = {
              error: txError,
              oncomplete: null,
              onabort: null,
              onerror: null,
              objectStore: () => ({
                createIndex: () => {
                  throw new Error("not implemented");
                },
                index: () => {
                  throw new Error("not implemented");
                },
                add: () => ({
                  result: undefined,
                  error: txError,
                  onsuccess: null,
                  onerror: null,
                }),
                put: () => ({
                  result: undefined,
                  error: txError,
                  onsuccess: null,
                  onerror: null,
                }),
                get: () => ({
                  result: undefined,
                  error: txError,
                  onsuccess: null,
                  onerror: null,
                }),
                openCursor: () => {
                  throw new Error("not implemented");
                },
              }),
            };
            activeTxs.push(rwTx);
            return rwTx;
          },
        };
        const req: IdbOpenDbRequestLike = {
          result: db,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          onblocked: null,
        };
        queueMicrotask(() => req.onsuccess?.({}));
        return req;
      },
    };

    const port = await IndexedDbStoragePort.open({
      indexedDB: mockFactory,
      keyRange: fakeKeyRange,
    });

    // append: onerror のみでは settle せず、onabort で reject する。
    let appendSettled = false;
    const appendPromise = port.append(makeEvent("e1")).catch(() => {
      appendSettled = true;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    activeTxs[0]?.onerror?.({});
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(appendSettled).toBe(false);
    activeTxs[0]?.onabort?.({});
    await appendPromise;
    expect(appendSettled).toBe(true);

    // markSent: onerror のみでは settle せず、onabort で reject する。
    let markSentSettled = false;
    const markSentPromise = port.markSent("e1", 1).catch(() => {
      markSentSettled = true;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    activeTxs[1]?.onerror?.({});
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(markSentSettled).toBe(false);
    activeTxs[1]?.onabort?.({});
    await markSentPromise;
    expect(markSentSettled).toBe(true);
  });
});
