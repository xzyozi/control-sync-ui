import type { ControlStore } from "./control-store.js";
import { ReactiveOutbox } from "./outbox.js";
import type { StoragePort } from "./ports.js";
import {
  type NotificationConnection,
  type ServerNotification,
  type TransportErrorCode,
  type TransportPort,
  TransportError,
} from "./transport.js";

/** Sync Engine の状態（DD §3.2）。 */
export type SyncState =
  | "Disconnected"
  | "Connecting"
  | "Pulling"
  | "Ready"
  | "Retrying"
  | "Stopped";

/** 停止（Stopped）の理由。 */
export type StopReason =
  | "SCHEMA_VERSION_MISMATCH"
  | "RETRY_LIMIT"
  | "INVALID_REQUEST"
  | "UNEXPECTED";

/** 現在の状態に対して未定義のイベントが無視されたときの情報（DD §3.2）。 */
export interface IgnoredEventInfo {
  readonly state: SyncState;
  readonly event: string;
}

/** 時間に依存する処理の抽象。テストでは、手動で進められるように注入する。 */
export interface Scheduler {
  /** `delayMs` 後に、`callback` を1回呼ぶ。キャンセルする関数を返す。 */
  setTimeout(callback: () => void, delayMs: number): () => void;
  /** `intervalMs` ごとに、`callback` を呼ぶ。キャンセルする関数を返す。 */
  setInterval(callback: () => void, intervalMs: number): () => void;
}

/** 実装の既定値（DD §1.3）。 */
export const SYNC_DEFAULTS = {
  /** V-04: presence heartbeat の送信間隔（5 秒）。 */
  presenceIntervalMs: 5_000,
  /** V-06: 再試行の上限（初回を除く）。 */
  maxRetries: 3,
  /** V-07: 再試行の待ち時間（1、2、4 秒。各 ±20% の揺らぎ）。 */
  retryDelaysMs: [1_000, 2_000, 4_000],
  /** V-11: `STALE_CONTROL_SEQ` の連続再評価の上限。 */
  maxStaleRetries: 3,
} as const;

export interface SyncEngineOptions {
  readonly roomId: string;
  readonly targetId: string;
  readonly storage: StoragePort;
  readonly controlStore: ControlStore;
  readonly transport: TransportPort;
  readonly scheduler: Scheduler;
  /** requestId の生成器。呼び出しごとに、一意な値を返す。 */
  readonly newRequestId: () => string;
  /** 0 以上 1 未満の乱数（待ち時間の揺らぎに使う）。既定は `Math.random`。 */
  readonly random?: () => number;
  readonly onStateChange?: (state: SyncState) => void;
  /** 停止したときに呼ぶ。`UNEXPECTED` のときは、`error` に原因を渡す。 */
  readonly onStopped?: (reason: StopReason, error?: unknown) => void;
  /** 未定義のイベントが無視されたときに呼ぶ（DD §3.2）。 */
  readonly onIgnoredEvent?: (info: IgnoredEventInfo) => void;
  /** コールバックが例外を投げたときに呼ぶ。 */
  readonly onCallbackError?: (error: unknown) => void;
  readonly presenceIntervalMs?: number;
  readonly maxRetries?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly maxStaleRetries?: number;
}

/**
 * Sync Engine（DD F-004）。Control-First Sync の手順を制御する。
 * 接続が開くたびに、IF-001 で制御状態を取得してから、Outbox を評価して
 * IF-002 で送信する。接続中は、presence heartbeat を送る。
 */
export class SyncEngine {
  private currentState: SyncState = "Disconnected";
  private connection: NotificationConnection | null = null;
  private cancelPresence: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  /** 通信の失敗の回数（V-06）。Push の受理、または送信対象が0件で、0 に戻る。 */
  private failures = 0;
  /** `STALE_CONTROL_SEQ` の連続回数（V-11）。 */
  private staleCount = 0;
  /** 世代。disconnect や再接続の後に、古い非同期処理の結果を、無視するために使う。 */
  private generation = 0;
  private pulling = false;
  private pullAgain = false;
  /** 再試行で同じ requestId を使うために保持する（DD F-004）。 */
  private pendingConnectRequestId: string | null = null;
  private pendingFetchRequestId: string | null = null;
  private pendingPushRequestId: string | null = null;
  private pendingPushKey: string | null = null;

