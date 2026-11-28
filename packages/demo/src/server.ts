import {
  type IncomingRequest,
  RelayCore,
  type RelayOptions,
  type RelayServer,
  type RelayServerOptions,
  type ServerResponseLike,
  startRelayServer,
} from "@csu/relay";
import {
  DEFAULT_DEMO_ROOM_ID,
  DEMO_SCHEMA_VERSION,
} from "./shared";
import {
  renderIndexHtml,
  renderOperatorHtml,
  renderTargetHtml,
} from "./pages";

interface FsModuleLike {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
}

interface PathModuleLike {
  dirname(p: string): string;
  resolve(...segments: string[]): string;
}

interface UrlModuleLike {
  fileURLToPath(url: string): string;
}

interface TranspileModuleLike {
  transpileModule(
    input: string,
    transpileOptions: {
      compilerOptions: { module: number; target: number };
    },
  ): { outputText: string };
  ModuleKind: { ESNext: number };
  ScriptTarget: { ES2022: number };
}

export interface DemoServerOptions extends RelayOptions, RelayServerOptions {
  /** 事前に作成しておく Room ID 一覧（既定: `[DEFAULT_DEMO_ROOM_ID, "room-e2e"]`）。 */
  readonly initialRooms?: readonly string[];
  /** `packages/` ルートの位置（テスト注入用）。 */
  readonly packagesRoot?: string;
}

export interface DemoServer extends RelayServer {
  readonly relay: RelayCore;
  createRoom(roomId: string): void;
}

interface ServerEventRecord {
  readonly eventSeq: number;
  readonly eventId: string;
  readonly targetId: string;
  readonly type: string;
  readonly amount: number;
}

const ALLOWED_PACKAGES = new Set([
  "core",
  "storage-indexeddb",
  "transport-http",
  "demo",
]);

const MODULE_PATH_RE =
  /^\/modules\/(core|storage-indexeddb|transport-http|demo)\/([a-zA-Z0-9_/-]+\.js)$/;
const DEMO_SUMMARY_RE = /^\/demo-api\/rooms\/([^/]+)\/summary$/;

async function importNodeBuiltin<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

async function resolveDefaultPackagesRoot(): Promise<string> {
  const pathMod = await importNodeBuiltin<PathModuleLike>("node:path");
  const urlMod = await importNodeBuiltin<UrlModuleLike>("node:url");
  const selfDir = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
  return pathMod.resolve(selfDir, "../..");
}

function rewriteModuleImports(code: string): string {
  return code.replace(
    /((?:from|import)\s*["'])(\.\.?\/[^"']+?)(["'])/g,
    (_full, pre: string, spec: string, post: string) =>
      spec.endsWith(".js") ? `${pre}${spec}${post}` : `${pre}${spec}.js${post}`,
  );
}

function writeText(
  res: ServerResponseLike,
  status: number,
  contentType: string,
  body: string,
): void {
  if (res.writableEnded) {
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(body);
}

function parseQuery(rawUrl: string): {
  readonly pathname: string;
  readonly query: URLSearchParams;
} {
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) {
    return { pathname: rawUrl, query: new URLSearchParams() };
  }
  return {
    pathname: rawUrl.slice(0, qIndex),
    query: new URLSearchParams(rawUrl.slice(qIndex + 1)),
  };
}

/**
 * 2画面デモ用の HTTP サーバーを起動する。
 * `/rooms/*` は `RelayCore`（IF-001〜IF-006）へ委譲し、HTML とビルド済み ESM を配信する。
 */
