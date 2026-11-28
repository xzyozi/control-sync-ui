import { DEFAULTS } from "./defaults.js";
import { RelayError } from "./errors.js";
import type {
  AcceptedEvent,
  ControlSnapshot,
  ControlState,
  Envelope,
  LeaseResult,
  Notification,
  NotificationListener,
  NotificationType,
  RelayOptions,
} from "./types.js";
import {
  isRecord,
  parseLeaseAction,
  parseSendFilter,
  requireSeq,
  requireString,
} from "./validation.js";

// lib に DOM を含めず、@types/node にも依存しないため、使う分だけを宣言する。
// 実行時は、グローバルの console を指す。
declare const console: { error: (...data: unknown[]) => void };

/** 端末ごとに一意な eventId のキー（DD §2.3: eventId は端末内で一意）。 */
function eventKey(targetId: string, eventId: string): string {
  return `${targetId}\u0000${eventId}`;
}

interface RoomState {
  controlSeq: number;
  control: ControlState;
  /** lease の期限（ミリ秒）。保持者がいない場合は null。 */
  leaseExpiresAt: number | null;
  /** 同じ Room の中で、一意に増加する（DD V-10）。 */
  eventSeq: number;
  /** (targetId, eventId) ごとの eventSeq。ログの圧縮（#6）までは、削除しない。 */
  events: Map<string, number>;
  /** targetId ごとの presence の期限（ミリ秒）。 */
  presence: Map<string, number>;
  connections: Map<string, Set<NotificationListener>>;
  /** requestId ごとの、最初の応答の保持（DD V-08）。 */
  responses: Map<string, { controlSeq: number; expiresAt: number }>;
}

/**
 * サーバーの判定ロジック（DD F-005〜F-008）。HTTP や SSE は扱わない。
 * 状態はメモリで持つ（v0.1 の参照実装、DS §1.1）。
 *
 * lease の期限切れは、期限の時刻に解放する（DD V-09）。実行環境は、`nextExpiry()`
 * の時刻に `tick()` を呼ぶ。各メソッドも、処理の前に期限を確認するので、
 * `tick()` が遅れても、期限切れの lease は使えない。
 */
export class RelayCore {
  private readonly rooms = new Map<string, RoomState>();
  private readonly now: () => number;
  private readonly schemaVersion: string;
  private readonly leaseTtlMs: number;
  private readonly presenceTtlMs: number;
  private readonly requestIdRetentionMs: number;
  private readonly onListenerError: (error: unknown) => void;

  constructor(options: RelayOptions = {}) {
    this.onListenerError =
      options.onListenerError ??
      ((error) => console.error("[relay] listener failed:", error));
    this.now = options.now ?? (() => Date.now());
    this.schemaVersion = options.schemaVersion ?? DEFAULTS.schemaVersion;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULTS.leaseTtlMs;
    this.presenceTtlMs = options.presenceTtlMs ?? DEFAULTS.presenceTtlMs;
    this.requestIdRetentionMs =
      options.requestIdRetentionMs ?? DEFAULTS.requestIdRetentionMs;
  }

  /** Room を作る。すでにある場合は、何もしない。 */
  createRoom(roomId: string): void {
    const id = requireString(roomId, "roomId");
    if (this.rooms.has(id)) {
      return;
    }
    this.rooms.set(id, {
      controlSeq: 0,
      control: { sendFilter: { mode: "NONE" }, holderId: null },
      leaseExpiresAt: null,
      eventSeq: 0,
      events: new Map(),
      presence: new Map(),
      connections: new Map(),
      responses: new Map(),
    });
  }

  /**
   * 期限を過ぎた lease を解放し（DD V-09）、期限が切れた presence を削除する。
   * 期限切れの presence は、もともとオフラインと判定されるので、削除しても、
   * 判定の結果は変わらない。
   */
  tick(): void {
    const now = this.now();
    for (const room of this.rooms.values()) {
      this.expireLease(room);
      for (const [targetId, expiresAt] of room.presence) {
        if (expiresAt <= now) {
          room.presence.delete(targetId);
        }
      }
    }
  }

  /** 次に、lease が期限切れになる時刻（ミリ秒）。なければ null。 */
  nextExpiry(): number | null {
    let next: number | null = null;
    for (const room of this.rooms.values()) {
      const at = room.leaseExpiresAt;
      if (at !== null && (next === null || at < next)) {
        next = at;
      }
    }
    return next;
  }

  /** IF-001: 制御状態の取得。 */
  getControl(
    roomId: string,
    request: { targetId: string },
    env: Envelope,
  ): ControlSnapshot {
    const room = this.prepare(roomId, env);
    requireString(request.targetId, "targetId");
    return { controlSeq: room.controlSeq, control: room.control };
  }