  private readonly outbox: ReactiveOutbox;
  private readonly random: () => number;
  private readonly presenceIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly maxStaleRetries: number;

  constructor(private readonly options: SyncEngineOptions) {
    this.outbox = new ReactiveOutbox(
      options.storage,
      options.controlStore,
      options.roomId,
      options.targetId,
    );
    this.random = options.random ?? Math.random;
    this.presenceIntervalMs =
      options.presenceIntervalMs ?? SYNC_DEFAULTS.presenceIntervalMs;
    this.maxRetries = options.maxRetries ?? SYNC_DEFAULTS.maxRetries;
    this.retryDelaysMs = options.retryDelaysMs ?? SYNC_DEFAULTS.retryDelaysMs;
    this.maxStaleRetries =
      options.maxStaleRetries ?? SYNC_DEFAULTS.maxStaleRetries;
  }

  get state(): SyncState {
    return this.currentState;
  }

  /** 接続を開始する。`Disconnected` のときだけ有効（それ以外は無視して記録する）。 */
  connect(): void {
    if (this.currentState !== "Disconnected") {
      this.recordIgnoredEvent("connect");
      return;
    }
    this.failures = 0;
    this.staleCount = 0;
    this.clearPendingRequestIds();
    this.startConnection();
  }

  /** 切断する。heartbeat を止め、接続を閉じ、進行中の再試行をキャンセルする。 */
  disconnect(): void {
    if (this.currentState === "Stopped") {
      this.recordIgnoredEvent("disconnect");
      return;
    }
    this.clearPendingRequestIds();
    this.teardown();
    this.setState("Disconnected");
  }

  /** 保存済みのイベントが増えたときに、呼ぶ（`Ready` のときだけ、送信を試みる）。 */
  notifyLocalEvents(): void {
    if (this.currentState !== "Ready") {
      this.recordIgnoredEvent("notifyLocalEvents");
      return;
    }
    void this.pullAndPush();
  }

  // ---- 内部 ----

  private setState(next: SyncState): void {
    if (this.currentState === next) {
      return;
    }
    this.currentState = next;
    this.invokeCallback(() => this.options.onStateChange?.(next));
  }

