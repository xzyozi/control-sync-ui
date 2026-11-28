// `@types/node` に依存せず Node.js の `node:http` と相互運用するための最小の構造型。

export interface IncomingRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  resume?(): void;
}

export interface ServerResponseLike {
  statusCode: number;
  readonly writableEnded?: boolean;
  setHeader(name: string, value: string): void;
  writeHead?(statusCode: number, headers?: Record<string, string>): void;
  write(chunk: string): boolean;
  end(chunk?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface HttpServerLike {
  listen(port: number, host: string, callback: () => void): void;
  address(): { readonly port: number } | string | null;
  close(callback: (err?: Error) => void): void;
  closeAllConnections?(): void;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type CreateServerFn = (
  listener: (req: IncomingRequest, res: ServerResponseLike) => void,
) => HttpServerLike;
