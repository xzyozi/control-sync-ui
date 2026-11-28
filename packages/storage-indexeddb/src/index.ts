export {
  StorageBlockedError,
  StorageCorruptionError,
  UnsupportedStorageVersionError,
} from "./errors.js";
export type {
  IdbCursorLike,
  IdbDatabaseLike,
  IdbFactoryLike,
  IdbIndexLike,
  IdbKeyRangeFactory,
  IdbObjectStoreLike,
  IdbObjectStoreNamesLike,
  IdbOpenDbRequestLike,
  IdbRequestLike,
  IdbTransactionLike,
} from "./idb-types.js";
export {
  DB_SCHEMA_VERSION,
  DEFAULT_DB_NAME,
  IndexedDbStoragePort,
  STORAGE_VERSION,
} from "./indexeddb-storage.js";
export type { IndexedDbStorageOptions } from "./indexeddb-storage.js";
