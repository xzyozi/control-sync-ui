/** 保存形式の版がサポート対象外（DS §4.1、TC-203）。データを変更せず停止する。 */
export class UnsupportedStorageVersionError extends Error {
  readonly foundVersion: string | null;
  readonly expectedVersion: string;

  constructor(foundVersion: string | null, expectedVersion = "1") {
    super(
      `unsupported storageVersion: expected "${expectedVersion}", got ${foundVersion === null ? "null" : `"${foundVersion}"`}`,
    );
    this.name = "UnsupportedStorageVersionError";
    this.foundVersion = foundVersion;
    this.expectedVersion = expectedVersion;
  }
}

/** `events` と `delivery` の不整合など、永続化データの破損を検出した（DS §3.1）。 */
export class StorageCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageCorruptionError";
  }
}

/** 別タブの古い接続が閉じられず、DB の開錠・移行が待たされた（DS §3.2）。 */
export class StorageBlockedError extends Error {
  constructor(message = "IndexedDB open blocked by another connection") {
    super(message);
    this.name = "StorageBlockedError";
  }
}
