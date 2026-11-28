/** JSON にシリアライズできる値（DD §2.3）。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** ドメインイベントの本体。`type` は sendFilter の照合に使う（DD §2.3）。 */
export interface EventPayload {
  type: string;
  [key: string]: JsonValue;
}

/** 追記するドメインイベント（DD §2.3、DS §2.2 `events`）。 */
export interface DomainEventInput {
  readonly eventId: string;
  readonly roomId: string;
  readonly payload: EventPayload;
  /** UTC の ISO 8601。表示用で、順序の判断には使わない。 */
  readonly createdAt: string;
}

/** 追記済みのイベント。`localSeq` は端末内の追記順（DS §2.2）。 */
export interface StoredEvent extends DomainEventInput {
  readonly localSeq: number;
}

/** 送信対象フィルタ（DD §2.3）。 */
export interface SendFilter {
  readonly mode: "ALL" | "NONE" | "TYPES";
  /** `mode` が `TYPES` のとき必須。1件以上。 */
  readonly types?: readonly string[];
  /** 指定した場合、含まれる `targetId` の端末だけが送る。 */
  readonly targetIds?: readonly string[];
}

/** 制御状態（要件定義書 FR-02）。 */
export interface ControlState {
  readonly sendFilter: SendFilter;
  /** 現在の操作権限者。なしの場合は null。 */
  readonly holderId: string | null;
}

/** Outbox が評価した送信対象（DD §2.4）。 */
export interface SendBatch {
  /** 評価に使った Control Store の controlSeq。IF-002 にそのまま使う。 */
  readonly controlSeq: number;
  readonly events: readonly StoredEvent[];
}

/** 状態遷移を行う純粋関数（Reducer）。時刻、乱数、外部状態に依存しない。 */
export type Reducer<S> = (state: S, event: StoredEvent) => S;
