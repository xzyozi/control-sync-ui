import type { EventSourceLike, MessageEventLike } from "@csu/transport-http";

interface StreamReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly body: { getReader(): StreamReaderLike } | null;
}

declare function fetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: unknown },
): Promise<FetchResponseLike>;

/**
 * Node.js の `fetch` ストリームを使って実サーバーの SSE（IF-003）に接続する
 * テスト用 `EventSourceLike` 実装。
 */
export class NodeSseEventSource implements EventSourceLike {
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEventLike) => void) | null = null;
  onerror: (() => void) | null = null;

  private readonly controller = new AbortController();
  private closed = false;

  constructor(url: string) {
    void this.start(url);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readyState = 2;
    this.controller.abort();
  }

  private async start(url: string): Promise<void> {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: this.controller.signal,
      });
      if (!res.ok || res.body === null) {
        if (!this.closed) {
          this.readyState = 2;
          this.onerror?.();
        }
        return;
      }

      if (this.closed) {
        await res.body.getReader().cancel().catch(() => {});
        return;
      }

      this.readyState = 1; // OPEN
      this.onopen?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!this.closed) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const sep = buffer.indexOf("\n\n");
          if (sep === -1) {
            break;
          }
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLines: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
          if (dataLines.length > 0 && !this.closed) {
            this.onmessage?.({ data: dataLines.join("\n") });
          }
        }
      }

      if (!this.closed) {
        this.readyState = 2;
        this.onerror?.();
      }
    } catch {
      if (!this.closed) {
        this.readyState = 2;
        this.onerror?.();
      }
    }
  }
}
