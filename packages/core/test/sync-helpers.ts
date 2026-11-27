import {
  ControlStore,
  InMemoryStoragePort,
  SyncEngine,
  TransportError,
} from "../src/index";
import type {
  AcceptedEvent,
  ConnectionHandlers,
  ControlSnapshot,
  NotificationConnection,
  Scheduler,
  StopReason,
  StoredEvent,
  SyncEngineOptions,
  SyncState,
  TransportPort,
} from "../src/index";
import { makeEvent } from "./helpers";

/** 手動で時間を進められる Scheduler。 */
export class ManualScheduler implements Scheduler {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { at: number; callback: () => void; interval: number | null }
  >();

  setTimeout(callback: () => void, delayMs: number): () => void {
    return this.add(callback, delayMs, null);
  }

  setInterval(callback: () => void, intervalMs: number): () => void {
    return this.add(callback, intervalMs, intervalMs);
  }

  /** 登録されているタイマーの数（キャンセル済みは含まない）。 */
  get pending(): number {
    return this.timers.size;
  }

  /** 時間を進め、期限が来たタイマーを、順に実行する。 */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId === null) {
        break;
      }
      const timer = this.timers.get(nextId);
      if (timer === undefined) {
        break;
      }
      this.time = nextAt;
      if (timer.interval === null) {
        this.timers.delete(nextId);
      } else {
        timer.at += timer.interval;
      }
      timer.callback();
    }
    this.time = target;
  }

  private add(
    callback: () => void,
    delayMs: number,
    interval: number | null,
  ): () => void {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.time + delayMs, callback, interval });
    return () => {
      this.timers.delete(id);
    };
  }
}

/** テスト用の TransportPort。呼び出しを記録し、応答を差し替えられる。 */
export class FakeTransport implements TransportPort {
  readonly calls: string[] = [];
  readonly requestIds: string[] = [];
  readonly pushed: { controlSeq: number; eventIds: string[] }[] = [];
  connections = 0;
  closedConnections = 0;
  handlers: ConnectionHandlers | null = null;
  snapshot: ControlSnapshot = {
    controlSeq: 0,
    control: { sendFilter: { mode: "NONE" }, holderId: null },
  };
  /** 次の呼び出しで投げるエラー（先頭から1件ずつ消費する）。 */
  fetchErrors: (TransportError | null)[] = [];
  pushErrors: (TransportError | null)[] = [];
  presenceError: TransportError | null = null;

  async fetchControl(args: { requestId: string }): Promise<ControlSnapshot> {
    this.calls.push("fetch");
    this.requestIds.push(args.requestId);
    const error = this.fetchErrors.shift();
    if (error) {
      throw error;
    }
    return this.snapshot;
  }

  async pushEvents(args: {
    controlSeq: number;
    events: readonly StoredEvent[];
    requestId: string;
  }): Promise<readonly AcceptedEvent[]> {
    this.calls.push("push");
    this.requestIds.push(args.requestId);
    const error = this.pushErrors.shift();
    if (error) {
      throw error;
    }
    this.pushed.push({
      controlSeq: args.controlSeq,
      eventIds: args.events.map((e) => e.eventId),
    });
    return args.events.map((e, i) => ({
      eventId: e.eventId,
      eventSeq: this.pushed.length * 100 + i + 1,
    }));
  }

  async sendPresence(args: { requestId: string }): Promise<void> {
    this.calls.push("presence");
    this.requestIds.push(args.requestId);
    if (this.presenceError) {
      throw this.presenceError;
    }
  }

  connect(
    _args: { requestId: string },
    handlers: ConnectionHandlers,
  ): NotificationConnection {
    this.calls.push("connect");
    this.connections += 1;
    this.handlers = handlers;
    return {
      close: () => {
        this.closedConnections += 1;
      },
    };
  }
}

export interface EngineFixture {
  engine: SyncEngine;
  transport: FakeTransport;
  scheduler: ManualScheduler;
  storage: InMemoryStoragePort;
  control: ControlStore;
  states: SyncState[];
  stops: { reason: StopReason; error?: unknown }[];
}

/** 非同期の処理（Promise）を、すべて完了させる。 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

export function createEngine(
  overrides: Partial<SyncEngineOptions> = {},
): EngineFixture {
  const transport = new FakeTransport();
  const scheduler = new ManualScheduler();
  const storage = new InMemoryStoragePort();
  const control = new ControlStore();
  const states: SyncState[] = [];
  const stops: { reason: StopReason; error?: unknown }[] = [];
  let counter = 0;
  const engine = new SyncEngine({
    roomId: "room-a",
    targetId: "target-1",
    storage,
    controlStore: control,
    transport,
    scheduler,
    newRequestId: () => {
      counter += 1;
      return `r-${counter}`;
    },
    // 揺らぎなし（基準の待ち時間そのまま）。
    random: () => 0.5,
    onStateChange: (s) => states.push(s),
    onStopped: (reason, error) => stops.push({ reason, error }),
    ...overrides,
  });
  return { engine, transport, scheduler, storage, control, states, stops };
}

/** 接続を開く（connect して、サーバーが open を通知する）。 */
export async function openConnection(f: EngineFixture): Promise<void> {
  f.engine.connect();
  f.transport.handlers?.onOpen();
  await flush();
}

export async function addPending(
  storage: InMemoryStoragePort,
  eventId: string,
  type = "temperature",
): Promise<void> {
  await storage.append(makeEvent(eventId, "room-a", type));
}
