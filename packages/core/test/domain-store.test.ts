import { describe, expect, it } from "vitest";
import { DomainStore, InMemoryStoragePort } from "../src/index";
import type { ApplyInput, StoragePort, StoredEvent } from "../src/index";
import { makeEvent, sumReducer } from "./helpers";

/** 追記が必ず失敗する StoragePort（TC-102 用）。StoragePort を直接実装する。 */
class FailingStoragePort implements StoragePort {
  async append(): Promise<StoredEvent> {
    throw new Error("disk full");
  }

  async readAll(): Promise<readonly StoredEvent[]> {
    return [];
  }

  async readPending(): Promise<readonly StoredEvent[]> {
    return [];
  }

  async markSent(): Promise<void> { }
}

/** apply に渡す入力（roomId は DomainStore が付ける）。 */
function input(eventId: string, amount: number): ApplyInput {
  return {
    eventId,
    payload: { type: "add", amount },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("DomainStore", () => {
  it("TC-101: 同じイベント列から同じ状態が得られ、開き直しても復元できる", async () => {
    const storage = new InMemoryStoragePort();
    const live = new DomainStore(storage, "room-a", sumReducer, 0);
    await live.apply(input("e1", 2));
    await live.apply(input("e2", 3));
    expect(live.state).toBe(5);

    // 同じ StoragePort を、新しい DomainStore で開き直して復元する。
    const reopened = new DomainStore(storage, "room-a", sumReducer, 0);
    expect(await reopened.restore()).toBe(5);

    // 復元を繰り返しても、同じ状態になる（決定論性）。
    expect(await reopened.restore()).toBe(5);
  });

  it("TC-102: 追記に失敗した場合、状態は更新されない", async () => {
    const store = new DomainStore(
      new FailingStoragePort(),
      "room-a",
      sumReducer,
      10,
    );
    await expect(store.apply(input("e1", 5))).rejects.toThrow("disk full");
    expect(store.state).toBe(10);
  });

  it("TC-121: 同じ eventId の再追記は、追記済みとして扱い、状態を更新せずに現在の状態を返す", async () => {
    const storage = new InMemoryStoragePort();
    const store = new DomainStore(storage, "room-a", sumReducer, 0);
    await store.apply(input("e1", 4));

    // エラーにならず、状態は二重に加算されない。
    expect(await store.apply(input("e1", 4))).toBe(4);
    expect(store.state).toBe(4);
    expect(await storage.readAll("room-a")).toHaveLength(1);
  });

  it("別の Room のイベントは、復元に含まれない", async () => {
    const storage = new InMemoryStoragePort();
    await storage.append(makeEvent("e1", "room-a", "add", 1));
    await storage.append(makeEvent("e2", "room-b", "add", 100));
    const store = new DomainStore(storage, "room-a", sumReducer, 0);
    expect(await store.restore()).toBe(1);
  });

  it("TC-122: createdAt を省略した場合は、追記時の時刻（注入した now）が使われる", async () => {
    const storage = new InMemoryStoragePort();
    const store = new DomainStore(
      storage,
      "room-a",
      sumReducer,
      0,
      () => "2026-12-31T23:59:59.000Z",
    );
    await store.apply({ eventId: "e1", payload: { type: "add", amount: 1 } });

    const [saved] = await storage.readAll("room-a");
    expect(saved?.createdAt).toBe("2026-12-31T23:59:59.000Z");
  });

  it("TC-122: createdAt を指定した場合は、その値が使われる", async () => {
    const storage = new InMemoryStoragePort();
    const store = new DomainStore(storage, "room-a", sumReducer, 0);
    await store.apply({
      eventId: "e1",
      payload: { type: "add", amount: 1 },
      createdAt: "2026-01-02T03:04:05.000Z",
    });

    const [saved] = await storage.readAll("room-a");
    expect(saved?.createdAt).toBe("2026-01-02T03:04:05.000Z");
  });
});
