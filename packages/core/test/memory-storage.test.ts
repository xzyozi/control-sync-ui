import { describe, expect, it } from "vitest";
import { DuplicateEventError, InMemoryStoragePort } from "../src/index";
import { makeEvent } from "./helpers";

describe("InMemoryStoragePort", () => {
  it("localSeq は、追記のたびに 1 から増える", async () => {
    const storage = new InMemoryStoragePort();
    const first = await storage.append(makeEvent("e1", "room-a", "add"));
    const second = await storage.append(makeEvent("e2", "room-b", "add"));
    expect([first.localSeq, second.localSeq]).toEqual([1, 2]);
  });

  it("同じ eventId の追記は DuplicateEventError で拒否される（Room をまたいでも）", async () => {
    const storage = new InMemoryStoragePort();
    await storage.append(makeEvent("e1", "room-a", "add"));
    await expect(
      storage.append(makeEvent("e1", "room-b", "add")),
    ).rejects.toBeInstanceOf(DuplicateEventError);
  });

  it("markSent は冪等で、PENDING に戻らない", async () => {
    const storage = new InMemoryStoragePort();
    await storage.append(makeEvent("e1", "room-a", "add"));
    await storage.markSent("e1", 10);
    await storage.markSent("e1", 11);
    expect(await storage.readPending("room-a")).toHaveLength(0);
    expect(await storage.readAll("room-a")).toHaveLength(1);
  });

  it("Room が混在していても、各 Room の読み出しは localSeq の順になる", async () => {
    const storage = new InMemoryStoragePort();
    await storage.append(makeEvent("a1", "room-a", "add"));
    await storage.append(makeEvent("b1", "room-b", "add"));
    await storage.append(makeEvent("a2", "room-a", "add"));
    await storage.append(makeEvent("b2", "room-b", "add"));

    const roomA = await storage.readAll("room-a");
    expect(roomA.map((e) => e.eventId)).toEqual(["a1", "a2"]);
    expect(roomA.map((e) => e.localSeq)).toEqual([1, 3]);

    const pendingB = await storage.readPending("room-b");
    expect(pendingB.map((e) => e.eventId)).toEqual(["b1", "b2"]);
  });

  it("未知の eventId の markSent は、エラーになる", async () => {
    const storage = new InMemoryStoragePort();
    await expect(storage.markSent("unknown", 1)).rejects.toThrow(
      "unknown event",
    );
  });
});
