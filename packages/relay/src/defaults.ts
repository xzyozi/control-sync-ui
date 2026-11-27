/** 実装の既定値（DD §1.3）。値の変更は、DD の改訂で行う。 */
export const DEFAULTS = {
  /** v0.1 の schemaVersion（DD §2.3）。 */
  schemaVersion: "1",
  /** V-01: lease の TTL（30 秒）。 */
  leaseTtlMs: 30_000,
  /** V-03: presence の TTL（15 秒）。lease とは独立。 */
  presenceTtlMs: 15_000,
  /** V-08: requestId ごとの最初の応答の保持期間（10 分）。 */
  requestIdRetentionMs: 600_000,
} as const;
