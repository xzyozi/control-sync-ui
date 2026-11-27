import type { StoragePort } from "./ports";
import type { DomainEventInput, Reducer } from "./types";

/**
 * Domain Store（DD F-001）。状態遷移は純粋関数（Reducer）で行い、
 * イベントを StoragePort に追記する。復元は、保存済みのイベントを順に適用する。
 */
export class DomainStore<S> {
  private current: S;

  constructor(
    private readonly storage: StoragePort,
    private readonly roomId: string,
    private readonly reducer: Reducer<S>,
    private readonly initialState: S,
  ) {
    this.current = initialState;
  }

  get state(): S {
    return this.current;
  }

  /**
   * イベントを追記し、状態を更新する。追記に失敗した場合は、状態を更新しない
   * （StoragePort のエラーを、そのまま投げる）。
   */
  async apply(input: Omit<DomainEventInput, "roomId">): Promise<S> {
    const stored = await this.storage.append({ ...input, roomId: this.roomId });
    this.current = this.reducer(this.current, stored);
    return this.current;
  }

  /** 保存済みのイベントから、状態を復元する。同じイベント列から、常に同じ状態になる。 */
  async restore(): Promise<S> {
    const events = await this.storage.readAll(this.roomId);
    this.current = events.reduce(this.reducer, this.initialState);
    return this.current;
  }
}