  /** IF-002: イベントの送信。 */
  pushEvents(
    roomId: string,
    request: { targetId: string; controlSeq: number; events: unknown },
    env: Envelope,
  ): { accepted: AcceptedEvent[] } {
    const room = this.prepare(roomId, env);
    const targetId = requireString(request.targetId, "targetId");
    const controlSeq = requireSeq(request.controlSeq, "controlSeq");
    if (!Array.isArray(request.events) || request.events.length === 0) {
      throw new RelayError(
        "INVALID_MESSAGE",
        "events must be a non-empty array",
      );
    }
    const incoming = request.events.map((item: unknown) => {
      if (!isRecord(item) || !isRecord(item.payload)) {
        throw new RelayError(
          "INVALID_MESSAGE",
          "each event needs eventId and payload",
        );
      }
      return requireString(item.eventId, "eventId");
    });

    // controlSeq は、サーバーの最新値と一致すること（IF §4.2.1）。
    if (controlSeq > room.controlSeq) {
      throw new RelayError(
        "INVALID_MESSAGE",
        "controlSeq is newer than the server's",
      );
    }
    if (controlSeq < room.controlSeq) {
      throw new RelayError(
        "STALE_CONTROL_SEQ",
        "controlSeq is stale",
        room.controlSeq,
      );
    }

    const accepted: AcceptedEvent[] = [];
    let appended = false;
    for (const eventId of incoming) {
      const key = eventKey(targetId, eventId);
      const known = room.events.get(key);
      if (known !== undefined) {
        // 同じ端末の同じ eventId の再送は、二重に追加しない（最初の eventSeq を返す）。
        accepted.push({ eventId, eventSeq: known });
        continue;
      }
      room.eventSeq += 1;
      room.events.set(key, room.eventSeq);
      accepted.push({ eventId, eventSeq: room.eventSeq });
      appended = true;
    }
    if (appended) {
      this.notify(room, "EVENTS_APPENDED", room.eventSeq);
    }
    return { accepted };
  }

  /** IF-003: 更新通知の接続。接続を閉じる関数を返す。 */
  connect(
    roomId: string,
    request: { targetId: string },
    listener: NotificationListener,
    env: Envelope,
  ): () => void {
    const room = this.prepare(roomId, env);
    const targetId = requireString(request.targetId, "targetId");
    let listeners = room.connections.get(targetId);
    if (listeners === undefined) {
      listeners = new Set();
      room.connections.set(targetId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = room.connections.get(targetId);
      if (current === undefined) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        room.connections.delete(targetId);
      }
    };
  }

  /** IF-004: presence heartbeat。更新通知の接続がなくても、受け付ける。 */
  presence(
    roomId: string,
    request: { targetId: string },
    env: Envelope,
  ): void {
    const room = this.prepare(roomId, env);
    const targetId = requireString(request.targetId, "targetId");
    room.presence.set(targetId, this.now() + this.presenceTtlMs);
  }

  /**
   * IF-005: lease の取得・更新・解放。`controlSeq` を発行するのは、保持者が
   * 実際に変わったときだけ（取得、解放、期限切れ）。RENEW と、同じ操作者の
   * ACQUIRE では発行しない（DD §3.2）。
   */
  lease(
    roomId: string,
    request: { operatorId: string; action: string },
    env: Envelope,
  ): LeaseResult {
    const room = this.prepare(roomId, env);
    const operatorId = requireString(request.operatorId, "operatorId");
    const action = parseLeaseAction(request.action);
    const holder = room.control.holderId;

    switch (action) {
      case "ACQUIRE":
        if (holder === null) {
          room.control = { ...room.control, holderId: operatorId };
          this.extendLease(room);
          this.bump(room);
          this.notify(room, "CONTROL_UPDATED");
        } else if (holder === operatorId) {
          this.extendLease(room);
        } else {
          throw new RelayError(
            "LOCK_HELD_BY_OTHER",
            "the lease is held by another operator",
          );
        }
        break;
      case "RENEW":
        this.assertHolder(room, operatorId);
        this.extendLease(room);
        break;
      case "RELEASE":
        this.assertHolder(room, operatorId);
        this.clearHolder(room);
        this.bump(room);
        this.notify(room, "CONTROL_UPDATED");
        break;
      default: {
        // action を追加したのに、ここを更新し忘れると、型検査で失敗する。
        const unreachable: never = action;
        return unreachable;
      }
    }
    return {
      holderId: room.control.holderId,
      controlSeq: room.controlSeq,
    };
  }

