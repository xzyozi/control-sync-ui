import type { ControlStore } from "./control-store.js";
import type { StoragePort } from "./ports.js";
import type { SendBatch, SendFilter, StoredEvent } from "./types.js";

/** 送信対象のイベントが、フィルタに合うかを判定する（DD F-003）。 */
function matchesFilter(
  event: StoredEvent,
  filter: SendFilter,
  targetId: string,
): boolean {
  // targetIds を指定した場合、含まれない端末は何も送らない。
  if (filter.targetIds !== undefined && !filter.targetIds.includes(targetId)) {
    return false;
  }
  switch (filter.mode) {
    case "ALL":
      return true;
    case "TYPES":
      // types が未指定、または空の不正なフィルタは、NONE と同じ扱い。
      if (filter.types === undefined || filter.types.length === 0) {
        return false;
      }
      return filter.types.includes(event.payload.type);
    case "NONE":
      return false;
    default: {
      // mode を追加したのに、ここを更新し忘れると、型検査で失敗する。
      const unreachable: never = filter.mode;
      return unreachable;
    }
  }
}

/**
 * 未送信のイベントのうち、制御状態に合うものを選ぶ（純粋関数）。
 * 指定した Room 以外のイベントは、選ばない（Room の分離、FR-04）。
 */
export function evaluateOutbox(params: {
  readonly pending: readonly StoredEvent[];
  readonly roomId: string;
  readonly targetId: string;
  readonly filter: SendFilter;
  readonly controlSeq: number;
}): SendBatch {
  const events = params.pending.filter(
    (e) =>
      e.roomId === params.roomId &&
      matchesFilter(e, params.filter, params.targetId),
  );
  return { controlSeq: params.controlSeq, events };
}

/**
 * Reactive Outbox（DD F-003）。StoragePort から未送信のイベントを読み出し、
 * Control Store の最新状態で評価する。送信そのものは行わない。
 */
export class ReactiveOutbox {
  constructor(
    private readonly storage: StoragePort,
    private readonly controlStore: ControlStore,
    private readonly roomId: string,
    private readonly targetId: string,
  ) { }

  async evaluate(): Promise<SendBatch> {
    const pending = await this.storage.readPending(this.roomId);
    return evaluateOutbox({
      pending,
      roomId: this.roomId,
      targetId: this.targetId,
      filter: this.controlStore.getControl().sendFilter,
      controlSeq: this.controlStore.getControlSeq(),
    });
  }
}
