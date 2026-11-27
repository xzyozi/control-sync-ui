// lib に DOM を含めず、@types/node にも依存しないため、使う分のブラウザ API の型だけを、
// ここで宣言する。実行時は、グローバルの fetch、EventSource、AbortController を使う。

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface RequestInitLike {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: unknown;
}

export type FetchLike = (
  url: string,
  init?: RequestInitLike,
) => Promise<ResponseLike>;

export interface MessageEventLike {
  readonly data: string;
}

export interface EventSourceLike {
  /** 0: CONNECTING、1: OPEN、2: CLOSED */
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: MessageEventLike) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export type EventSourceConstructor = new (url: string) => EventSourceLike;

export interface AbortControllerLike {
  readonly signal: unknown;
  abort(): void;
}

export type AbortControllerConstructor = new () => AbortControllerLike;

/** EventSource の readyState: 接続が閉じられ、再接続されない。 */
export const EVENT_SOURCE_CLOSED = 2;
