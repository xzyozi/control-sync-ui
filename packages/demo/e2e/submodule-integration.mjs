import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build as esbuild } from "esbuild";

const execFile = promisify(execFileCb);

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SELF_DIR, "../../..");
const TSC_BIN = path.resolve(REPO_ROOT, "node_modules/.bin/tsc");

async function run(cmd, args, cwd) {
  const { stdout, stderr } = await execFile(cmd, args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ci-test",
      GIT_AUTHOR_EMAIL: "ci-test@example.com",
      GIT_COMMITTER_NAME: "ci-test",
      GIT_COMMITTER_EMAIL: "ci-test@example.com",
    },
  });
  return { stdout, stderr };
}

const PARENT_TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022", "DOM"],
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    rootDir: "src",
    outDir: "dist",
  },
  include: ["src"],
};

const PARENT_APP_TS = `import assert from "node:assert/strict";
import {
  ControlStore,
  DomainStore,
  InMemoryStoragePort,
  type Reducer,
  type StoredEvent,
} from "@csu/core";
import { IndexedDbStoragePort } from "@csu/storage-indexeddb";
import { HttpTransport } from "@csu/transport-http";
import { RelayCore, startRelayServer } from "@csu/relay";

const reducer: Reducer<number> = (state, event: StoredEvent) => {
  const amount = event.payload.amount;
  return state + (typeof amount === "number" ? amount : 0);
};

// 型定義・エクスポートの結合確認（ブラウザ実行専用クラスが参照可能であること）。
assert.equal(typeof IndexedDbStoragePort.open, "function");

const relay = new RelayCore({ schemaVersion: "1" });
relay.createRoom("parent-room");
const server = await startRelayServer(relay, { port: 0 });

try {
  const storage = new InMemoryStoragePort();
  const domain = new DomainStore(storage, "parent-room", reducer, 0);
  await domain.apply({ eventId: "p-1", payload: { type: "add", amount: 21 } });
  assert.equal(domain.state, 21);

  const controlStore = new ControlStore();
  const transport = new HttpTransport({
    baseUrl: server.baseUrl,
    schemaVersion: "1",
  });

  const snapshot = await transport.fetchControl({
    roomId: "parent-room",
    targetId: "parent-target",
    requestId: "parent-req-1",
  });
  controlStore.applyControl(snapshot.controlSeq, snapshot.control);
  assert.equal(controlStore.getControlSeq(), 0);
  assert.equal(controlStore.getControl().sendFilter.mode, "NONE");

  await transport.sendPresence({
    roomId: "parent-room",
    targetId: "parent-target",
    requestId: "parent-req-2",
  });
} finally {
  await server.close();
}
`;

async function verifyParentMode(mode, parentPackageJson) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), `csu-parent-${mode}-`));
  try {
    await run("git", ["init"], tmpDir);
    await run(
      "git",
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        REPO_ROOT,
        "libs/control-sync-ui",
      ],
      tmpDir,
    );

    const submoduleDir = path.join(tmpDir, "libs/control-sync-ui");
    await run("npm", ["ci"], submoduleDir);
    await run("npm", ["run", "build"], submoduleDir);

    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify(parentPackageJson, null, 2),
      "utf-8",
    );
    await writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify(PARENT_TSCONFIG, null, 2),
      "utf-8",
    );
    await mkdir(path.join(tmpDir, "src"), { recursive: true });
    await writeFile(path.join(tmpDir, "src/app.ts"), PARENT_APP_TS, "utf-8");

    // 公開レジストリへ問い合わせずローカルサブモジュールだけで解決できることを --offline で検証する。
    await run("npm", ["install", "--offline"], tmpDir);

    // 1. TypeScript コンパイル（.d.ts 型定義解決と strict: true の確認）
    await run(TSC_BIN, ["-p", "tsconfig.json"], tmpDir);

    // 2. Node ネイティブ ESM 実行（package.json の exports 解決と .js 拡張子の確認）
    await run("node", ["dist/app.js"], tmpDir);

    // 3. バンドラ（esbuild）での ESM バンドル＆実行確認
    await esbuild({
      entryPoints: [path.join(tmpDir, "src/app.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: path.join(tmpDir, "dist/bundle.mjs"),
    });
    await run("node", ["dist/bundle.mjs"], tmpDir);

    console.log(`[submodule-integration] mode=${mode} passed.`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  await verifyParentMode("workspaces", {
    name: "dummy-parent-workspaces",
    private: true,
    type: "module",
    workspaces: ["libs/control-sync-ui/packages/*"],
    dependencies: {
      "@csu/core": "*",
      "@csu/storage-indexeddb": "*",
      "@csu/transport-http": "*",
      "@csu/relay": "*",
    },
  });

  await verifyParentMode("file-deps", {
    name: "dummy-parent-file",
    private: true,
    type: "module",
    dependencies: {
      "@csu/core": "file:libs/control-sync-ui/packages/core",
      "@csu/storage-indexeddb":
        "file:libs/control-sync-ui/packages/storage-indexeddb",
      "@csu/transport-http":
        "file:libs/control-sync-ui/packages/transport-http",
      "@csu/relay": "file:libs/control-sync-ui/packages/relay",
    },
  });

  assert.ok(true);
  console.log("[submodule-integration] All parent consumption checks passed.");
}

main().catch((err) => {
  console.error("[submodule-integration] Failed:", err);
  process.exit(1);
});
