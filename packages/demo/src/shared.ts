import type { Reducer, StoredEvent } from "@csu/core";

export const DEMO_SCHEMA_VERSION = "1";
export const DEFAULT_DEMO_ROOM_ID = "room-demo";
export const DEFAULT_DEMO_TARGET_ID = "target-1";
export const DEFAULT_DEMO_OPERATOR_ID = "op-1";

export interface DemoDomainState {
  readonly total: number;
  readonly eventCount: number;
  readonly lastEventId: string | null;
  readonly history: readonly {
    readonly localSeq: number;
    readonly eventId: string;
    readonly type: string;
    readonly amount: number;
  }[];
}

export const INITIAL_DEMO_STATE: DemoDomainState = {
  total: 0,
  eventCount: 0,
  lastEventId: null,
  history: [],
};

/** 決定論的なデモ用 Reducer（FR-01）。 */
export const demoReducer: Reducer<DemoDomainState> = (
  state,
  event: StoredEvent,
) => {
  const rawAmount = event.payload.amount;
  const amount =
    typeof rawAmount === "number" && Number.isFinite(rawAmount) ? rawAmount : 0;
  return {
    total: state.total + amount,
    eventCount: state.eventCount + 1,
    lastEventId: event.eventId,
    history: [
      ...state.history,
      {
        localSeq: event.localSeq,
        eventId: event.eventId,
        type: event.payload.type,
        amount,
      },
    ],
  };
};
