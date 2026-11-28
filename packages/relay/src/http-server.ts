import {
  type RelayHttpOptions,
  createRelayHandler,
} from "./http-handler.js";
import type { CreateServerFn } from "./node-types.js";
import type { RelayCore } from "./relay-core.js";
import { isRecord } from "./validation.js";

export interface RelayServerOptions extends RelayHttpOptions {
  /** 待受ホスト（既定 `"127.0.0.1"`）。 */
  readonly host?: string;
  /** 待受ポート（既定 `0`: 空きポートを自動割り当て）。 */
  readonly port?: number;
  /** HTTP サーバー生成関数の注入用。省略時は `node:http` を動的に読み込む。 */
  readonly createServer?: CreateServerFn;
}

export interface RelayServer {
  readonly port: number;
  readonly baseUrl: string;
  /** lease タイマー、すべての SSE 接続、および HTTP サーバーを閉じる。 */
  close(): Promise<void>;
}

async function resolveCreateServer(): Promise<CreateServerFn> {
  const specifier = "node:http";
  const mod: unknown = await import(specifier);
  if (!isRecord(mod) || typeof mod.createServer !== "function") {
    throw new Error("node:http createServer is unavailable");
  }
  return mod.createServer as CreateServerFn;
}

/**
 * `RelayCore` を HTTP / SSE サーバーとして起動する（IF-001〜IF-006）。
 * 停止時は開いている SSE 接続と lease タイマーを片付けてからサーバーを閉じる。
 */
export async function startRelayServer(
  relay: RelayCore,
  options: RelayServerOptions = {},
): Promise<RelayServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const createServer = options.createServer ?? (await resolveCreateServer());
  const controller = createRelayHandler(relay, options);
  const server = createServer(controller.handler);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => {
      server.removeListener?.("error", onError);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    server.on?.("error", onError);
    server.listen(port, host, () => {
      server.removeListener?.("error", onError);
      controller.scheduleLeaseExpiry();
      resolve();
    });
  });

  const addr = server.address();
  const actualPort =
    typeof addr === "object" && addr !== null ? addr.port : port;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const baseUrl = `http://${urlHost}:${actualPort}`;

  let closed = false;
  return {
    port: actualPort,
    baseUrl,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      controller.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}
