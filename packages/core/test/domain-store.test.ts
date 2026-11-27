import { describe, expect, it } from "vitest";
import {
  DomainStore,
  DuplicateEventError,
  InMemoryStoragePort,
} from "../src/index";
import type { DomainEventInput, StoredEvent } from "../src/index";
import { makeEvent, sumReducer } from "./helpers";

/** 追記が必ず失敗する StoragePort（TC-102 用）。 */
class FailingStoragePort extends InMemoryStoragePort {
  override async append(_event: DomainEventInput): Promise<StoredEvent> {
    throw new Error("disk full");
  }
}

describe("DomainStore", () => {
  it("TC-101: 同じイベント列から同じ状態が得られ、開き直しても復元できる", async () => {
    const storage = new InMemoryStoragePort();
    const live = new DomainStore(storage, "room-a", sumReducer, 0);
    await live.apply(makeEvent("e1", "room-a", "add", 2));
    await live.apply(makeEvent("e2", "room-a", "add", 3));
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
    await expect(
      store.apply(makeEvent("e1", "room-a", "add", 5)),
    ).rejects.toThrow("disk full");
    expect(store.state).toBe(10);
  });

  it("同じ eventId の再追記は DuplicateEventError で、状態は更新されない", async () => {
    const store = new DomainStore(
      new InMemoryStoragePort(),
      "room-a",
      sumReducer,
      0,
    );
    await store.apply(makeEvent("e1", "room-a", "add", 4));
    await expect(
      store.apply(makeEvent("e1", "room-a", "add", 4)),
    ).rejects.toBeInstanceOf(DuplicateEventError);
    expect(store.state).toBe(4);
  });

  it("別の Room のイベントは、復元に含まれない", async () => {
    const storage = new InMemoryStoragePort();
    await storage.append(makeEvent("e1", "room-a", "add", 1));
    await storage.append(makeEvent("e2", "room-b", "add", 100));
    const store = new DomainStore(storage, "room-a", sumReducer, 0);
    expect(await store.restore()).toBe(1);
  });
});