  private invokeCallback(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      try {
        this.options.onCallbackError?.(error);
      } catch {
        // コールバックの例外が非同期処理の未処理拒否に漏れないように隔離する。
      }
    }
  }

  private recordIgnoredEvent(event: string): void {
    const state = this.currentState;
    if (this.options.onIgnoredEvent === undefined) {
      return;
    }
    this.invokeCallback(() => this.options.onIgnoredEvent?.({ state, event }));
  }

  private requestArgs(requestId: string): {
    roomId: string;
    targetId: string;
    requestId: string;
  } {
    return {
      roomId: this.options.roomId,
      targetId: this.options.targetId,
      requestId,
    };
  }

  private clearPendingRequestIds(): void {
    this.pendingConnectRequestId = null;
    this.pendingFetchRequestId = null;
    this.pendingPushRequestId = null;
    this.pendingPushKey = null;
  }

  private getFetchRequestId(): string {
    if (this.pendingFetchRequestId === null) {
      this.pendingFetchRequestId = this.options.newRequestId();
    }
    return this.pendingFetchRequestId;
  }

  private getPushRequestId(controlSeq: number, eventIds: readonly string[]): string {
    const key = `${controlSeq}:${eventIds.join(",")}`;
    if (this.pendingPushRequestId === null || this.pendingPushKey !== key) {
      this.pendingPushRequestId = this.options.newRequestId();
      this.pendingPushKey = key;
    }
    return this.pendingPushRequestId;
  }

  private teardown(): void {
    this.generation += 1;
    this.connection?.close();
    this.connection = null;
    this.cancelPresence?.();
    this.cancelPresence = null;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.pulling = false;
    this.pullAgain = false;
  }

  private stop(reason: StopReason, error?: unknown): void {
    this.clearPendingRequestIds();
    this.teardown();
    this.setState("Stopped");
    this.invokeCallback(() => this.options.onStopped?.(reason, error));
  }

  /** Connecting: 更新通知の接続を開く。 */
  private startConnection(): void {
    this.setState("Connecting");
    const generation = this.generation;
    if (this.pendingConnectRequestId === null) {
      this.pendingConnectRequestId = this.options.newRequestId();
    }
    this.connection = this.options.transport.connect(
      this.requestArgs(this.pendingConnectRequestId),
      {
        onOpen: () => {
          if (generation !== this.generation) {
            return;
          }
          this.pendingConnectRequestId = null;
          this.startPresence();
          // 接続が開くたびに（初回と自動再接続）、IF-001 から、やり直す。
          this.setState("Pulling");
          void this.pullAndPush();
        },
        onNotification: (notification) => {
          if (generation !== this.generation) {
            return;
          }
          this.handleNotification(notification);
        },
        onError: (info) => {
          if (generation !== this.generation) {
            return;
          }
          this.handleConnectionError(info);
        },
      },
    );
  }

  private startPresence(): void {
    this.cancelPresence?.();
    const generation = this.generation;
    const send = (): void => {
      void this.options.transport
        .sendPresence(this.requestArgs(this.options.newRequestId()))
        .catch((error: unknown) => {
          // presence の失敗は、次の周期で再送する。TTL を超えると、サーバーが
          // オフラインと判定する。スキーマの不一致だけは、停止する。
          if (
            generation === this.generation &&
            error instanceof TransportError &&
            error.code === "SCHEMA_VERSION_MISMATCH"
          ) {
            this.stop("SCHEMA_VERSION_MISMATCH");
          }
        });
    };
    send();
    this.cancelPresence = this.options.scheduler.setInterval(
      send,
      this.presenceIntervalMs,
    );
  }

  private handleNotification(notification: ServerNotification): void {
    if (notification.type === "CONTROL_UPDATED") {
      if (this.currentState === "Ready") {
        this.setState("Pulling");
        void this.pullAndPush();
      } else {
        this.recordIgnoredEvent("CONTROL_UPDATED");
      }
    }
  }

  private handleConnectionError(info: {
    readonly closed: boolean;
    readonly code?: TransportErrorCode;
  }): void {
    if (this.currentState === "Stopped" || this.currentState === "Disconnected") {
      this.recordIgnoredEvent("CONNECTION_ERROR");
      return;
    }
    if (info.code === "SCHEMA_VERSION_MISMATCH") {
      this.stop("SCHEMA_VERSION_MISMATCH");
      return;
    }
    if (info.closed) {
      // CLOSED: 再接続されない。IF-001 を実行して原因を判別し、
      // 致命的なエラーでなければ Retrying へ移って接続を張り直す（DD §3.2）。
      this.pendingConnectRequestId = null;
      this.setState("Pulling");
      void this.diagnoseClosedConnection();
      return;
    }
    // 自動再接続が行われる。open で、IF-001 から、やり直す。
    this.scheduleRetry();
  }

  private async diagnoseClosedConnection(): Promise<void> {
    const generation = this.generation;
    try {
      const snapshot = await this.options.transport.fetchControl(
        this.requestArgs(this.getFetchRequestId()),
      );
      if (generation !== this.generation) {
        return;
      }
      this.pendingFetchRequestId = null;
      this.options.controlStore.applyControl(
        snapshot.controlSeq,
        snapshot.control,
      );
      // SSE 接続が CLOSED のため、Retrying を経て再接続する。
      this.scheduleRetry();
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.handleFailure(error);
    }
  }

  /**
   * Control-First Sync: IF-001 の取得、Control Store への反映、Outbox の評価、
   * IF-002 の送信。実行中に、再度の要求があれば、終わった後に、もう1回行う。
   */
  private async pullAndPush(): Promise<void> {
    if (this.pulling) {
      this.pullAgain = true;
      return;
    }
    this.pulling = true;
    const generation = this.generation;
    try {
      do {
        this.pullAgain = false;
        await this.pullOnce(generation);
        if (generation !== this.generation) {
          return;
        }
      } while (this.pullAgain);
    } finally {
      if (generation === this.generation) {
        this.pulling = false;
      }
    }
  }

  private async pullOnce(generation: number): Promise<void> {
    const { transport, controlStore, roomId, targetId } = this.options;
    try {
      // 1. 制御状態を取得し、反映する（IF-001）。
      this.setState("Pulling");
      const snapshot = await transport.fetchControl(
        this.requestArgs(this.getFetchRequestId()),
      );
      if (generation !== this.generation) {
        return;
      }
      this.pendingFetchRequestId = null;
      controlStore.applyControl(snapshot.controlSeq, snapshot.control);

      // 2. 未送信のイベントを評価する。
      const batch = await this.outbox.evaluate();
      if (generation !== this.generation) {
        return;
      }
      this.setState("Ready");
      if (batch.events.length === 0) {
        this.pendingPushRequestId = null;
        this.pendingPushKey = null;
        this.failures = 0;
        this.staleCount = 0;
        return;
      }

      // 3. 送信する（IF-002）。評価時の controlSeq を、そのまま使う。
      const pushRequestId = this.getPushRequestId(
        batch.controlSeq,
        batch.events.map((e) => e.eventId),
      );
      const accepted = await transport.pushEvents({
        roomId,
        targetId,
        controlSeq: batch.controlSeq,
        events: batch.events,
        requestId: pushRequestId,
      });
      if (generation !== this.generation) {
        return;
      }
      this.pendingPushRequestId = null;
      this.pendingPushKey = null;
      for (const item of accepted) {
        await this.options.storage.markSent(item.eventId, item.eventSeq);
      }
      this.failures = 0;
      this.staleCount = 0;
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.handleFailure(error);
    }
  }

  private handleFailure(error: unknown): void {
    if (!(error instanceof TransportError)) {
      // 想定外のエラー（ストレージの失敗など）は、再試行せず、停止して、
      // onStopped で呼び出し元へ伝える（未処理の Promise の拒否にしない）。
      this.stop("UNEXPECTED", error);
      return;
    }
    switch (error.code) {
      case "SCHEMA_VERSION_MISMATCH":
        this.stop("SCHEMA_VERSION_MISMATCH");
        return;
      case "STALE_CONTROL_SEQ":
        // 再評価で controlSeq や送信対象が変わるため、次の IF-002 は新しい requestId を使う。
        this.pendingPushRequestId = null;
        this.pendingPushKey = null;
        this.staleCount += 1;
        if (this.staleCount > this.maxStaleRetries) {
          // 競合が続く。通信エラー1回として数え、手順を最初からやり直す。
          // 連続回数は Push が受理されるまで 0 に戻さない（DD V-11）。
          this.scheduleRetry();
        } else {
          // イベントは、破棄しない。IF-001 を取得し直して、再評価する。
          this.pullAgain = true;
        }
        return;
      case undefined:
        // 通信の失敗（接続の失敗、タイムアウト、HTTP 5xx）。
        this.scheduleRetry();
        return;
      default:
        // INVALID_MESSAGE、ROOM_NOT_FOUND など。再試行しても、同じ結果になる。
        this.stop("INVALID_REQUEST");
    }
  }

  /** Retrying: 待ち時間の後に、Connecting から再開する。上限を超えたら停止する。 */
  private scheduleRetry(): void {
    this.failures += 1;
    if (this.failures > this.maxRetries) {
      this.stop("RETRY_LIMIT");
      return;
    }
    // 進行中の接続とタイマーを、いったん片付ける（接続を張り直す）。
    this.teardown();
    this.setState("Retrying");
    const generation = this.generation;
    const index = Math.min(this.failures - 1, this.retryDelaysMs.length - 1);
    const base = this.retryDelaysMs[index] ?? 0;
    // ±20% の揺らぎ。
    const delay = Math.round(base * (0.8 + this.random() * 0.4));
    this.cancelRetry = this.options.scheduler.setTimeout(() => {
      if (generation !== this.generation) {
        return;
      }
      this.cancelRetry = null;
      this.startConnection();
    }, delay);
  }
}
