import type {
  IdbCursorLike,
  IdbDatabaseLike,
  IdbFactoryLike,
  IdbIndexLike,
  IdbKeyRangeFactory,
  IdbObjectStoreLike,
  IdbOpenDbRequestLike,
  IdbRequestLike,
  IdbTransactionLike,
} from "../src/index";

declare function queueMicrotask(callback: () => void): void;

interface FakeIndexDef {
  readonly name: string;
  readonly keyPath: string | string[];
  readonly unique: boolean;
}

interface FakeStoreData {
  readonly name: string;
  readonly keyPath: string;
  readonly autoIncrement: boolean;
  nextAutoSeq: number;
  records: Map<unknown, Record<string, unknown>>;
  indexes: Map<string, FakeIndexDef>;
}

interface FakeBoundRange {
  readonly lower: unknown;
  readonly upper: unknown;
}

export const fakeKeyRange: IdbKeyRangeFactory = {
  bound: (lower, upper): FakeBoundRange => ({ lower, upper }),
};

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function extractKey(record: Record<string, unknown>, keyPath: string | string[]): unknown {
  if (typeof keyPath === "string") {
    return record[keyPath];
  }
  return keyPath.map((field) => record[field]);
}

function compareValues(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      const cmp = compareValues(a[i], b[i]);
      if (cmp !== 0) {
        return cmp;
      }
    }
    return a.length - b.length;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function keysEqual(a: unknown, b: unknown): boolean {
  return compareValues(a, b) === 0;
}

function inRange(key: unknown, range: unknown): boolean {
  if (range === undefined) {
    return true;
  }
  const b = range as FakeBoundRange;
  return compareValues(key, b.lower) >= 0 && compareValues(key, b.upper) <= 0;
}

function makeDomError(name: string, message: string) {
  return { name, message };
}

/**
 * トランザクションの原子性（rollback）・一意インデックス（ConstraintError）・
 * 複合インデックス・`blocked`/`versionchange` を再現するテスト用 IndexedDB。
 */
export class FakeIndexedDbFactory implements IdbFactoryLike {
  private readonly databases = new Map<
    string,
    { version: number; stores: Map<string, FakeStoreData> }
  >();
  private readonly openConnections = new Map<string, Set<FakeDatabase>>();

  /** 次の特定ストア操作で強制的にエラー（または中絶）を発生させるフック。 */
  onStoreWrite?: (storeName: string, op: "add" | "put") => { name: string; message: string } | null;
  blockNextOpen = false;

  open(name: string, requestedVersion = 1): IdbOpenDbRequestLike {
    let resultDb!: FakeDatabase;
    const req: IdbOpenDbRequestLike = {
      get result() {
        return resultDb;
      },
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };

    queueMicrotask(() => {
      if (this.blockNextOpen) {
        this.blockNextOpen = false;
        req.onblocked?.({});
        return;
      }

      const existing = this.databases.get(name);
      const oldVersion = existing?.version ?? 0;
      if (existing !== undefined && requestedVersion < existing.version) {
        (req as { error: { name: string; message: string } }).error = makeDomError(
          "VersionError",
          "The requested version is less than the existing version",
        );
        req.onerror?.({});
        return;
      }

      if (existing === undefined) {
        this.databases.set(name, {
          version: requestedVersion,
          stores: new Map(),
        });
      } else if (requestedVersion > existing.version) {
        const active = this.openConnections.get(name);
        if (active !== undefined) {
          for (const conn of [...active]) {
            conn.onversionchange?.({});
          }
        }
        existing.version = requestedVersion;
      }

      const dbState = this.databases.get(name);
      if (dbState === undefined) {
        return;
      }
      resultDb = new FakeDatabase(this, dbState, () => {
        this.openConnections.get(name)?.delete(resultDb);
      });
      let set = this.openConnections.get(name);
      if (set === undefined) {
        set = new Set();
        this.openConnections.set(name, set);
      }
      set.add(resultDb);

      if (requestedVersion > oldVersion) {
        try {
          req.onupgradeneeded?.({ oldVersion });
        } catch (error) {
          (req as { error: { name: string; message: string } }).error = makeDomError(
            "AbortError",
            error instanceof Error ? error.message : "upgrade aborted",
          );
          req.onerror?.({});
          return;
        }
      }
      req.onsuccess?.({});
    });

    return req;
  }

