import type { ControlState, StoredEvent } from "./types.js";

/** サーバーからの通知（IF-003 の `data`）。 */
export interface ServerNotification {
  readonly type: "CONTROL_UPDATED" | "EVENTS_APPENDED";
  readonly controlSeq: number;
  readonly eventSeq?: number;
}

/** IF-001 の応答。 */
export interface ControlSnapshot {
  readonly controlSeq: number;
  readonly control: ControlState;
}

/** IF-002 の応答で、受理されたイベント。 */
export interface AcceptedEvent {
  readonly eventId: string;
  readonly eventSeq: number;
}

/** サーバーが返すエラーコード（IF §2.2）。 */
export type ServerErrorCode =
  | "INVALID_MESSAGE"
  | "SCHEMA_VERSION_MISMATCH"
  | "LOCK_NOT_HELD"
  | "ROOM_NOT_FOUND"
  | "STALE_CONTROL_SEQ"
  | "LOCK_HELD_BY_OTHER"
  | "TARGET_OFFLINE";

/** TransportPort が返し得るエラーコード（IF §2.2 および通信層の分類）。 */
export type TransportErrorCode =
  | ServerErrorCode
  | "INVALID_RESPONSE"
  | `HTTP_${number}`;

/**
 * サーバーが返したエラー、または通信の失敗（IF §2.2、DD §4.1）。
 * `code` が undefined の場合は、通信の失敗（接続の失敗、タイムアウト、HTTP 5xx）。
 */
export class TransportError extends Error {
  /** IF のエラーコード（`STALE_CONTROL_SEQ` など）。通信の失敗の場合は undefined。 */
  readonly code: TransportErrorCode | undefined;
  /** `STALE_CONTROL_SEQ` のときの、サーバーの最新値。 */
  readonly controlSeq: number | undefined;

  constructor(
    message: string,
    code?: TransportErrorCode,
    controlSeq?: number,
  ) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.controlSeq = controlSeq;
  }

  /** 通信の失敗（再試行してよい一時的な障害）か。 */
  get isNetworkFailure(): boolean {
    return this.code === undefined;
  }
}

/** 更新通知の接続（IF-003）。`close()` で切断する。通知は `connect()` に渡す handlers で受け取る。 */
export interface NotificationConnection {
  /** 接続を閉じる。 */
  close(): void;
}

export interface ConnectionHandlers {
  /** 接続が開いた（初回と、自動再接続）。 */
  readonly onOpen: () => void;
  readonly onNotification: (notification: ServerNotification) => void;
  /**
   * 接続が切れた。`closed` が true の場合は、再接続されない（EventSource の
   * `CLOSED`）。`code` が渡された場合（通知の `SCHEMA_VERSION_MISMATCH` など）は、
   * そのコードで原因を判別できる。それ以外の `closed` は、IF-001 を実行して原因を判別する。
   */
  readonly onError: (info: {
    readonly closed: boolean;
    readonly code?: TransportErrorCode;
  }) => void;
}

/**
 * 通信の抽象（BD C-006）。HTTP と SSE の実装は `transport-http` が担う（OP-08）。
 * `core` は、ブラウザ API や通信プロトコルの実装詳細を持たない（CN-02）。
 * すべての呼び出しで、`requestId` を共通項目として渡す。再試行では、同じ値を使う。
 */
export interface TransportPort {
  /** IF-001: 制御状態の取得。 */
  fetchControl(args: {
    readonly roomId: string;
    readonly targetId: string;
    readonly requestId: string;
  }): Promise<ControlSnapshot>;

  /** IF-002: イベントの送信。 */
  pushEvents(args: {
    readonly roomId: string;
    readonly targetId: string;
    readonly controlSeq: number;
    readonly events: readonly StoredEvent[];
    readonly requestId: string;
  }): Promise<readonly AcceptedEvent[]>;

  /** IF-004: presence heartbeat。 */
  sendPresence(args: {
    readonly roomId: string;
    readonly targetId: string;
    readonly requestId: string;
  }): Promise<void>;

  /** IF-003: 更新通知の接続を開く。`requestId` は、接続単位。 */
  connect(
    args: {
      readonly roomId: string;
      readonly targetId: string;
      readonly requestId: string;
    },
    handlers: ConnectionHandlers,
  ): NotificationConnection;
}