  /**
   * IF-006: 送信対象フィルタの変更。処理の順序は、共通項目の検証（F-008）、
   * ロックの検証（F-006）、オンライン判定（F-007）、`controlSeq` の発行（F-005）。
   * 同じ requestId の再送は、二重に適用せず、最初の応答を返す（DD V-08）。
   */
  changeControl(
    roomId: string,
    request: { operatorId: string; targetId: string; sendFilter: unknown },
    env: Envelope,
  ): { controlSeq: number } {
    const room = this.prepare(roomId, env);
    const requestId = requireString(env.requestId, "requestId");
    const operatorId = requireString(request.operatorId, "operatorId");
    const targetId = requireString(request.targetId, "targetId");
    const sendFilter = parseSendFilter(request.sendFilter);

    const now = this.now();
    this.purgeResponses(room, now);
    const cached = room.responses.get(requestId);
    if (cached !== undefined) {
      return { controlSeq: cached.controlSeq };
    }

    this.assertHolder(room, operatorId);
    if (!this.isOnline(room, targetId, now)) {
      throw new RelayError("TARGET_OFFLINE", "the target is offline");
    }

    room.control = { ...room.control, sendFilter };
    const controlSeq = this.bump(room);
    room.responses.set(requestId, {
      controlSeq,
      expiresAt: now + this.requestIdRetentionMs,
    });
    this.notify(room, "CONTROL_UPDATED");
    return { controlSeq };
  }

  // ---- 内部 ----

  /** F-008（共通項目の検証）、Room の確認、lease の期限の確認。 */
  private prepare(roomId: unknown, env: Envelope): RoomState {
    if (
      typeof env.schemaVersion !== "string" ||
      env.schemaVersion.length === 0 ||
      typeof env.requestId !== "string" ||
      env.requestId.length === 0
    ) {
      throw new RelayError(
        "INVALID_MESSAGE",
        "schemaVersion and requestId are required",
      );
    }
    if (env.schemaVersion !== this.schemaVersion) {
      throw new RelayError(
        "SCHEMA_VERSION_MISMATCH",
        "schemaVersion does not match",
      );
    }
    const room = this.rooms.get(requireString(roomId, "roomId"));
    if (room === undefined) {
      throw new RelayError("ROOM_NOT_FOUND", "the room does not exist");
    }
    this.expireLease(room);
    return room;
  }

  /** F-006: 呼び出した操作者が、期限内の保持者であること。 */
  private assertHolder(room: RoomState, operatorId: string): void {
    if (room.control.holderId !== operatorId) {
      throw new RelayError("LOCK_NOT_HELD", "the lease is not held");
    }
  }

  /** F-007: 更新通知の接続があり、かつ presence の期限が切れていない。 */
  private isOnline(room: RoomState, targetId: string, now: number): boolean {
    const connected = (room.connections.get(targetId)?.size ?? 0) > 0;
    const expiresAt = room.presence.get(targetId);
    return connected && expiresAt !== undefined && expiresAt > now;
  }

  private expireLease(room: RoomState): void {
    if (
      room.control.holderId !== null &&
      room.leaseExpiresAt !== null &&
      this.now() >= room.leaseExpiresAt
    ) {
      this.clearHolder(room);
      this.bump(room);
      this.notify(room, "CONTROL_UPDATED");
    }
  }

  private extendLease(room: RoomState): void {
    room.leaseExpiresAt = this.now() + this.leaseTtlMs;
  }

  private clearHolder(room: RoomState): void {
    room.control = { ...room.control, holderId: null };
    room.leaseExpiresAt = null;
  }

  private purgeResponses(room: RoomState, now: number): void {
    for (const [requestId, entry] of room.responses) {
      if (entry.expiresAt <= now) {
        room.responses.delete(requestId);
      }
    }
  }

  /** F-005: controlSeq を、1 増やして発行する。 */
  private bump(room: RoomState): number {
    room.controlSeq += 1;
    return room.controlSeq;
  }

  private notify(
    room: RoomState,
    type: NotificationType,
    eventSeq?: number,
  ): void {
    const notification: Notification = {
      schemaVersion: this.schemaVersion,
      type,
      controlSeq: room.controlSeq,
      ...(eventSeq !== undefined ? { eventSeq } : {}),
    };
    for (const listeners of room.connections.values()) {
      for (const listener of listeners) {
        // 状態の更新は済んでいるので、listener の失敗を、呼び出し元に返さない。
        // 他の listener への通知は、続ける。
        try {
          listener(notification);
        } catch (error) {
          this.onListenerError(error);
        }
      }
    }
  }
}