  /** テスト用: 指定データベース・ストアの現在の確定済みレコード数を返す。 */
  countRecords(dbName: string, storeName: string): number {
    return this.databases.get(dbName)?.stores.get(storeName)?.records.size ?? 0;
  }

  /** テスト用: 確定済みの全レコードを返す。 */
  dumpRecords(dbName: string, storeName: string): Record<string, unknown>[] {
    const store = this.databases.get(dbName)?.stores.get(storeName);
    if (store === undefined) {
      return [];
    }
    return [...store.records.values()].map((r) => cloneValue(r));
  }

  /** テスト用: meta などのレコードを直接書き換える（TC-203 用）。 */
  seedMeta(dbName: string, key: string, value: string): void {
    const store = this.databases.get(dbName)?.stores.get("meta");
    if (store === undefined) {
      throw new Error("meta store not initialized");
    }
    store.records.set(key, { key, value });
  }

  /** テスト用: 指定レコードを削除して破損状態を再現する。 */
  deleteRecordForTest(dbName: string, storeName: string, key: unknown): void {
    this.databases.get(dbName)?.stores.get(storeName)?.records.delete(key);
  }
}

class FakeDatabase implements IdbDatabaseLike {
  onversionchange: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(
    private readonly factory: FakeIndexedDbFactory,
    private readonly state: { version: number; stores: Map<string, FakeStoreData> },
    private readonly onClose: () => void,
  ) {}

  get version(): number {
    return this.state.version;
  }

  readonly objectStoreNames = {
    contains: (name: string) => this.state.stores.has(name),
  };

  createObjectStore(
    name: string,
    options: { readonly keyPath?: string; readonly autoIncrement?: boolean } = {},
  ): IdbObjectStoreLike {
    const store: FakeStoreData = {
      name,
      keyPath: options.keyPath ?? "id",
      autoIncrement: options.autoIncrement ?? false,
      nextAutoSeq: 1,
      records: new Map(),
      indexes: new Map(),
    };
    this.state.stores.set(name, store);
    return new FakeObjectStore(this.factory, store, null);
  }

  transaction(
    storeNames: string | readonly string[],
    mode: "readonly" | "readwrite" = "readonly",
  ): IdbTransactionLike {
    const names = typeof storeNames === "string" ? [storeNames] : storeNames;
    return new FakeTransaction(this.factory, this.state.stores, names, mode);
  }

  close(): void {
    this.closed = true;
    this.onClose();
  }
}

class FakeTransaction implements IdbTransactionLike {
  error: { readonly name: string; readonly message: string } | null = null;
  oncomplete: ((event: unknown) => void) | null = null;
  onabort: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private readonly workingStores = new Map<string, FakeStoreData>();
  private aborted = false;
  private finished = false;
  private pendingOps = 0;

  constructor(
    private readonly factory: FakeIndexedDbFactory,
    private readonly committedStores: Map<string, FakeStoreData>,
    storeNames: readonly string[],
    private readonly mode: "readonly" | "readwrite",
  ) {
    for (const name of storeNames) {
      const original = committedStores.get(name);
      if (original === undefined) {
        throw new Error(`unknown store: ${name}`);
      }
      // トランザクション中はコピーへ書き込み、complete 時のみコミットする（原子性の再現）。
      this.workingStores.set(name, {
        name: original.name,
        keyPath: original.keyPath,
        autoIncrement: original.autoIncrement,
        nextAutoSeq: original.nextAutoSeq,
        records: new Map(
          [...original.records.entries()].map(([k, v]) => [k, cloneValue(v)]),
        ),
        indexes: original.indexes,
      });
    }
    queueMicrotask(() => this.tryFinish());
  }

