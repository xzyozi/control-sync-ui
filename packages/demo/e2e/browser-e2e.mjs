import assert from "node:assert/strict";
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
  throw new Error(
    `Timed out waiting for [data-testid="${testId}"] to equal "${expected}", got "${last}"`,
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

function attachErrorCollector(page, name, errors) {
  page.on("pageerror", (err) => {
    errors.push(`[${name}] pageerror: ${err.message}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`[${name}] console.error: ${msg.text()}`);
    }
  });
  page.on("response", (res) => {
    const url = res.url();
    const isAppAsset =
      url.includes("/modules/") ||
      url.endsWith("/target.html") ||
      url.endsWith("/operator.html") ||
      url.endsWith("/");
    if (isAppAsset && res.status() >= 400) {
      errors.push(`[${name}] asset HTTP ${res.status()}: ${url}`);
    }
  });
}

async function main() {
  const server = await startDemoServer({
    port: 0,
    leaseTtlMs: 10_000,
    presenceTtlMs: 1_200,
  });

  const browser = await chromium.launch({ headless: true });
  const errors = [];

  try {
    const context = await browser.newContext();

    // 1. 2画面統合シェル (/) がエラーなく読み込めることを確認。
    const shellPage = await context.newPage();
    attachErrorCollector(shellPage, "shell", errors);
    await shellPage.goto(`${server.baseUrl}/`, { waitUntil: "domcontentloaded" });
    assert.equal(await shellPage.locator("iframe").count(), 2);
    await shellPage.close();

    // 2. 対象端末 (Target) と 外部PC (Operator) を別ページとして開く。
    const targetPage = await context.newPage();
    const operatorPage = await context.newPage();
    attachErrorCollector(targetPage, "target", errors);
    attachErrorCollector(operatorPage, "operator", errors);

    await targetPage.goto(
      `${server.baseUrl}/target.html?roomId=room-e2e&targetId=t-e2e&presenceIntervalMs=300`,
      { waitUntil: "domcontentloaded" },
    );
    await operatorPage.goto(
      `${server.baseUrl}/operator.html?roomId=room-e2e&targetId=t-e2e&operatorId=op-1`,
      { waitUntil: "domcontentloaded" },
    );

    await waitForText(targetPage, "sync-state", "Ready");
    await waitForText(operatorPage, "target-online", "ONLINE");
    await waitForText(operatorPage, "op-send-filter", '{"mode":"NONE"}');

    // 3. FR-03: NONE フィルタ中はローカルに未送信として留まる。
    await targetPage.getByTestId("input-event-type").fill("temperature");
    await targetPage.getByTestId("input-event-amount").fill("10");
    await targetPage.getByTestId("btn-add-event").click();
    await waitForText(targetPage, "domain-total", "10");
    await waitForText(targetPage, "domain-count", "1");
    await waitForText(targetPage, "pending-count", "1");
    await waitForText(operatorPage, "server-event-count", "0");

    // 4. FR-02: Lease 未取得では LOCK_NOT_HELD。
    await operatorPage.getByTestId("select-filter-mode").selectOption("ALL");
    await operatorPage.getByTestId("btn-apply-filter").click();
    await waitForContains(operatorPage, "op-error", "LOCK_NOT_HELD");

    // 5. FR-02 + FR-03: Lease 取得後に TYPES=["temperature"] を適用すると該当イベントのみ送信される。
    await operatorPage.getByTestId("btn-acquire").click();
    await waitForText(operatorPage, "op-holder-id", "op-1");
    await waitForText(operatorPage, "op-control-seq", "1");

    await targetPage.getByTestId("input-event-type").fill("humidity");
    await targetPage.getByTestId("input-event-amount").fill("5");
    await targetPage.getByTestId("btn-add-event").click();
    await waitForText(targetPage, "domain-total", "15");
    await waitForText(targetPage, "pending-count", "2");

    await operatorPage.getByTestId("select-filter-mode").selectOption("TYPES");
    await operatorPage.getByTestId("input-filter-types").fill("temperature");
    await operatorPage.getByTestId("btn-apply-filter").click();
    await waitForText(operatorPage, "op-control-seq", "2");

    await waitForText(targetPage, "pending-count", "1");
    await waitForText(operatorPage, "server-event-count", "1");
    await waitForContains(operatorPage, "server-events", "temperature");

    // 6. FR-03: ALL に切り替えると残りの humidity も送信される。
    await operatorPage.getByTestId("select-filter-mode").selectOption("ALL");
    await operatorPage.getByTestId("btn-apply-filter").click();
    await waitForText(operatorPage, "op-control-seq", "3");

    await waitForText(targetPage, "pending-count", "0");
    await waitForText(operatorPage, "server-event-count", "2");

    // 7. FR-01: リロードしても実ブラウザ IndexedDB から状態と履歴が復元される。
    await targetPage.reload({ waitUntil: "domcontentloaded" });
    await waitForText(targetPage, "sync-state", "Ready");
    await waitForText(targetPage, "domain-total", "15");
    await waitForText(targetPage, "domain-count", "2");
    await waitForText(targetPage, "pending-count", "0");
    await waitForText(targetPage, "target-control-seq", "3");

    // 8. FR-05: 対象端末を切断して presence TTL が切れると TARGET_OFFLINE で即時拒否される。
    await targetPage.getByTestId("btn-disconnect").click();
    await waitForText(targetPage, "sync-state", "Disconnected");
    await waitForText(operatorPage, "target-online", "OFFLINE");

    await operatorPage.getByTestId("select-filter-mode").selectOption("NONE");
    await operatorPage.getByTestId("btn-apply-filter").click();
    await waitForContains(operatorPage, "op-error", "TARGET_OFFLINE");

    // 9. FR-02: 別操作者の ACQUIRE 競合（LOCK_HELD_BY_OTHER）と RELEASE 後の取得。
    await operatorPage.getByTestId("input-operator-id").fill("op-2");
    await operatorPage.getByTestId("btn-acquire").click();
    await waitForContains(operatorPage, "op-error", "LOCK_HELD_BY_OTHER");

    await operatorPage.getByTestId("input-operator-id").fill("op-1");
    await operatorPage.getByTestId("btn-release").click();
    await waitForText(operatorPage, "op-holder-id", "null");

    await operatorPage.getByTestId("input-operator-id").fill("op-2");
    await operatorPage.getByTestId("btn-acquire").click();
    await waitForText(operatorPage, "op-holder-id", "op-2");

    assert.deepEqual(errors, []);
    console.log("[e2e] Browser E2E passed: FR-01 through FR-05 verified in Chromium.");
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error("[e2e] Browser E2E failed:", err);
  process.exit(1);
});
