import { RelayCore, RelayError } from "../src/index";
import type { Envelope, Notification, RelayOptions } from "../src/index";

/** 時間を進められる時計。 */
export class FakeClock {
  private current = 1_000_000;

  now = (): number => this.current;

  advance(ms: number): void {
    this.current += ms;
  }
}

/** 呼び出しごとに、新しい requestId を作る共通項目の生成器（schemaVersion は "1"）。 */
export function createEnv(): (overrides?: Partial<Envelope>) => Envelope {
  let counter = 0;
  return (overrides = {}) => {
    counter += 1;
    return {
      schemaVersion: "1",
      requestId: `req-${counter}`,
      ...overrides,
    };
  };
}

/** テスト全体で使う、共通項目の生成器。requestId は、呼び出しごとに新しい値。 */
export const env = createEnv();

export interface Fixture {
  clock: FakeClock;
  relay: RelayCore;
}

/** Room "room-a" と "room-b" を持つ RelayCore。 */
export function createFixture(options: RelayOptions = {}): Fixture {
  const clock = new FakeClock();
  const relay = new RelayCore({ now: clock.now, ...options });
  relay.createRoom("room-a");
  relay.createRoom("room-b");
  return { clock, relay };
}

/** 対象端末をオンラインにする（接続して、presence を送る）。受け取った通知を返す。 */
export function goOnline(
  relay: RelayCore,
  roomId: string,
  targetId: string,
): Notification[] {
  const received: Notification[] = [];
  relay.connect(roomId, { targetId }, (n) => received.push(n), env());
  relay.presence(roomId, { targetId }, env());
  return received;
}

/** 呼び出しが投げた RelayError を返す。投げなければ undefined。 */
export function errorOf(call: () => unknown): RelayError | undefined {
  try {
    call();
    return undefined;
  } catch (error) {
    if (error instanceof RelayError) {
      return error;
    }
    throw error;
  }
}

/** 呼び出しが RelayError を投げた場合に、その code を返す。投げなければ undefined。 */
export function errorCodeOf(call: () => unknown): string | undefined {
  return errorOf(call)?.code;
}

export const ALL_FILTER = { mode: "ALL" } as const;
export const TYPES_FILTER = { mode: "TYPES", types: ["temperature"] } as const;
