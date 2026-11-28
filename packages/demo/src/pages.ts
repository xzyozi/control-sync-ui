const IMPORT_MAP_HTML = `<script type="importmap">
{
  "imports": {
    "@csu/core": "/modules/core/index.js",
    "@csu/storage-indexeddb": "/modules/storage-indexeddb/index.js",
    "@csu/transport-http": "/modules/transport-http/index.js"
  }
}
</script>`;

const BASE_STYLES = `
  body { font-family: system-ui, -apple-system, sans-serif; margin: 16px; color: #1f2937; background: #f9fafb; }
  h1, h2 { margin: 0 0 12px; }
  .card { background: #ffffff; border: 1px solid #d1d5db; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
  label { font-size: 13px; color: #374151; }
  input, select, button { font-size: 14px; padding: 6px 10px; border-radius: 6px; border: 1px solid #9ca3af; }
  button { background: #2563eb; color: #ffffff; border-color: #2563eb; cursor: pointer; }
  button.secondary { background: #4b5563; border-color: #4b5563; }
  button.danger { background: #dc2626; border-color: #dc2626; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #e5e7eb; }
  .error { color: #b91c1c; font-weight: 600; min-height: 20px; }
  pre, ul { background: #f3f4f6; padding: 8px; border-radius: 6px; font-size: 12px; overflow: auto; margin: 0; }
`;

export function renderIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <link rel="icon" href="data:," />
  <title>control-sync-ui 2画面デモ</title>
  <style>
    ${BASE_STYLES}
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; height: calc(100vh - 96px); }
    iframe { width: 100%; height: 100%; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; }
  </style>
</head>
<body>
  <div class="row" style="justify-content: space-between;">
    <h1>control-sync-ui 2画面デモ (v0.1 MVP)</h1>
    <div>
      <a href="/target.html" target="_blank">対象端末を別タブで開く</a> |
      <a href="/operator.html" target="_blank">外部PCを別タブで開く</a>
    </div>
  </div>
  <div class="grid">
    <iframe title="対象端末" src="/target.html"></iframe>
    <iframe title="外部PC" src="/operator.html"></iframe>
  </div>
</body>
</html>`;
}

export function renderTargetHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <link rel="icon" href="data:," />
  <title>対象端末 - control-sync-ui Demo</title>
  <style>${BASE_STYLES}</style>
  ${IMPORT_MAP_HTML}
</head>
<body>
  <h2>対象端末（Target）</h2>
  <div class="card">
    <div class="row">
      <span>Room: <strong data-testid="target-room"></strong></span>
      <span>Target: <strong data-testid="target-id"></strong></span>
      <span>Sync状態: <span class="badge" data-testid="sync-state">Initializing</span></span>
    </div>
    <div class="row">
      <button type="button" data-testid="btn-connect">接続 (Connect)</button>
      <button type="button" class="secondary" data-testid="btn-disconnect">切断 (Disconnect)</button>
    </div>
    <div class="error" data-testid="target-error"></div>
  </div>

  <div class="card">
    <h3>イベント追記（Domain Store / IndexedDB）</h3>
    <div class="row">
      <label>種別: <input data-testid="input-event-type" value="temperature" /></label>
      <label>値: <input data-testid="input-event-amount" type="number" value="10" /></label>
      <button type="button" data-testid="btn-add-event">イベント追加</button>
    </div>
    <div class="row">
      <span>合計 (total): <strong data-testid="domain-total">0</strong></span>
      <span>件数 (eventCount): <strong data-testid="domain-count">0</strong></span>
      <span>未送信 (pending): <strong data-testid="pending-count">0</strong></span>
    </div>
  </div>

  <div class="card">
    <h3>Control Store（Pull 結果）</h3>
    <div class="row">
      <span>controlSeq: <strong data-testid="target-control-seq">0</strong></span>
      <span>holderId: <strong data-testid="target-holder-id">null</strong></span>
      <span>sendFilter: <strong data-testid="target-send-filter">{"mode":"NONE"}</strong></span>
    </div>
  </div>

  <div class="card">
    <h3>ローカルイベントログ（IndexedDB）</h3>
    <ul data-testid="local-events"></ul>
  </div>

  <script type="module" src="/modules/demo/browser/target-app.js"></script>
</body>
</html>`;
}

export function renderOperatorHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <link rel="icon" href="data:," />
  <title>外部PC操作画面 - control-sync-ui Demo</title>
  <style>${BASE_STYLES}</style>
  ${IMPORT_MAP_HTML}
</head>
<body>
  <h2>外部PC操作画面（Operator）</h2>
  <div class="card">
    <div class="row">
      <span>Room: <strong data-testid="op-room"></strong></span>
      <span>Target: <strong data-testid="op-target-id"></strong></span>
      <span>対象端末状態: <span class="badge" data-testid="target-online">OFFLINE</span></span>
    </div>
    <div class="row">
      <label>操作者ID: <input data-testid="input-operator-id" value="op-1" /></label>
      <button type="button" data-testid="btn-acquire">Lease取得</button>
      <button type="button" class="secondary" data-testid="btn-renew">Lease更新</button>
      <button type="button" class="danger" data-testid="btn-release">Lease解放</button>
    </div>
    <div class="error" data-testid="op-error"></div>
  </div>

  <div class="card">
    <h3>送信対象フィルタ変更（IF-006）</h3>
    <div class="row">
      <label>mode:
        <select data-testid="select-filter-mode">
          <option value="NONE">NONE</option>
          <option value="ALL">ALL</option>
          <option value="TYPES">TYPES</option>
        </select>
      </label>
      <label>types (カンマ区切り): <input data-testid="input-filter-types" value="temperature" /></label>
      <button type="button" data-testid="btn-apply-filter">フィルタ適用</button>
    </div>
    <div class="row">
      <span>controlSeq: <strong data-testid="op-control-seq">0</strong></span>
      <span>holderId: <strong data-testid="op-holder-id">null</strong></span>
      <span>sendFilter: <strong data-testid="op-send-filter">{"mode":"NONE"}</strong></span>
    </div>
  </div>

  <div class="card">
    <h3>サーバー受信イベント（Relay）</h3>
    <div class="row">
      <span>受信件数: <strong data-testid="server-event-count">0</strong></span>
    </div>
    <ul data-testid="server-events"></ul>
  </div>

  <script type="module" src="/modules/demo/browser/operator-app.js"></script>
</body>
</html>`;
}
