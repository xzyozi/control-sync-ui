import type { DomainEventInput, Reducer, StoredEvent } from "../src/index";

/** テスト用のイベント（金額を持つ）。roomId は呼び出し側で指定する。 */
export function makeEvent(
  eventId: string,
  roomId: string,
  type: string,
  amount = 1,
): DomainEventInput {
  return {
    eventId,
    roomId,
    payload: { type, amount },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** テスト用の Reducer。`amount` の合計を数える（純粋関数）。 */
export const sumReducer: Reducer<number> = (state, event: StoredEvent) => {
  const amount = event.payload.amount;
  return state + (typeof amount === "number" ? amount : 0);
};
