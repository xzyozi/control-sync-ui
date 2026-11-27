/**
 * 同じ eventId のイベントがすでに追記されている（DS §3.2）。
 * 呼び出し元は、追記済みとして扱う。
 */
export class DuplicateEventError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`event already appended: ${eventId}`);
    this.name = "DuplicateEventError";
    this.eventId = eventId;
  }
}