export async function startDemoServer(
  options: DemoServerOptions = {},
): Promise<DemoServer> {
  const now = options.now ?? (() => Date.now());
  const schemaVersion = options.schemaVersion ?? DEMO_SCHEMA_VERSION;
  const presenceTtlMs = options.presenceTtlMs ?? 15_000;
  const relay = new RelayCore({
    ...options,
    now,
    schemaVersion,
    presenceTtlMs,
  });

  const initialRooms = options.initialRooms ?? [
    DEFAULT_DEMO_ROOM_ID,
    "room-e2e",
  ];
  for (const roomId of initialRooms) {
    relay.createRoom(roomId);
  }

  const sseCounts = new Map<string, Map<string, number>>();
  const presenceExpiry = new Map<string, Map<string, number>>();
  const roomEvents = new Map<string, Map<number, ServerEventRecord>>();

  const getCounter = (
    outer: Map<string, Map<string, number>>,
    roomId: string,
  ): Map<string, number> => {
    let inner = outer.get(roomId);
    if (inner === undefined) {
      inner = new Map();
      outer.set(roomId, inner);
    }
    return inner;
  };

  // RelayCore の契約を変えずにデモ画面用の状態サマリを収集する薄いラッパー。
  const observedRelay = {
    createRoom: (roomId: string) => relay.createRoom(roomId),
    tick: () => relay.tick(),
    nextExpiry: () => relay.nextExpiry(),
    getControl: (
      roomId: string,
      request: { targetId: string },
      env: Parameters<RelayCore["getControl"]>[2],
    ) => relay.getControl(roomId, request, env),
    lease: (
      roomId: string,
      request: { operatorId: string; action: string },
      env: Parameters<RelayCore["lease"]>[2],
    ) => relay.lease(roomId, request, env),
    changeControl: (
      roomId: string,
      request: { operatorId: string; targetId: string; sendFilter: unknown },
      env: Parameters<RelayCore["changeControl"]>[2],
    ) => relay.changeControl(roomId, request, env),
    presence: (
      roomId: string,
      request: { targetId: string },
      env: Parameters<RelayCore["presence"]>[2],
    ) => {
      relay.presence(roomId, request, env);
      getCounter(presenceExpiry, roomId).set(
        request.targetId,
        now() + presenceTtlMs,
      );
    },
    connect: (
      roomId: string,
      request: { targetId: string },
      listener: Parameters<RelayCore["connect"]>[2],
      env: Parameters<RelayCore["connect"]>[3],
    ) => {
      const closeInner = relay.connect(roomId, request, listener, env);
      const counts = getCounter(sseCounts, roomId);
      counts.set(request.targetId, (counts.get(request.targetId) ?? 0) + 1);
      let closed = false;
      return () => {
        if (closed) {
          return;
        }
        closed = true;
        const next = (counts.get(request.targetId) ?? 1) - 1;
        if (next <= 0) {
          counts.delete(request.targetId);
        } else {
          counts.set(request.targetId, next);
        }
        closeInner();
      };
    },
    pushEvents: (
      roomId: string,
      request: { targetId: string; controlSeq: number; events: unknown },
      env: Parameters<RelayCore["pushEvents"]>[2],
    ) => {
      const res = relay.pushEvents(roomId, request, env);
      let log = roomEvents.get(roomId);
      if (log === undefined) {
        log = new Map();
        roomEvents.set(roomId, log);
      }
      const rawEvents = Array.isArray(request.events) ? request.events : [];
      const payloadById = new Map<
        string,
        { readonly type: string; readonly amount: number }
      >();
      for (const item of rawEvents) {
        if (
          typeof item === "object" &&
          item !== null &&
          typeof (item as { eventId?: unknown }).eventId === "string"
        ) {
          const rec = item as {
            eventId: string;
            payload?: { type?: unknown; amount?: unknown };
          };
          const type =
            typeof rec.payload?.type === "string" ? rec.payload.type : "unknown";
          const amount =
            typeof rec.payload?.amount === "number" ? rec.payload.amount : 0;
          payloadById.set(rec.eventId, { type, amount });
        }
      }
      for (const acc of res.accepted) {
        if (!log.has(acc.eventSeq)) {
          const meta = payloadById.get(acc.eventId) ?? {
            type: "unknown",
            amount: 0,
          };
          log.set(acc.eventSeq, {
            eventSeq: acc.eventSeq,
            eventId: acc.eventId,
            targetId: request.targetId,
            type: meta.type,
            amount: meta.amount,
          });
        }
      }
      return res;
    },
  };

  const fsMod = await importNodeBuiltin<FsModuleLike>("node:fs/promises");
  const pathMod = await importNodeBuiltin<PathModuleLike>("node:path");
  const packagesRoot =
    options.packagesRoot ?? (await resolveDefaultPackagesRoot());
  let tsCompiler: TranspileModuleLike | null = null;

  async function loadBrowserModule(
    pkg: string,
    subpath: string,
  ): Promise<string | null> {
    if (!ALLOWED_PACKAGES.has(pkg) || subpath.includes("..")) {
      return null;
    }
    const distFile = pathMod.resolve(packagesRoot, pkg, "dist", subpath);
    try {
      const js = await fsMod.readFile(distFile, "utf-8");
      return rewriteModuleImports(js);
    } catch {
      const tsFile = pathMod.resolve(
        packagesRoot,
        pkg,
        "src",
        subpath.replace(/\.js$/, ".ts"),
      );
      try {
        const tsSource = await fsMod.readFile(tsFile, "utf-8");
        if (tsCompiler === null) {
          tsCompiler = await importNodeBuiltin<TranspileModuleLike>("typescript");
        }
        const compiled = tsCompiler.transpileModule(tsSource, {
          compilerOptions: {
            module: tsCompiler.ModuleKind.ESNext,
            target: tsCompiler.ScriptTarget.ES2022,
          },
        });
        return rewriteModuleImports(compiled.outputText);
      } catch {
        return null;
      }
    }
  }

  const httpMod = await importNodeBuiltin<{
    createServer: NonNullable<RelayServerOptions["createServer"]>;
  }>("node:http");

  async function handleDemoOrRelay(
    req: IncomingRequest,
    res: ServerResponseLike,
    relayHandler: (req: IncomingRequest, res: ServerResponseLike) => void,
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const { pathname, query } = parseQuery(req.url ?? "/");

    if (method === "GET" && pathname === "/") {
      writeText(res, 200, "text/html; charset=utf-8", renderIndexHtml());
      return;
    }
    if (method === "GET" && pathname === "/target.html") {
      writeText(res, 200, "text/html; charset=utf-8", renderTargetHtml());
      return;
    }
    if (method === "GET" && pathname === "/operator.html") {
      writeText(res, 200, "text/html; charset=utf-8", renderOperatorHtml());
      return;
    }

    if (method === "GET") {
      const modMatch = MODULE_PATH_RE.exec(pathname);
      if (modMatch !== null) {
        const pkg = modMatch[1] ?? "";
        const subpath = modMatch[2] ?? "";
        const content = await loadBrowserModule(pkg, subpath);
        if (content === null) {
          writeText(res, 404, "text/plain; charset=utf-8", "module not found");
          return;
        }
        writeText(
          res,
          200,
          "application/javascript; charset=utf-8",
          content,
        );
        return;
      }

      const summaryMatch = DEMO_SUMMARY_RE.exec(pathname);
      if (summaryMatch !== null) {
        const roomId = decodeURIComponent(summaryMatch[1] ?? "");
        const targetId = query.get("targetId") ?? "target-1";
        try {
          const snapshot = relay.getControl(
            roomId,
            { targetId },
            { schemaVersion, requestId: `demo-summary-${now()}` },
          );
          const connected = (sseCounts.get(roomId)?.get(targetId) ?? 0) > 0;
          const expiresAt = presenceExpiry.get(roomId)?.get(targetId);
          const targetOnline =
            connected && expiresAt !== undefined && expiresAt > now();
          const events = [...(roomEvents.get(roomId)?.values() ?? [])].sort(
            (a, b) => a.eventSeq - b.eventSeq,
          );
          writeText(
            res,
            200,
            "application/json; charset=utf-8",
            JSON.stringify({
              roomId,
              controlSeq: snapshot.controlSeq,
              control: snapshot.control,
              targetOnline,
              serverEvents: events,
            }),
          );
        } catch {
          writeText(
            res,
            404,
            "application/json; charset=utf-8",
            JSON.stringify({ code: "ROOM_NOT_FOUND" }),
          );
        }
        return;
      }
    }

    relayHandler(req, res);
  }

  const demoServer = await startRelayServer(
    observedRelay as unknown as RelayCore,
    {
      ...options,
      createServer: (relayHandler) =>
        (options.createServer ?? httpMod.createServer)((req, res) => {
          void handleDemoOrRelay(req, res, relayHandler);
        }),
    },
  );

  return {
    port: demoServer.port,
    baseUrl: demoServer.baseUrl,
    close: () => demoServer.close(),
    relay,
    createRoom: (roomId: string) => relay.createRoom(roomId),
  };
}
