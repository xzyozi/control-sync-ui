import { DuplicateEventError } from "./errors.js";
import type { StoragePort } from "./ports.js";
import type { DomainEventInput, StoredEvent } from "./types.js";

interface Delivery {
  status: "PENDING" | "SENT";
  eventSeq: number | null;
}

/**
 * メモリ上の StoragePort の参照実装。単体検証と、親プロジェクトのテストに使う。
 * 永続化はしない（IndexedDB の実装は `storage-indexeddb` が担う）。
 */
export class InMemoryStoragePort implements StoragePort {
  private readonly events: StoredEvent[] = [];
  private readonly deliveries = new Map<string, Delivery>();
  private nextLocalSeq = 1;

  async append(event: DomainEventInput): Promise<StoredEvent> {
    if (this.deliveries.has(event.eventId)) {
      throw new DuplicateEventError(event.eventId);
    }
    const stored: StoredEvent = { ...event, localSeq: this.nextLocalSeq };
    this.nextLocalSeq += 1;
    this.events.push(stored);
    this.deliveries.set(event.eventId, { status: "PENDING", eventSeq: null });
    return stored;
  }

  async readAll(roomId: string): Promise<readonly StoredEvent[]> {
    return this.events.filter((e) => e.roomId === roomId);
  }

  async readPending(roomId: string): Promise<readonly StoredEvent[]> {
    return this.events.filter(
      (e) =>
        e.roomId === roomId &&
        this.deliveries.get(e.eventId)?.status === "PENDING",
    );
  }

  async markSent(eventId: string, eventSeq: number): Promise<void> {
    const delivery = this.deliveries.get(eventId);
    if (delivery === undefined) {
      throw new Error(`unknown event: ${eventId}`);
    }
    // PENDING → SENT の一方向だけ。すでに SENT の場合は、何もしない（冪等）。
    if (delivery.status === "SENT") {
      return;
    }
    delivery.status = "SENT";
    delivery.eventSeq = eventSeq;
  }
}
