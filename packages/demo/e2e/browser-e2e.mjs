import assert from "node:assert/strict";
import process from "node:process";
import { chromium } from "playwright";
import { startDemoServer } from "../dist/index.js";

async function waitForText(page, testId, expected, timeoutMs = 8000) {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const actual = (await locator.textContent())?.trim() ?? "";
    if (actual === expected) {
      return;
    }
    await page.waitForTimeout(40);
  }
  const last = (await locator.textContent())?.trim() ?? "";
  const opErr =
    (
      await page
        .getByTestId("op-error")
        .textContent({ timeout: 100 })
        .catch(() => "")
    )?.trim() ?? "";
  const targetErr =
    (
      await page
        .getByTestId("target-error")
        .textContent({ timeout: 100 })
        .catch(() => "")
    )?.trim() ?? "";
  throw new Error(
    `Timed out waiting for [data-testid="${testId}"] to equal "${expected}", got "${last}" (opError="${opErr}", targetError="${targetErr}")`,
  );
}

async function waitForContains(page, testId, substring, timeoutMs = 8000) {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const actual = (await locator.textContent()) ?? "";
    if (actual.includes(substring)) {
      return;
    }
    await page.waitForTimeout(40);
  }
  const last = (await locator.textContent()) ?? "";
  throw new Error(
    `Timed out waiting for [data-testid="${testId}"] to contain "${substring}", got "${last}"`,
  );
}

function attachErrorCollector(page, name, errors, shouldIgnore = () => false) {
  page.on("pageerror", (err) => {
    if (!shouldIgnore()) {
      errors.push(`[${name}] pageerror: ${err.message}`);
    }
  });
  page.on("console", (msg) => {
    if (msg.type() === "error" && !shouldIgnore()) {
      const text = msg.text();
      const locUrl = msg.location()?.url ?? "";
      const isExpectedRelay4xx =
        locUrl.includes("/rooms/") &&
        (text.includes("status of 403") || text.includes("status of 409"));
      if (!isExpectedRelay4xx) {
        errors.push(`[${name}] console.error (${locUrl}): ${text}`);
      }
    }
  });
  page.on("response", (res) => {
    const url = res.url();
    const isAppAsset =
      url.includes("/modules/") ||
      url.endsWith("/target.html") ||
      url.endsWith("/operator.html") ||
      url.endsWith("/");
    if (isAppAsset && res.status() >= 400 && !shouldIgnore()) {
      errors.push(`[${name}] asset HTTP ${res.status()}: ${url}`);
    }
  });
}

