import {
  DuplicateEventError,
  type DomainEventInput,
  type EventPayload,
  type StoragePort,
  type StoredEvent,
} from "@csu/core";
import {
  StorageBlockedError,
  StorageCorruptionError,
  UnsupportedStorageVersionError,
} from "./errors";
import type {
  IdbDatabaseLike,
  IdbFactoryLike,
  IdbKeyRangeFactory,
  IdbRequestLike,
  IdbTransactionLike,
} from "./idb-types";

declare const indexedDB: IdbFactoryLike | undefined;
declare const IDBKeyRange: IdbKeyRangeFactory | undefined;

export const DEFAULT_DB_NAME = "csu-sync";
export const DB_SCHEMA_VERSION = 1;
export const STORAGE_VERSION = "1";

const STORE_META = "meta";
const STORE_EVENTS = "events";
const STORE_DELIVERY = "delivery";
const INDEX_BY_EVENT_ID = "byEventId";
const INDEX_BY_ROOM_STATUS = "byRoomStatus";

interface MetaRecord {
  readonly key: string;
  readonly value: string;
}

interface EventRecord {
  readonly localSeq: number;
  readonly eventId: string;
  readonly roomId: string;
  readonly payload: EventPayload;
  readonly createdAt: string;
}

interface DeliveryRecord {
  readonly eventId: string;
  readonly roomId: string;
  readonly localSeq: number;
  readonly status: "PENDING" | "SENT";
  readonly eventSeq: number | null;
  readonly updatedAt: string;
}

export interface IndexedDbStorageOptions {
  /** データベース名（既定 `"csu-sync"`、DS §1.3）。 */
  readonly dbName?: string;
  /** テスト注入用。省略時はグローバルの `indexedDB` を使う。 */
  readonly indexedDB?: IdbFactoryLike;
  /** テスト注入用。省略時はグローバルの `IDBKeyRange` を使う。 */
  readonly keyRange?: IdbKeyRangeFactory;
  /** `delivery.updatedAt` に設定する時刻（UTC ISO 8601）の供給元。 */
  readonly now?: () => string;
  /** 他タブによるバージョン変更（`versionchange`）で接続を閉じたときに呼ぶ。 */
  readonly onVersionChange?: () => void;
}

function isErrorNamed(
  err: { readonly name: string } | null | undefined,
  name: string,
): boolean {
  return err !== null && err !== undefined && err.name === name;
}

function toError(
  err: { readonly name: string; readonly message: string } | null | undefined,
  fallback: string,
): Error {
  if (err === null || err === undefined) {
    return new Error(fallback);
  }
  const error = new Error(err.message || fallback);
  error.name = err.name;
  return error;
}

function promisifyRequest<T>(request: IdbRequestLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(toError(request.error, "IndexedDB request failed"));
  });
}

function waitTransaction(tx: IdbTransactionLike): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(toError(tx.error, "IndexedDB transaction aborted"));
    tx.onerror = () =>
      reject(toError(tx.error, "IndexedDB transaction error"));
  });
}

/**
 * `StoragePort` の IndexedDB 実装（DS §1〜§4）。
 * - `events` と `delivery` を単一トランザクションで原子的に書き込む（DS §3.1）。
 * - `byEventId` の `ConstraintError` を `DuplicateEventError` に変換する（DS §3.2）。
 * - `meta.storageVersion` を検証し、`"1"` 以外ならデータを変更せず停止する（DS §4.1）。
 */
export class IndexedDbStoragePort implements StoragePort {
  private readonly dbName: string;
  private readonly idbFactory: IdbFactoryLike;
  private readonly keyRange: IdbKeyRangeFactory;
  private readonly now: () => string;
  private readonly onVersionChange: (() => void) | undefined;

  private db: IdbDatabaseLike | null = null;
  private opening: Promise<IdbDatabaseLike> | null = null;

  constructor(options: IndexedDbStorageOptions = {}) {
    const factory =
      options.indexedDB ??
      (typeof indexedDB !== "undefined" ? indexedDB : undefined);
    if (factory === undefined) {
      throw new Error("IndexedDB is not available in this environment");
    }
    const range =
      options.keyRange ??
      (typeof IDBKeyRange !== "undefined" ? IDBKeyRange : undefined);
    if (range === undefined) {
      throw new Error("IDBKeyRange is not available in this environment");
    }
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.idbFactory = factory;
    this.keyRange = range;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onVersionChange = options.onVersionChange;
  }

  /** データベースを開き、`meta.storageVersion` を検証したインスタンスを返す。 */
  static async open(
    options: IndexedDbStorageOptions = {},
  ): Promise<IndexedDbStoragePort> {
    const port = new IndexedDbStoragePort(options);
    await port.ensureOpen();
    return port;
  }

  /** データベースを開き、`meta.storageVersion` を検証する。既に開いている場合は再利用する。 */
  async open(): Promise<void> {
    await this.ensureOpen();
  }

  /** データベース接続を閉じる。 */
  close(): void {
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
    this.opening = null;
  }