  objectStore(name: string): IdbObjectStoreLike {
    const store = this.workingStores.get(name);
    if (store === undefined) {
      throw new Error(`store not in transaction scope: ${name}`);
    }
    return new FakeObjectStore(this.factory, store, this);
  }

  abort(): void {
    if (this.finished || this.aborted) {
      return;
    }
    this.aborted = true;
    if (this.error === null) {
      this.error = makeDomError("AbortError", "transaction aborted");
    }
    queueMicrotask(() => this.finalizeAbort());
  }

  beginOp(): void {
    this.pendingOps += 1;
  }

  endOp(err?: { readonly name: string; readonly message: string }): void {
    this.pendingOps -= 1;
    if (err !== undefined && !this.aborted) {
      this.error = err;
      this.aborted = true;
      queueMicrotask(() => this.finalizeAbort());
      return;
    }
    queueMicrotask(() => this.tryFinish());
  }

  isReadOnly(): boolean {
    return this.mode === "readonly";
  }

  private finalizeAbort(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    // workingStores を破棄することでロールバックとなる。
    this.onerror?.({});
    this.onabort?.({});
  }

  private tryFinish(): void {
    if (this.finished || this.aborted || this.pendingOps > 0) {
      return;
    }
    this.finished = true;
    if (this.mode === "readwrite") {
      for (const [name, working] of this.workingStores) {
        const target = this.committedStores.get(name);
        if (target !== undefined) {
          target.nextAutoSeq = working.nextAutoSeq;
          target.records = working.records;
        }
      }
    }
    this.oncomplete?.({});
  }
}

class FakeObjectStore implements IdbObjectStoreLike {
  constructor(
    private readonly factory: FakeIndexedDbFactory,
    private readonly store: FakeStoreData,
    private readonly tx: FakeTransaction | null,
  ) {}

  createIndex(
    name: string,
    keyPath: string | string[],
    options: { readonly unique?: boolean } = {},
  ): IdbIndexLike {
    const def: FakeIndexDef = {
      name,
      keyPath,
      unique: options.unique ?? false,
    };
    this.store.indexes.set(name, def);
    return new FakeIndex(this.store, def, this.tx);
  }

  index(name: string): IdbIndexLike {
    const def = this.store.indexes.get(name);
    if (def === undefined) {
      throw new Error(`unknown index: ${name}`);
    }
    return new FakeIndex(this.store, def, this.tx);
  }

  add(value: unknown): IdbRequestLike<unknown> {
    return this.write("add", value as Record<string, unknown>);
  }

  put(value: unknown): IdbRequestLike<unknown> {
    return this.write("put", value as Record<string, unknown>);
  }

  get(key: unknown): IdbRequestLike<unknown> {
    const req: IdbRequestLike<unknown> = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    this.tx?.beginOp();
    queueMicrotask(() => {
      const found = this.store.records.get(key);
      (req as { result: unknown }).result =
        found === undefined ? undefined : cloneValue(found);
      req.onsuccess?.({});
      this.tx?.endOp();
    });
    return req;
  }

  openCursor(range?: unknown): IdbRequestLike<IdbCursorLike | null> {
    const entries = [...this.store.records.entries()]
      .filter(([k]) => inRange(k, range))
      .sort(([a], [b]) => compareValues(a, b))
      .map(([, v]) => cloneValue(v));
    return driveCursor(entries, this.tx);
  }

