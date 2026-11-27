import { DuplicateEventError } from "./errors";
import type { StoragePort } from "./ports";
import type { DomainEventInput, Reducer } from "./types";

/** `apply` に渡すイベント。roomId は DomainStore が付け、createdAt は省略できる。 */
export type ApplyInput = Omit<DomainEventInput, "roomId" | "createdAt"> & {
  /** 省略した場合は、追記時の時刻（UTC の ISO 8601）を使う（DD §2.3）。 */
  readonly createdAt?: string;
};

/**
 * Domain Store（DD F-001）。状態遷移は純粋関数（Reducer）で行い、
 * イベントを StoragePort に追記する。復元は、保存済みのイベントを順に適用する。
 */
export class DomainStore<S> {
  private current: S;

  /**
   * @param now createdAt の既定値の供給元。テストで固定できるよう、注入できる。
   *   Reducer には渡さない（Reducer は時刻に依存しない純粋関数のまま）。
   */
  constructor(
    private readonly storage: StoragePort,
    private readonly roomId: string,
    private readonly reducer: Reducer<S>,
    private readonly initialState: S,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.current = initialState;
  }

  get state(): S {
    return this.current;
  }

  /**
   * イベントを追記し、状態を更新する。
   * - 追記に失敗した場合は、状態を更新しない（StoragePort のエラーを、そのまま投げる）。
   * - 同じ eventId がすでに追記されている場合は、追記済みとして扱い、
   *   状態を更新せずに、現在の状態を返す（DS §3.2）。
   */
  async apply(input: ApplyInput): Promise<S> {
    try {
      const stored = await this.storage.append({
        ...input,
        roomId: this.roomId,
        createdAt: input.createdAt ?? this.now(),
      });
      this.current = this.reducer(this.current, stored);
    } catch (error) {
      if (!(error instanceof DuplicateEventError)) {
        throw error;
      }
    }
    return this.current;
  }

  /** 保存済みのイベントから、状態を復元する。同じイベント列から、常に同じ状態になる。 */
  async restore(): Promise<S> {
    const events = await this.storage.readAll(this.roomId);
    this.current = events.reduce(this.reducer, this.initialState);
    return this.current;
  }
}
