import type { DomainEventInput, StoredEvent } from "./types";

/**
 * 永続化の抽象（BD C-005、D-03）。責務は次の3つだけである。
 * - 追記: `events` は追記だけで、更新も削除もしない。
 * - 順序付きの読み出し: `localSeq` の順。
 * - 送信状態の更新: `PENDING` → `SENT` の一方向だけ。
 *
 * 保存形式は DS を正本とする。
 */
export interface StoragePort {
  /**
   * イベントを追記し、送信状態 `PENDING` を同時に作る（1つの原子的な操作）。
   * 同じ eventId がすでにある場合は DuplicateEventError を投げる。
   */
  append(event: DomainEventInput): Promise<StoredEvent>;

  /** 指定した Room のイベントを、localSeq の順に返す。 */
  readAll(roomId: string): Promise<readonly StoredEvent[]>;

  /** 指定した Room の未送信（PENDING）イベントを、localSeq の順に返す。 */
  readPending(roomId: string): Promise<readonly StoredEvent[]>;

  /** 送信状態を `SENT` にし、サーバーが付けた eventSeq を記録する。 */
  markSent(eventId: string, eventSeq: number): Promise<void>;
}
