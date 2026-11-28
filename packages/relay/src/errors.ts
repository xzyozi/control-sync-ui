/** IF/API仕様書 §2.2、§3 のエラーコードと、HTTP ステータスの割り当て。 */
export const ERROR_STATUS = {
  INVALID_MESSAGE: 400,
  SCHEMA_VERSION_MISMATCH: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  LOCK_NOT_HELD: 403,
  ROOM_NOT_FOUND: 404,
  STALE_CONTROL_SEQ: 409,
  LOCK_HELD_BY_OTHER: 409,
  TARGET_OFFLINE: 409,
  INVARIANT_VIOLATION: 422,
} as const;

export type RelayErrorCode = keyof typeof ERROR_STATUS;

/** サーバーが、IF の契約に従って返すエラー。 */
export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly httpStatus: number;
  /** `STALE_CONTROL_SEQ` のときだけ、サーバーの最新値を持つ（IF §2.2）。 */
  readonly controlSeq: number | undefined;

  constructor(code: RelayErrorCode, message: string, controlSeq?: number) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.httpStatus = ERROR_STATUS[code];
    this.controlSeq = controlSeq;
  }
}
