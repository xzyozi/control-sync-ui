import { describe, expect, it } from "vitest";
import {
  ControlStore,
  DomainStore,
  INITIAL_CONTROL,
  InMemoryStoragePort,
} from "../src/index";
import type { ControlState } from "../src/index";
import { makeEvent, sumReducer } from "./helpers";

const ALL: ControlState = { sendFilter: { mode: "ALL" }, holderId: "op-1" };
const TYPES: ControlState = {
  sendFilter: { mode: "TYPES", types: ["add"] },
  holderId: "op-1",
};

describe("ControlStore", () => {
  it("初期状態は何も送らず（NONE）、controlSeq は 0", () => {
    const store = new ControlStore();
    expect(store.getControl()).toEqual(INITIAL_CONTROL);
    expect(store.getControlSeq()).toBe(0);
  });

  it("TC-116: 新しい controlSeq を反映し、小さい値は反映しない", () => {
    const store = new ControlStore();
    expect(store.apply(3, ALL)).toBe(true);
    expect(store.getControlSeq()).toBe(3);
    expect(store.getControl()).toEqual(ALL);

    // 保持している値より小さい値（古い応答）は、反映されない。
    expect(store.apply(2, TYPES)).toBe(false);
    expect(store.getControlSeq()).toBe(3);
    expect(store.getControl()).toEqual(ALL);

    // 同じ値は反映される（同じ状態の再取得）。
    expect(store.apply(3, TYPES)).toBe(true);
    expect(store.getControl()).toEqual(TYPES);
  });

  it("TC-116: 制御状態を反映しても、Domain Store の状態は変化しない", async () => {
    const domain = new DomainStore(
      new InMemoryStoragePort(),
      "room-a",
      sumReducer,
      0,
    );
    await domain.apply(makeEvent("e1", "room-a", "add", 7));

    const control = new ControlStore();
    control.apply(1, ALL);
    control.apply(2, TYPES);

    expect(domain.state).toBe(7);
  });
});