  /** DS §3.1: `events` への追記と `delivery`（`PENDING`）作成を単一トランザクションで行う。 */
  async append(event: DomainEventInput): Promise<StoredEvent> {
    const db = await this.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_EVENTS, STORE_DELIVERY], "readwrite");
      const eventsStore = tx.objectStore(STORE_EVENTS);
      const deliveryStore = tx.objectStore(STORE_DELIVERY);

      let assignedSeq: number | null = null;
      let duplicate = false;
      let failure: Error | null = null;

      const addEventReq = eventsStore.add({
        eventId: event.eventId,
        roomId: event.roomId,
        payload: event.payload,
        createdAt: event.createdAt,
      });

      addEventReq.onerror = () => {
        if (isErrorNamed(addEventReq.error, "ConstraintError")) {
          duplicate = true;
        } else {
          failure = toError(addEventReq.error, "failed to append event");
        }
      };

      addEventReq.onsuccess = () => {
        const localSeq = addEventReq.result;
        if (typeof localSeq !== "number") {
          failure = new StorageCorruptionError("invalid localSeq generated");
          tx.abort?.();
          return;
        }
        assignedSeq = localSeq;
        const addDeliveryReq = deliveryStore.add({
          eventId: event.eventId,
          roomId: event.roomId,
          localSeq,
          status: "PENDING",
          eventSeq: null,
          updatedAt: this.now(),
        } satisfies DeliveryRecord);
        addDeliveryReq.onerror = () => {
          if (isErrorNamed(addDeliveryReq.error, "ConstraintError")) {
            duplicate = true;
          } else {
            failure = toError(
              addDeliveryReq.error,
              "failed to create delivery record",
            );
          }
        };
      };

      // DS §3.1 の 3: 呼び出し元への成功の通知は、トランザクションの complete 後に行う。
      tx.oncomplete = () => {
        if (assignedSeq === null) {
          reject(new StorageCorruptionError("append completed without localSeq"));
          return;
        }
        resolve({
          ...event,
          localSeq: assignedSeq,
        });
      };

      const rejectTx = () => {
        if (duplicate || isErrorNamed(tx.error, "ConstraintError")) {
          reject(new DuplicateEventError(event.eventId));
          return;
        }
        reject(failure ?? toError(tx.error, "append transaction aborted"));
      };

      tx.onabort = rejectTx;
      tx.onerror = rejectTx;
    });
  }

  /** 指定した Room のイベントを `localSeq` の昇順で返す。 */
  async readAll(roomId: string): Promise<readonly StoredEvent[]> {
    const db = await this.ensureOpen();
    const tx = db.transaction([STORE_EVENTS], "readonly");
    const eventsStore = tx.objectStore(STORE_EVENTS);
    const results: StoredEvent[] = [];

    const txDone = waitTransaction(tx);
    await new Promise<void>((resolve, reject) => {
      const req = eventsStore.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor === null) {
          resolve();
          return;
        }
        const record = cursor.value as EventRecord;
        if (record.roomId === roomId) {
          results.push({
            localSeq: record.localSeq,
            eventId: record.eventId,
            roomId: record.roomId,
            payload: record.payload,
            createdAt: record.createdAt,
          });
        }
        cursor.continue();
      };
      req.onerror = () =>
        reject(toError(req.error, "failed to read events cursor"));
    });

    await txDone;
    return results;
  }

  /**
   * 指定した Room の未送信（`PENDING`）イベントを `localSeq` の昇順で返す。
   * 複合インデックス `byRoomStatus`（`["roomId", "status", "localSeq"]`）を使う。
   */
  async readPending(roomId: string): Promise<readonly StoredEvent[]> {
    const db = await this.ensureOpen();
    const tx = db.transaction([STORE_EVENTS, STORE_DELIVERY], "readonly");
    const eventsStore = tx.objectStore(STORE_EVENTS);
    const deliveryStore = tx.objectStore(STORE_DELIVERY);
    const index = deliveryStore.index(INDEX_BY_ROOM_STATUS);
    const eventsById = eventsStore.index(INDEX_BY_EVENT_ID);
    const range = this.keyRange.bound(
      [roomId, "PENDING", 0],
      [roomId, "PENDING", Number.MAX_SAFE_INTEGER],
    );

    const txDone = waitTransaction(tx);
    const eventLookups: Promise<{ eventId: string; record: EventRecord | undefined }>[] =
      [];
    // トランザクションが不活性化しないよう、カーソル反復中に同期的に get リクエストを発行する。
    await new Promise<void>((resolve, reject) => {
      const req = index.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor === null) {
          resolve();
          return;
        }
        const delivery = cursor.value as DeliveryRecord;
        eventLookups.push(
          promisifyRequest(eventsById.get(delivery.eventId)).then((record) => ({
            eventId: delivery.eventId,
            record: record as EventRecord | undefined,
          })),
        );
        cursor.continue();
      };
      req.onerror = () =>
        reject(toError(req.error, "failed to read pending deliveries"));
    });

    const lookedUp = await Promise.all(eventLookups);
    const results: StoredEvent[] = [];
    for (const { eventId, record } of lookedUp) {
      if (record === undefined) {
        tx.abort?.();
        throw new StorageCorruptionError(
          `missing event record for delivery: ${eventId}`,
        );
      }
      results.push({
        localSeq: record.localSeq,
        eventId: record.eventId,
        roomId: record.roomId,
        payload: record.payload,
        createdAt: record.createdAt,
      });
    }

    await txDone;
    return results;
  }

  /**
   * DS §3.1: `PENDING` → `SENT` の一方向更新を単一トランザクションで行う。
   * 既に `SENT` の場合は何もしない（冪等）。未知の `eventId` はエラーを返す。
   */
  async markSent(eventId: string, eventSeq: number): Promise<void> {
    const db = await this.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DELIVERY], "readwrite");
      const deliveryStore = tx.objectStore(STORE_DELIVERY);
      let failure: Error | null = null;

      const getReq = deliveryStore.get(eventId);
      getReq.onerror = () => {
        failure = toError(getReq.error, "failed to read delivery record");
      };
      getReq.onsuccess = () => {
        const record = getReq.result as DeliveryRecord | undefined;
        if (record === undefined) {
          failure = new Error(`unknown event: ${eventId}`);
          tx.abort?.();
          return;
        }
        if (record.status === "SENT") {
          return;
        }
        const putReq = deliveryStore.put({
          ...record,
          status: "SENT",
          eventSeq,
          updatedAt: this.now(),
        } satisfies DeliveryRecord);
        putReq.onerror = () => {
          failure = toError(putReq.error, "failed to update delivery record");
        };
      };

      tx.oncomplete = () => resolve();
      const rejectTx = () =>
        reject(failure ?? toError(tx.error, "markSent transaction aborted"));
      tx.onabort = rejectTx;
      tx.onerror = rejectTx;
    });
  }

  // ---- 内部 ----

  private ensureOpen(): Promise<IdbDatabaseLike> {
    if (this.db !== null) {
      return Promise.resolve(this.db);
    }
    if (this.opening !== null) {
      return this.opening;
    }
    this.opening = this.openDatabase().catch((error) => {
      this.opening = null;
      throw error;
    });
    return this.opening;
  }

  private async openDatabase(): Promise<IdbDatabaseLike> {
    const db = await new Promise<IdbDatabaseLike>((resolve, reject) => {
      const req = this.idbFactory.open(this.dbName, DB_SCHEMA_VERSION);

      req.onupgradeneeded = (event) => {
        const upgradeDb = req.result;
        if (event.oldVersion === 0) {
          if (!upgradeDb.objectStoreNames.contains(STORE_META)) {
            const meta = upgradeDb.createObjectStore(STORE_META, {
              keyPath: "key",
            });
            meta.put({
              key: "storageVersion",
              value: STORAGE_VERSION,
            } satisfies MetaRecord);
          }
          if (!upgradeDb.objectStoreNames.contains(STORE_EVENTS)) {
            const events = upgradeDb.createObjectStore(STORE_EVENTS, {
              keyPath: "localSeq",
              autoIncrement: true,
            });
            events.createIndex(INDEX_BY_EVENT_ID, "eventId", { unique: true });
          }
          if (!upgradeDb.objectStoreNames.contains(STORE_DELIVERY)) {
            const delivery = upgradeDb.createObjectStore(STORE_DELIVERY, {
              keyPath: "eventId",
            });
            delivery.createIndex(
              INDEX_BY_ROOM_STATUS,
              ["roomId", "status", "localSeq"],
              { unique: false },
            );
          }
        }
      };

      req.onblocked = () => {
        reject(new StorageBlockedError());
      };

      req.onerror = () => {
        if (isErrorNamed(req.error, "VersionError")) {
          reject(new UnsupportedStorageVersionError("newer-db", STORAGE_VERSION));
          return;
        }
        reject(toError(req.error, "failed to open IndexedDB"));
      };

      req.onsuccess = () => {
        resolve(req.result);
      };
    });

    try {
      await this.verifyStorageVersion(db);
    } catch (error) {
      db.close();
      throw error;
    }

    db.onversionchange = () => {
      db.close();
      if (this.db === db) {
        this.db = null;
        this.opening = null;
      }
      this.onVersionChange?.();
    };

    this.db = db;
    return db;
  }

  private async verifyStorageVersion(db: IdbDatabaseLike): Promise<void> {
    if (
      !db.objectStoreNames.contains(STORE_META) ||
      !db.objectStoreNames.contains(STORE_EVENTS) ||
      !db.objectStoreNames.contains(STORE_DELIVERY)
    ) {
      throw new StorageCorruptionError(
        "required IndexedDB object stores are missing",
      );
    }

    const tx = db.transaction([STORE_META], "readonly");
    const txDone = waitTransaction(tx);
    const meta = tx.objectStore(STORE_META);
    const record = (await promisifyRequest(meta.get("storageVersion"))) as
      | MetaRecord
      | undefined;
    await txDone;

    if (record === undefined) {
      throw new StorageCorruptionError("meta.storageVersion is missing");
    }
    if (record.value !== STORAGE_VERSION) {
      throw new UnsupportedStorageVersionError(record.value, STORAGE_VERSION);
    }
  }
}