  private write(
    op: "add" | "put",
    input: Record<string, unknown>,
  ): IdbRequestLike<unknown> {
    const req: IdbRequestLike<unknown> = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    if (this.tx?.isReadOnly()) {
      throw new Error("ReadOnlyError");
    }
    this.tx?.beginOp();
    const run = () => {
      const injected = this.factory.onStoreWrite?.(this.store.name, op) ?? null;
      if (injected !== null) {
        (req as { error: { name: string; message: string } }).error = injected;
        req.onerror?.({});
        this.tx?.endOp(injected);
        return;
      }

      const record = cloneValue(input);
      let pk = record[this.store.keyPath];
      if (pk === undefined && this.store.autoIncrement) {
        pk = this.store.nextAutoSeq;
        this.store.nextAutoSeq += 1;
        record[this.store.keyPath] = pk;
      }

      if (op === "add" && this.store.records.has(pk)) {
        const err = makeDomError("ConstraintError", "primary key already exists");
        (req as { error: { name: string; message: string } }).error = err;
        req.onerror?.({});
        this.tx?.endOp(err);
        return;
      }

      for (const index of this.store.indexes.values()) {
        if (!index.unique) {
          continue;
        }
        const newIdxKey = extractKey(record, index.keyPath);
        for (const [existingPk, existingRec] of this.store.records) {
          if (op === "put" && keysEqual(existingPk, pk)) {
            continue;
          }
          if (keysEqual(extractKey(existingRec, index.keyPath), newIdxKey)) {
            const err = makeDomError(
              "ConstraintError",
              `unique index violation on ${index.name}`,
            );
            (req as { error: { name: string; message: string } }).error = err;
            req.onerror?.({});
            this.tx?.endOp(err);
            return;
          }
        }
      }

      this.store.records.set(pk, record);
      (req as { result: unknown }).result = pk;
      req.onsuccess?.({});
      this.tx?.endOp();
    };

    if (this.tx === null) {
      run();
    } else {
      queueMicrotask(run);
    }
    return req;
  }
}

class FakeIndex implements IdbIndexLike {
  constructor(
    private readonly store: FakeStoreData,
    private readonly def: FakeIndexDef,
    private readonly tx: FakeTransaction | null,
  ) {}

  get(key: unknown): IdbRequestLike<unknown> {
    const req: IdbRequestLike<unknown> = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    this.tx?.beginOp();
    queueMicrotask(() => {
      const sorted = [...this.store.records.entries()].sort(([a], [b]) =>
        compareValues(a, b),
      );
      let found: Record<string, unknown> | undefined;
      for (const [, rec] of sorted) {
        if (keysEqual(extractKey(rec, this.def.keyPath), key)) {
          found = cloneValue(rec);
          break;
        }
      }
      (req as { result: unknown }).result = found;
      req.onsuccess?.({});
      this.tx?.endOp();
    });
    return req;
  }

  openCursor(range?: unknown): IdbRequestLike<IdbCursorLike | null> {
    const entries = [...this.store.records.entries()]
      .map(([pk, rec]) => ({
        pk,
        idxKey: extractKey(rec, this.def.keyPath),
        rec,
      }))
      .filter(({ idxKey }) => inRange(idxKey, range))
      .sort((a, b) => {
        const cmp = compareValues(a.idxKey, b.idxKey);
        return cmp !== 0 ? cmp : compareValues(a.pk, b.pk);
      })
      .map(({ rec }) => cloneValue(rec));
    return driveCursor(entries, this.tx);
  }
}

function driveCursor(
  entries: Record<string, unknown>[],
  tx: FakeTransaction | null,
): IdbRequestLike<IdbCursorLike | null> {
  let cursorPos = 0;
  let currentCursor: IdbCursorLike | null = null;
  const req: IdbRequestLike<IdbCursorLike | null> = {
    get result() {
      return currentCursor;
    },
    error: null,
    onsuccess: null,
    onerror: null,
  };

  const step = () => {
    if (cursorPos >= entries.length) {
      currentCursor = null;
      req.onsuccess?.({});
      tx?.endOp();
      return;
    }
    const value = entries[cursorPos];
    cursorPos += 1;
    currentCursor = {
      value,
      continue: () => {
        tx?.beginOp();
        queueMicrotask(step);
        tx?.endOp();
      },
    };
    req.onsuccess?.({});
    tx?.endOp();
  };

  tx?.beginOp();
  queueMicrotask(step);
  return req;
}
