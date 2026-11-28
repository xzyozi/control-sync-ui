---
title: "サブモジュール統合手順書（親プロジェクトへの組み込みと初期化）"
document_type: "operation_procedure"
document_role: "procedure"
ssot_scope: "operation"
status: "draft"
version: "1.1"
created_at: "2026-11-28"
updated_at: "2026-11-28"
author: "xzyozi"
owner: "xzyozi"
purpose: "親プロジェクトが control-sync-ui を Git サブモジュールとして取り込み、ビルド・参照・初期化および Port 差し替えを行う手順を定義するため"
related_documents:
  - "ドキュメントガバナンス（相対パス: ../README.md）"
  - "最小要件定義書（相対パス: ../features/CSU-REQ-001_最小要件定義書.md）"
  - "CSU-BD-001 基本設計書（相対パス: ../design/CSU-BD-001_基本設計書.md）"
  - "CSU-ENV-001 環境・開発基盤仕様書（相対パス: ../setup/CSU-ENV-001_環境・開発基盤仕様書.md）"
  - "ADR-008 サブモジュールとしての消費方式（相対パス: ../adr/ADR-008_サブモジュールとしての消費方式.md）"
---

# サブモジュール統合手順書

**親プロジェクトへの Git サブモジュール組み込み・ビルド・初期化・Port 差し替え手順**

---

## 1. 目的・対象範囲

- **目的**: 親プロジェクト（Vite・Webpack・esbuild 等のバンドラ環境、および Node.js サーバー環境）が、`control-sync-ui` を Git サブモジュールとして取り込み、`dist/` 成果物を安定して消費できるようにする。
- **対象**: サブモジュールの追加、ビルド、親プロジェクトの `package.json` 設定（npm workspaces 併用 / `file:` 依存）、初期化、`StoragePort` / `TransportPort` の差し替え。
- **前提**: Node.js 20.x 以上（[CSU-ENV-001](../setup/CSU-ENV-001_環境・開発基盤仕様書.md) §4.1）、[ADR-008](../adr/ADR-008_サブモジュールとしての消費方式.md)（案 A: 親がサブモジュール内でビルドし `dist/` を参照）。

---

## 2. サブモジュールの追加とビルド

親プロジェクトのルート（例として `libs/control-sync-ui` に配置する場合）で以下を実行します。

```bash
git submodule add <repository-url> libs/control-sync-ui
git -C libs/control-sync-ui checkout v0.1.0   # リリース済みタグに固定する場合
git submodule update --init --recursive

# サブモジュール内でロックファイル固定インストールとビルドを実行する
npm --prefix libs/control-sync-ui ci
npm --prefix libs/control-sync-ui run build
```

親プロジェクトの CI でも、ソースチェックアウト後に同じ手順（`submodules: true` → `npm --prefix libs/control-sync-ui ci` → `npm --prefix libs/control-sync-ui run build`）を親のビルド／テストの前に実行してください。

---

## 3. 親プロジェクトからの参照方法

環境に応じて、次のいずれかの方法で参照します（どちらも動作します）。

### 方法 A: npm workspaces 併用（推奨）

親プロジェクト側で npm workspaces を利用している場合、親のルート `package.json` にサブモジュールの `packages/*` を加えます。

```json
{
  "name": "parent-app",
  "private": true,
  "type": "module",
  "workspaces": [
    "apps/*",
    "libs/control-sync-ui/packages/*"
  ],
  "dependencies": {
    "@csu/core": "*",
    "@csu/storage-indexeddb": "*",
    "@csu/transport-http": "*"
  }
}
```

### 方法 B: `file:` 依存（workspaces 未使用の親プロジェクト）

親プロジェクトが workspaces を使わない単一パッケージの場合は、`file:` で各パッケージのディレクトリを直接指定します。サブモジュール内の `@csu/core` への内部依存も `file:../core` で定義されているため、公開レジストリへの問い合わせは発生しません。

```json
{
  "name": "parent-app",
  "private": true,
  "type": "module",
  "dependencies": {
    "@csu/core": "file:libs/control-sync-ui/packages/core",
    "@csu/storage-indexeddb": "file:libs/control-sync-ui/packages/storage-indexeddb",
    "@csu/transport-http": "file:libs/control-sync-ui/packages/transport-http",
    "@csu/relay": "file:libs/control-sync-ui/packages/relay"
  }
}
```

