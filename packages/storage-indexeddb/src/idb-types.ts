// lib に DOM を含めず、使う分の IndexedDB API の型だけをここで定義する。

export interface IdbRequestLike<T = unknown> {
  readonly result: T;
  readonly error: { readonly name: string; readonly message: string } | null;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface IdbOpenDbRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: ((event: { readonly oldVersion: number }) => void) | null;
  onblocked: ((event: unknown) => void) | null;
}

export interface IdbCursorLike {
  readonly value: unknown;
  continue(): void;
}

export interface IdbIndexLike {
  get(key: unknown): IdbRequestLike<unknown>;
  openCursor(range?: unknown): IdbRequestLike<IdbCursorLike | null>;
}

export interface IdbObjectStoreLike {
  createIndex(
    name: string,
    keyPath: string | string[],
    options?: { readonly unique?: boolean },
  ): IdbIndexLike;
  index(name: string): IdbIndexLike;
  add(value: unknown): IdbRequestLike<unknown>;
  put(value: unknown): IdbRequestLike<unknown>;
  get(key: unknown): IdbRequestLike<unknown>;
  openCursor(range?: unknown): IdbRequestLike<IdbCursorLike | null>;
}

export interface IdbTransactionLike {
  readonly error: { readonly name: string; readonly message: string } | null;
  oncomplete: ((event: unknown) => void) | null;
  onabort: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  objectStore(name: string): IdbObjectStoreLike;
  abort?(): void;
}

export interface IdbObjectStoreNamesLike {
  contains(name: string): boolean;
}

export interface IdbDatabaseLike {
  readonly version: number;
  readonly objectStoreNames: IdbObjectStoreNamesLike;
  onversionchange: ((event: unknown) => void) | null;
  createObjectStore(
    name: string,
    options?: { readonly keyPath?: string; readonly autoIncrement?: boolean },
  ): IdbObjectStoreLike;
  transaction(
    storeNames: string | readonly string[],
    mode?: "readonly" | "readwrite",
  ): IdbTransactionLike;
  close(): void;
}

export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenDbRequestLike;
}

export interface IdbKeyRangeFactory {
  bound(lower: unknown, upper: unknown): unknown;
}
