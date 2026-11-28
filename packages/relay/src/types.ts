import type { RelayErrorCode } from "./errors.js";

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

/** 認証済み主体（#8）。 */
export interface RelayPrincipal {
  readonly subject: string;
  readonly tenantId?: string | undefined;
  readonly allowedRoomIds?: readonly string[] | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly targetIds?: readonly string[] | undefined;
  readonly operatorIds?: readonly string[] | undefined;
}

export type RelayOperation =
  | "getControl"
  | "pushEvents"
  | "connect"
  | "presence"
  | "lease"
  | "changeControl";

export type RelayEndpoint =
  | "control"
  | "events"
  | "notifications"
  | "presence"
  | "lease";

export interface RelayRequestContext {
  readonly principal?: RelayPrincipal | undefined;
  readonly tenantId?: string | undefined;
}

export interface CreateRoomOptions {
  readonly tenantId?: string | undefined;
}

export interface RelayAuthzContext {
  readonly operation: RelayOperation;
  readonly roomId: string;
  readonly tenantId: string | undefined;
  readonly principal: RelayPrincipal | undefined;
  readonly targetId?: string | undefined;
  readonly operatorId?: string | undefined;
  readonly action?: LeaseAction | undefined;
}

export type RelayAuthorizer = (context: RelayAuthzContext) => boolean;

export type InvariantDecision =
  | { readonly valid: true }
  | { readonly valid: false; readonly message: string };

export type RelayInvariantHook<T> =
  | ((context: T) => InvariantDecision | undefined)
  | ((context: T) => void);

export interface IncomingEventRecord {
  readonly eventId: string;
  readonly payload: Record<string, unknown>;
}

export interface PushEventsValidationContext {
  readonly roomId: string;
  readonly tenantId: string | undefined;
  readonly targetId: string;
  readonly controlSeq: number;
  readonly control: ControlState;
  readonly events: readonly IncomingEventRecord[];
  readonly principal: RelayPrincipal | undefined;
}

export interface ChangeControlValidationContext {
  readonly roomId: string;
  readonly tenantId: string | undefined;
  readonly operatorId: string;
  readonly targetId: string;
  readonly sendFilter: SendFilter;
  readonly currentControl: ControlState;
  readonly controlSeq: number;
  readonly principal: RelayPrincipal | undefined;
}

export interface LeaseValidationContext {
  readonly roomId: string;
  readonly tenantId: string | undefined;
  readonly operatorId: string;
  readonly action: LeaseAction;
  readonly currentControl: ControlState;
  readonly controlSeq: number;
  readonly principal: RelayPrincipal | undefined;
}

export interface RelayAuditEvent {
  readonly timestampMs: number;
  readonly operation: RelayOperation;
  readonly roomId: string;
  readonly tenantId: string | undefined;
  readonly subject: string | undefined;
  readonly requestId: string | undefined;
  readonly targetId?: string | undefined;
  readonly operatorId?: string | undefined;
  readonly outcome: "ALLOWED" | "DENIED";
  readonly errorCode?: RelayErrorCode | undefined;
}

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
  /** true の場合、すべての操作で tenantId の指定（principal または context）を必須にする。 */
  readonly requireTenant?: boolean;
  /** 認可フック（#8）。false を返すか RelayError を投げると拒否される。 */
  readonly authorize?: RelayAuthorizer;
  /** IF-002 のビジネスルール／不変条件検証フック（#8）。 */
  readonly onValidatePushEvents?: RelayInvariantHook<PushEventsValidationContext>;
  /** IF-006 のビジネスルール／不変条件検証フック（#8）。 */
  readonly onValidateChangeControl?: RelayInvariantHook<ChangeControlValidationContext>;
  /** IF-005 のビジネスルール／不変条件検証フック（#8）。 */
  readonly onValidateLease?: RelayInvariantHook<LeaseValidationContext>;
  /** 監査イベントの通知先（#8）。秘密情報・payload は含めない。 */
  readonly onAudit?: (event: RelayAuditEvent) => void;
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