参照設定後、親プロジェクト側で `npm install` を実行してください（`dist/` は `.gitignore` 対象のため、親プロジェクトでも上記の `npm --prefix libs/control-sync-ui run build` が済んでいる必要があります）。

---

## 4. 親プロジェクトでの初期化例

### 4.1 対象端末（ブラウザ）側

```ts
import {
  ControlStore,
  DomainStore,
  SyncEngine,
  type Reducer,
  type StoredEvent,
} from "@csu/core";
import { IndexedDbStoragePort } from "@csu/storage-indexeddb";
import { HttpTransport } from "@csu/transport-http";

interface AppState {
  readonly count: number;
}

const reducer: Reducer<AppState> = (state, event: StoredEvent) => {
  const delta = typeof event.payload.delta === "number" ? event.payload.delta : 0;
  return { count: state.count + delta };
};

export async function startSyncClient(params: {
  baseUrl: string;
  roomId: string;
  targetId: string;
}) {
  const storage = await IndexedDbStoragePort.open({ dbName: "parent-sync" });
  const domainStore = new DomainStore(storage, params.roomId, reducer, {
    count: 0,
  });
  await domainStore.restore();

  const controlStore = new ControlStore();
  const transport = new HttpTransport({
    baseUrl: params.baseUrl,
    schemaVersion: "1",
  });

  let seq = 0;
  const engine = new SyncEngine({
    roomId: params.roomId,
    targetId: params.targetId,
    storage,
    controlStore,
    transport,
    scheduler: {
      setTimeout: (cb, ms) => {
        const id = window.setTimeout(cb, ms);
        return () => window.clearTimeout(id);
      },
      setInterval: (cb, ms) => {
        const id = window.setInterval(cb, ms);
        return () => window.clearInterval(id);
      },
    },
    newRequestId: () => `req-${++seq}-${crypto.randomUUID()}`,
  });

  engine.connect();
  return { domainStore, controlStore, engine, storage };
}
```

### 4.2 サーバー側（単体検証や組み込みリレーを使う場合）

```ts
import { RelayCore, startRelayServer } from "@csu/relay";

const relay = new RelayCore({ schemaVersion: "1" });
relay.createRoom("room-1");
const server = await startRelayServer(relay, { port: 4173 });
```

---

## 5. `StoragePort` と `TransportPort` の差し替え方

`@csu/core` はブラウザ API や通信実装に依存せず、インターフェースのみを定義しています。テストや独自基盤への組み込み時は、各ポートを実装して `DomainStore` / `SyncEngine` に注入します。

- **`StoragePort` の差し替え**:
  - テストやメモリ完結環境では `@csu/core` 同梱の `InMemoryStoragePort` を利用できます。
  - 独自ストレージ（SQLite・OPFS 等）を使う場合は `StoragePort`（`append`・`readAll`・`readPending`・`markSent`）を実装して `new DomainStore(customStorage, ...)` と `new SyncEngine({ storage: customStorage, ... })` に渡します。
- **`TransportPort` の差し替え**:
  - WebSocket・独自の認証付き HTTP クライアント・モック通信を使う場合は `TransportPort`（`fetchControl`・`pushEvents`・`sendPresence`・`connect`）を実装して `new SyncEngine({ transport: customTransport, ... })` に渡します。

---

## 6. 版の更新と互換性確認

- 版の方針の正本は [CSU-ENV-001](../setup/CSU-ENV-001_環境・開発基盤仕様書.md) §4.3 です。
- サブモジュールを更新する際は、`vX.Y.Z` タグを切り替えたうえで `npm --prefix libs/control-sync-ui ci && npm --prefix libs/control-sync-ui run build` を再実行してください。
- `schemaVersion`（通信契約）および `storageVersion`（IndexedDB 保存形式）は v0.1 で `"1"` 固定です。破壊的変更やバージョン更新時はリリースノートの移行手順を確認してください。

---

## 7. 改訂履歴 (Change Log)

| 版数    | 改訂日     | 変更者 | 変更内容・変更理由 (Why)                                              |
| :------ | :--------- | :----- | :-------------------------------------------------------------------- |
| Rev.1.0 | 2026-11-28 | xzyozi | ADR-008（`accepted`）に基づき新規作成。                               |
| Rev.1.1 | 2026-11-28 | xzyozi | §2 にタグ固定例、§6 に版の更新・互換性確認（CSU-ENV-001 §4.3）を追加。 |
