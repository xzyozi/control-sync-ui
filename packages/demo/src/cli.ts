import { startDemoServer } from "./server.js";

declare const process: {
  readonly argv: readonly string[];
  on(event: string, listener: () => void): void;
  exit(code?: number): void;
};

async function run(): Promise<void> {
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  const rawPort = portArg !== undefined ? Number(portArg.slice(7)) : 4173;
  const port = Number.isFinite(rawPort) && rawPort >= 0 ? rawPort : 4173;

  const server = await startDemoServer({ port });
  console.log(`[csu-demo] listening on ${server.baseUrl}`);
  console.log(`[csu-demo] 2-screen UI: ${server.baseUrl}/`);
  console.log(`[csu-demo] Target only: ${server.baseUrl}/target.html`);
  console.log(`[csu-demo] Operator only: ${server.baseUrl}/operator.html`);

  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void run().catch((error: unknown) => {
  console.error("[csu-demo] failed to start:", error);
  process.exit(1);
});
