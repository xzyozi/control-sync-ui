/** 共通項目（IF §2.2）。HTTP ではヘッダー、SSE ではクエリパラメータで届く。 */
export interface Envelope {
  readonly schemaVersion?: string | undefined;
  readonly requestId?: string | undefined;
}

/** 送信対象フィルタ（DD §2.3）。 */
export interface SendFilter {
  readonly mode: "ALL" | "NONE" | "TYPES";
  readonly types?: readonly string[];
  readonly targetIds?: readonly string[];
}

/** 制御状態（IF-001 の `control`）。 */
export interface ControlState {
  readonly sendFilter: SendFilter;
  /** 現在の操作権限者。なしの場合は null。 */
  readonly holderId: string | null;
}

export type NotificationType = "CONTROL_UPDATED" | "EVENTS_APPENDED";

/** 更新通知（IF-003 の `data`）。 */
export interface Notification {
  readonly schemaVersion: string;
  readonly type: NotificationType;
  readonly controlSeq: number;
  readonly eventSeq?: number;
}

export type NotificationListener = (notification: Notification) => void;

/** lease の操作（IF-005）。 */
export type LeaseAction = "ACQUIRE" | "RENEW" | "RELEASE";

export interface RelayOptions {
  /**
   * 通知の listener が例外を投げたときに呼ぶ。状態の更新は済んでいるので、
   * 例外は呼び出し元に返さず、ここへ渡す。省略した場合は、標準エラーに出力する。
   */
  readonly onListenerError?: (error: unknown) => void;
  /** 現在時刻（ミリ秒）の供給元。テストで固定できる。 */
  readonly now?: () => number;
  readonly schemaVersion?: string;
  readonly leaseTtlMs?: number;
  readonly presenceTtlMs?: number;
  readonly requestIdRetentionMs?: number;
}

export interface ControlSnapshot {
  readonly controlSeq: number;
  readonly control: ControlState;
}

export interface LeaseResult {
  readonly holderId: string | null;
  readonly controlSeq: number;
}

export interface AcceptedEvent {
  readonly eventId: string;
  readonly eventSeq: number;
}