async function main() {
  const initialRooms = [
    "room-demo",
    "room-must-a",
    "room-must-b",
    "room-order",
    "room-lease",
    "room-cors",
    "room-iso-1",
    "room-iso-2",
  ];

  // demo 配信サーバー（別オリジン A）と別ポートの relay サーバー（別オリジン B、短い lease TTL）を用意する。
  const server = await startDemoServer({
    port: 0,
    initialRooms,
    leaseTtlMs: 15_000,
    presenceTtlMs: 2_500,
  });
  const crossOriginRelay = await startDemoServer({
    port: 0,
    initialRooms: ["room-cors", "room-lease"],
    leaseTtlMs: 2_000,
    presenceTtlMs: 2_500,
  });

  const executablePath = process.env.CHROME_PATH || undefined;
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath !== undefined ? { executablePath } : {}),
  });
  const errors = [];

  try {
    // 0. 2画面統合シェル (/) がエラーなく読み込めることを確認。
    const shellCtx = await browser.newContext();
    const shellPage = await shellCtx.newPage();
    attachErrorCollector(shellPage, "shell", errors);
    await shellPage.goto(`${server.baseUrl}/`, { waitUntil: "domcontentloaded" });
    assert.equal(await shellPage.locator("iframe").count(), 2);
    await shellCtx.close();

    // =========================================================================
    // Must A & B: 2画面のリアルタイム同期 + 動的送信制御 + 関心の分離 +
    //             SENT/PENDING 混在時のリロード復元と非再送（FR-01〜FR-03）
    // =========================================================================
    const ctxAB = await browser.newContext();
    const targetAB = await ctxAB.newPage();
    const operatorAB = await ctxAB.newPage();
    attachErrorCollector(targetAB, "must-ab-target", errors);
    attachErrorCollector(operatorAB, "must-ab-operator", errors);

    await targetAB.goto(
      `${server.baseUrl}/target.html?roomId=room-must-a&targetId=t-ab&presenceIntervalMs=300`,
      { waitUntil: "domcontentloaded" },
    );
    await operatorAB.goto(
      `${server.baseUrl}/operator.html?roomId=room-must-a&targetId=t-ab&operatorId=op-1`,
      { waitUntil: "domcontentloaded" },
    );

    await waitForText(targetAB, "sync-state", "Ready");
    await waitForText(operatorAB, "target-online", "ONLINE");

    // 制御状態を変えてもドメイン状態は変化しない（関心の分離）。
    await operatorAB.getByTestId("btn-acquire").click();
    await waitForText(operatorAB, "op-holder-id", "op-1");
    await waitForText(targetAB, "domain-total", "0");

    // NONE 中に 2 件追記 → ローカル状態は 15 だが送信されない。
    await targetAB.getByTestId("input-event-type").fill("temperature");
    await targetAB.getByTestId("input-event-amount").fill("10");
    await targetAB.getByTestId("btn-add-event").click();
    await waitForText(targetAB, "domain-count", "1");

    await targetAB.getByTestId("input-event-type").fill("humidity");
    await targetAB.getByTestId("input-event-amount").fill("5");
    await targetAB.getByTestId("btn-add-event").click();
    await waitForText(targetAB, "domain-total", "15");
    await waitForText(targetAB, "domain-count", "2");
    await waitForText(targetAB, "pending-count", "2");
    await waitForText(operatorAB, "server-event-count", "0");

    // TYPES=["temperature"] を適用 → 1 件目 (temperature) のみ送信され、humidity は PENDING のまま残る。
    await operatorAB.getByTestId("select-filter-mode").selectOption("TYPES");
    await operatorAB.getByTestId("input-filter-types").fill("temperature");
    await operatorAB.getByTestId("btn-apply-filter").click();
    await waitForText(operatorAB, "op-control-seq", "2");
    await waitForText(targetAB, "pending-count", "1");
    await waitForText(operatorAB, "server-event-count", "1");
    await waitForContains(operatorAB, "server-events", "temperature");

    // さらにもう 1 件 temperature を追加し localSeq 順で送られることも確認。
    await targetAB.getByTestId("input-event-type").fill("temperature");
    await targetAB.getByTestId("input-event-amount").fill("20");
    await targetAB.getByTestId("btn-add-event").click();
    await waitForText(targetAB, "domain-total", "35");
    await waitForText(targetAB, "domain-count", "3");
    await waitForText(targetAB, "pending-count", "1");
    await waitForText(operatorAB, "server-event-count", "2");

    // Must B: SENT (2件) と PENDING (1件) が混在した状態でリロード。
    // 実 IndexedDB から合計 35 / 件数 3 / pending 1 が復元され、既送イベントが再送されない。
    await targetAB.reload({ waitUntil: "domcontentloaded" });
    await waitForText(targetAB, "sync-state", "Ready");
    await waitForText(targetAB, "domain-total", "35");
    await waitForText(targetAB, "domain-count", "3");
    await waitForText(targetAB, "pending-count", "1");
    await waitForText(operatorAB, "server-event-count", "2");

    // ALL に切り替えると未送信の humidity のみが送信され、合計 3 件になる。
    await operatorAB.getByTestId("select-filter-mode").selectOption("ALL");
    await operatorAB.getByTestId("btn-apply-filter").click();
    await waitForText(targetAB, "pending-count", "0");
    await waitForText(operatorAB, "server-event-count", "3");
    await waitForContains(operatorAB, "server-events", "humidity");
    await ctxAB.close();

    // =========================================================================
    // Must C: オフライン拒否 (TARGET_OFFLINE) と
    //         再接続時の Control-First Sync (IF-001 完了 -> IF-002 送信の順序)
    // =========================================================================
    const ctxOrder = await browser.newContext();
    const targetHelper = await ctxOrder.newPage();
    const targetMain = await ctxOrder.newPage();
    const operatorOrder = await ctxOrder.newPage();
    attachErrorCollector(targetHelper, "order-helper", errors);
    attachErrorCollector(targetMain, "order-main", errors);
    attachErrorCollector(operatorOrder, "order-op", errors);

    // 1. まず helper がオンラインで ALL フィルタを確定させておき、その後 main は未接続 (autoConnect=false) で開く。
    await targetHelper.goto(
      `${server.baseUrl}/target.html?roomId=room-order&targetId=t-helper&presenceIntervalMs=300`,
      { waitUntil: "domcontentloaded" },
    );
    await operatorOrder.goto(
      `${server.baseUrl}/operator.html?roomId=room-order&targetId=t-helper&operatorId=op-1`,
      { waitUntil: "domcontentloaded" },
    );
    await waitForText(targetHelper, "sync-state", "Ready");
    await waitForText(operatorOrder, "target-online", "ONLINE");

    await operatorOrder.getByTestId("btn-acquire").click();
    await waitForText(operatorOrder, "op-holder-id", "op-1");
    await operatorOrder.getByTestId("select-filter-mode").selectOption("ALL");
    await operatorOrder.getByTestId("btn-apply-filter").click();
    await waitForText(operatorOrder, "op-control-seq", "2");

    // helper が切断してオフラインになった直後の TARGET_OFFLINE を確認。
    await targetHelper.getByTestId("btn-disconnect").click();
    await waitForText(targetHelper, "sync-state", "Disconnected");
    await waitForText(operatorOrder, "target-online", "OFFLINE");
    await operatorOrder.getByTestId("btn-apply-filter").click();
    await waitForContains(operatorOrder, "op-error", "TARGET_OFFLINE");

    // 2. targetMain はオフラインのままローカルでイベントを蓄積し、その後接続してネットワーク順序を記録する。
    await targetMain.goto(
      `${server.baseUrl}/target.html?roomId=room-order&targetId=t-main&autoConnect=false&presenceIntervalMs=300`,
      { waitUntil: "domcontentloaded" },
    );
    await waitForText(targetMain, "sync-state", "Disconnected");
    await targetMain.getByTestId("input-event-type").fill("temperature");
    await targetMain.getByTestId("input-event-amount").fill("9");
    await targetMain.getByTestId("btn-add-event").click();
    await waitForText(targetMain, "pending-count", "1");

    const networkLog = [];
    targetMain.on("request", (req) => {
      const url = req.url();
      if (url.includes("/rooms/room-order/events") && req.method() === "POST") {
        networkLog.push("events:start");
      }
    });
    targetMain.on("requestfinished", (req) => {
      const url = req.url();
      if (url.includes("/rooms/room-order/control") && req.method() === "GET") {
        networkLog.push("control:finished");
      } else if (
        url.includes("/rooms/room-order/events") &&
        req.method() === "POST"
      ) {
        networkLog.push("events:finished");
      }
    });

    await targetMain.getByTestId("btn-connect").click();
    await waitForText(targetMain, "sync-state", "Ready");
    await waitForText(targetMain, "pending-count", "0");

    const controlDoneIdx = networkLog.indexOf("control:finished");
    const eventsStartIdx = networkLog.indexOf("events:start");
    assert.ok(controlDoneIdx !== -1, `missing control:finished in ${networkLog}`);
    assert.ok(eventsStartIdx !== -1, `missing events:start in ${networkLog}`);
    assert.ok(
      controlDoneIdx < eventsStartIdx,
      `Control-First violation: ${JSON.stringify(networkLog)}`,
    );
    await ctxOrder.close();

    // =========================================================================
    // Must D: 3画面（対象1 + 操作2）での排他ロック競合、RELEASE、タブ閉鎖 + TTL 解放
    // =========================================================================
    const ctxLease = await browser.newContext();
    const targetLease = await ctxLease.newPage();
    const opCtxA = await browser.newContext();
    const opCtxB = await browser.newContext();
    const opPageA = await opCtxA.newPage();
    const opPageB = await opCtxB.newPage();
    attachErrorCollector(targetLease, "lease-target", errors);
    attachErrorCollector(opPageA, "lease-opA", errors);
    attachErrorCollector(opPageB, "lease-opB", errors);

    const shortLeaseParam = encodeURIComponent(crossOriginRelay.baseUrl);
    await targetLease.goto(
      `${server.baseUrl}/target.html?roomId=room-lease&targetId=t-lease&relayBaseUrl=${shortLeaseParam}&presenceIntervalMs=300`,
      { waitUntil: "domcontentloaded" },
    );
    await opPageA.goto(
      `${server.baseUrl}/operator.html?roomId=room-lease&targetId=t-lease&operatorId=op-a&relayBaseUrl=${shortLeaseParam}`,
      { waitUntil: "domcontentloaded" },
    );
    await opPageB.goto(
      `${server.baseUrl}/operator.html?roomId=room-lease&targetId=t-lease&operatorId=op-b&relayBaseUrl=${shortLeaseParam}`,
      { waitUntil: "domcontentloaded" },
    );
    await waitForText(targetLease, "sync-state", "Ready");

    // 未保持の op-b がフィルタ変更すると LOCK_NOT_HELD。
    await opPageB.getByTestId("select-filter-mode").selectOption("ALL");
    await opPageB.getByTestId("btn-apply-filter").click();
    await waitForContains(opPageB, "op-error", "LOCK_NOT_HELD");

    // op-a が ACQUIRE → op-b は LOCK_HELD_BY_OTHER。
    await opPageA.getByTestId("btn-acquire").click();
    await waitForText(opPageA, "op-holder-id", "op-a");
    await waitForText(targetLease, "target-holder-id", "op-a");

    await opPageB.getByTestId("btn-acquire").click();
    await waitForContains(opPageB, "op-error", "LOCK_HELD_BY_OTHER");

    // op-a が RELEASE → op-b が ACQUIRE できる。
    await opPageA.getByTestId("btn-release").click();
    await waitForText(opPageA, "op-holder-id", "null");
    await opPageB.getByTestId("btn-acquire").click();
    await waitForText(opPageB, "op-holder-id", "op-b");
    await waitForText(targetLease, "target-holder-id", "op-b");

    // op-b のタブを閉じた後、lease TTL (1.5s) 経過で自動解放され op-a が再取得できる。
    await opCtxB.close();
    await waitForText(targetLease, "target-holder-id", "null", 5000);
    await opPageA.getByTestId("btn-acquire").click();
    await waitForText(opPageA, "op-holder-id", "op-a");
    await waitForText(targetLease, "target-holder-id", "op-a");

    await opCtxA.close();
    await ctxLease.close();

    // =========================================================================
    // Should E1: 別オリジン CORS（OPTIONS プリフライト + カスタムヘッダー + SSE）と
    //            ネットワーク瞬断からの SSE 自動復旧
    // =========================================================================
    const ctxCors = await browser.newContext();
    const targetCors = await ctxCors.newPage();
    const opCors = await ctxCors.newPage();
    let ignoreOfflineNoise = false;
    attachErrorCollector(
      targetCors,
      "cors-target",
      errors,
      () => ignoreOfflineNoise,
    );
    attachErrorCollector(opCors, "cors-op", errors, () => ignoreOfflineNoise);

    const relayParam = encodeURIComponent(crossOriginRelay.baseUrl);
    await targetCors.goto(
      `${server.baseUrl}/target.html?roomId=room-cors&targetId=t-cors&relayBaseUrl=${relayParam}&presenceIntervalMs=300&retryDelayMs=100`,
      { waitUntil: "domcontentloaded" },
    );
    await opCors.goto(
      `${server.baseUrl}/operator.html?roomId=room-cors&targetId=t-cors&operatorId=op-cors&relayBaseUrl=${relayParam}`,
      { waitUntil: "domcontentloaded" },
    );

    await waitForText(targetCors, "sync-state", "Ready");
    await waitForText(opCors, "target-online", "ONLINE");

    // 別オリジン越しに Lease 取得 & ALL 適用が成功すること（CORS プリフライト通過）。
    await opCors.getByTestId("btn-acquire").click();
    await waitForText(opCors, "op-holder-id", "op-cors");
    await opCors.getByTestId("select-filter-mode").selectOption("ALL");
    await opCors.getByTestId("btn-apply-filter").click();
    await waitForText(targetCors, "target-control-seq", "2");

    // ネットワーク瞬断 (offline -> online) からの自動復旧。
    ignoreOfflineNoise = true;
    await ctxCors.setOffline(true);
    await targetCors.waitForTimeout(250);
    await ctxCors.setOffline(false);
    await waitForText(targetCors, "sync-state", "Ready", 8000);
    await waitForText(opCors, "target-online", "ONLINE", 8000);
    ignoreOfflineNoise = false;

    // 復旧後にもイベント追加・SSE/Push 同期が正常に動く。
    await targetCors.getByTestId("input-event-type").fill("recovered");
    await targetCors.getByTestId("input-event-amount").fill("77");
    await targetCors.getByTestId("btn-add-event").click();
    await waitForText(targetCors, "pending-count", "0");
    await waitForText(opCors, "server-event-count", "1");
    await ctxCors.close();

    // =========================================================================
    // Should E2: Room の完全分離（TC-008 / TC-117）
    // =========================================================================
    const ctxIso1 = await browser.newContext();
    const ctxIso2 = await browser.newContext();
    const targetIso1 = await ctxIso1.newPage();
    const opIso1 = await ctxIso1.newPage();
    const targetIso2 = await ctxIso2.newPage();
    const opIso2 = await ctxIso2.newPage();
    attachErrorCollector(targetIso1, "iso1-target", errors);
    attachErrorCollector(opIso1, "iso1-op", errors);
    attachErrorCollector(targetIso2, "iso2-target", errors);
    attachErrorCollector(opIso2, "iso2-op", errors);

    await targetIso1.goto(
      `${server.baseUrl}/target.html?roomId=room-iso-1&targetId=t-1&presenceIntervalMs=300`,
      { waitUntil: "domcontentloaded" },
    );
    await opIso1.goto(
      `${server.baseUrl}/operator.html?roomId=room-iso-1&targetId=t-1&operatorId=op-1`,
      { waitUntil: "domcontentloaded" },
    );
    await targetIso2.goto(
      `${server.baseUrl}/target.html?roomId=room-iso-2&targetId=t-2&presenceIntervalMs=300`,
      { waitUntil: "domcontentloaded" },
    );
    await opIso2.goto(
      `${server.baseUrl}/operator.html?roomId=room-iso-2&targetId=t-2&operatorId=op-2`,
      { waitUntil: "domcontentloaded" },
    );

    await waitForText(targetIso1, "sync-state", "Ready");
    await waitForText(targetIso2, "sync-state", "Ready");

    await opIso1.getByTestId("btn-acquire").click();
    await opIso1.getByTestId("select-filter-mode").selectOption("ALL");
    await opIso1.getByTestId("btn-apply-filter").click();
    await targetIso1.getByTestId("btn-add-event").click();
    await waitForText(opIso1, "server-event-count", "1");

    // room-iso-2 は影響を受けない。
    await waitForText(targetIso2, "target-control-seq", "0");
    await waitForText(targetIso2, "target-send-filter", '{"mode":"NONE"}');
    await waitForText(opIso2, "server-event-count", "0");
    await ctxIso1.close();
    await ctxIso2.close();

    // =========================================================================
    // Should E3: IndexedDB 異常系（meta.storageVersion === "2" による安全停止, TC-203）
    // =========================================================================
    const ctxCorrupt = await browser.newContext();
    const corruptPage = await ctxCorrupt.newPage();
    attachErrorCollector(corruptPage, "corrupt", errors);

    await corruptPage.goto(
      `${server.baseUrl}/target.html?roomId=room-must-b&targetId=t-corrupt&autoConnect=false`,
      { waitUntil: "domcontentloaded" },
    );
    await waitForText(corruptPage, "sync-state", "Disconnected");
    await corruptPage.getByTestId("input-event-amount").fill("33");
    await corruptPage.getByTestId("btn-add-event").click();
    await waitForText(corruptPage, "domain-total", "33");

    // 実 IndexedDB の meta.storageVersion を "2" に書き換えてからリロードする。
    await corruptPage.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const req = indexedDB.open("csu-demo-room-must-b-t-corrupt", 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(["meta"], "readwrite");
          tx.objectStore("meta").put({ key: "storageVersion", value: "2" });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    });

    await corruptPage.reload({ waitUntil: "domcontentloaded" });
    await waitForText(corruptPage, "sync-state", "Error");
    await waitForContains(
      corruptPage,
      "target-error",
      "UnsupportedStorageVersionError",
    );

    // 既存 events レコードが壊されずに残っていることを確認。
    const preservedEvents = await corruptPage.evaluate(async () => {
      return await new Promise((resolve, reject) => {
        const req = indexedDB.open("csu-demo-room-must-b-t-corrupt", 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(["events"], "readonly");
          const allReq = tx.objectStore("events").getAll();
          allReq.onsuccess = () => {
            const count = allReq.result.length;
            db.close();
            resolve(count);
          };
          allReq.onerror = () => reject(allReq.error);
        };
      });
    });
    assert.equal(preservedEvents, 1);
    await ctxCorrupt.close();

    assert.deepEqual(errors, []);
    console.log(
      "[e2e] Browser E2E passed: Must (A-D) and Should (E) verified in Chromium.",
    );
  } finally {
    await browser.close();
    await crossOriginRelay.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error("[e2e] Browser E2E failed:", err);
  process.exit(1);
});
