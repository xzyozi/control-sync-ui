import { describe, expect, it } from "vitest";
import {
  ControlStore,
  InMemoryStoragePort,
  ReactiveOutbox,
  evaluateOutbox,
} from "../src/index";
import type { SendFilter, StoredEvent } from "../src/index";
import { makeEvent } from "./helpers";

async function seed(): Promise<{
  storage: InMemoryStoragePort;
  events: readonly StoredEvent[];
}> {
  const storage = new InMemoryStoragePort();
  await storage.append(makeEvent("e1", "room-a", "temperature"));
  await storage.append(makeEvent("e2", "room-a", "humidity"));
  await storage.append(makeEvent("e3", "room-b", "temperature"));
  return { storage, events: await storage.readPending("room-a") };
}

function evaluate(
  events: readonly StoredEvent[],
  filter: SendFilter,
  targetId = "target-1",
) {
  return evaluateOutbox({
    pending: events,
    roomId: "room-a",
    targetId,
    filter,
    controlSeq: 5,
  });
}

describe("evaluateOutbox", () => {
  it("TC-103: NONE は何も送らず、ALL はすべて、TYPES は type が一致するものだけを送る", async () => {
    const { events } = await seed();

    expect(evaluate(events, { mode: "NONE" }).events).toHaveLength(0);
    expect(evaluate(events, { mode: "ALL" }).events).toHaveLength(2);

    const typed = evaluate(events, { mode: "TYPES", types: ["temperature"] });
    expect(typed.events.map((e) => e.eventId)).toEqual(["e1"]);
  });

  it("TC-104: targetIds に含まれない端末は何も送らない", async () => {
    const { events } = await seed();
    const filter: SendFilter = { mode: "ALL", targetIds: ["target-2"] };

    expect(evaluate(events, filter, "target-1").events).toHaveLength(0);
    expect(evaluate(events, filter, "target-2").events).toHaveLength(2);
  });

  it("TC-104: 不正な TYPES（types が未指定、または空）は NONE と同じ扱い", async () => {
    const { events } = await seed();

    expect(evaluate(events, { mode: "TYPES" }).events).toHaveLength(0);
    expect(
      evaluate(events, { mode: "TYPES", types: [] }).events,
    ).toHaveLength(0);
  });

  it("評価時の controlSeq を、そのまま返す", async () => {
    const { events } = await seed();
    expect(evaluate(events, { mode: "ALL" }).controlSeq).toBe(5);
  });
});

describe("ReactiveOutbox", () => {
  it("TC-117: 指定した Room のイベントだけが送信対象になり、別の Room は読み出されない", async () => {
    const { storage } = await seed();
    const control = new ControlStore();
    control.apply(1, { sendFilter: { mode: "ALL" }, holderId: null });

    const outbox = new ReactiveOutbox(storage, control, "room-a", "target-1");
    const batch = await outbox.evaluate();

    expect(batch.events.map((e) => e.eventId)).toEqual(["e1", "e2"]);
    expect(batch.events.every((e) => e.roomId === "room-a")).toBe(true);
    expect(batch.controlSeq).toBe(1);
  });

  it("送信済み（SENT）のイベントは、送信対象にならない", async () => {
    const { storage } = await seed();
    const control = new ControlStore();
    control.apply(1, { sendFilter: { mode: "ALL" }, holderId: null });
    await storage.markSent("e1", 1);

    const outbox = new ReactiveOutbox(storage, control, "room-a", "target-1");
    const batch = await outbox.evaluate();

    expect(batch.events.map((e) => e.eventId)).toEqual(["e2"]);
  });

  it("フィルタに合わないイベントは、未送信（PENDING）のまま残る", async () => {
    const { storage } = await seed();
    const control = new ControlStore();
    control.apply(1, { sendFilter: { mode: "NONE" }, holderId: null });

    const outbox = new ReactiveOutbox(storage, control, "room-a", "target-1");
    expect((await outbox.evaluate()).events).toHaveLength(0);
    expect(await storage.readPending("room-a")).toHaveLength(2);
  });
});
