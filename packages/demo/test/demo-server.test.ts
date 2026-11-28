import { afterEach, describe, expect, it } from "vitest";
import { type DemoServer, startDemoServer } from "../src/index";

const servers: DemoServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await server.close();
    }
  }
});

async function fetchText(
  url: string,
): Promise<{ status: number; contentType: string; body: string }> {
  const res = await fetch(url);
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body: await res.text(),
  };
}

describe("DemoServer (2画面デモ配信・API結合)", () => {
  it("2画面 HTML とブラウザ向け ESM モジュール一式を解決して配信できる", async () => {
    const server = await startDemoServer({ port: 0 });
    servers.push(server);

    const index = await fetchText(`${server.baseUrl}/`);
    expect(index.status).toBe(200);
    expect(index.contentType).toContain("text/html");
    expect(index.body).toContain("/target.html");
    expect(index.body).toContain("/operator.html");

    const targetHtml = await fetchText(`${server.baseUrl}/target.html`);
    expect(targetHtml.status).toBe(200);
    expect(targetHtml.body).toContain("/modules/demo/browser/target-app.js");

    const operatorHtml = await fetchText(`${server.baseUrl}/operator.html`);
    expect(operatorHtml.status).toBe(200);
    expect(operatorHtml.body).toContain("/modules/demo/browser/operator-app.js");

    // 配信されるすべての相対インポートが 200 OK で取得できることを再帰的に検証する。
    const entryPoints = [
      "/modules/core/index.js",
      "/modules/storage-indexeddb/index.js",
      "/modules/transport-http/index.js",
      "/modules/demo/browser/target-app.js",
      "/modules/demo/browser/operator-app.js",
    ];
    const visited = new Set<string>();
    const queue = [...entryPoints];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) {
        continue;
      }
      visited.add(current);

      const res = await fetchText(`${server.baseUrl}${current}`);
      expect(res.status, `module ${current}`).toBe(200);
      expect(res.contentType).toContain("application/javascript");

      const importRe = /(?:from|import)\s*["'](\.\.?\/[^"']+?)["']/g;
      for (const match of res.body.matchAll(importRe)) {
        const spec = match[1];
        if (spec === undefined) {
          continue;
        }
        expect(spec.endsWith(".js"), `relative import ${spec} in ${current}`).toBe(
          true,
        );
        const resolved = new URL(spec, `http://localhost${current}`).pathname;
        queue.push(resolved);
      }
    }

    // パストラバーサルは拒否される。
    const traversal = await fetchText(
      `${server.baseUrl}/modules/core/../relay/index.js`,
    );
    expect(traversal.status).toBe(404);
  });

  it("/demo-api/rooms/:roomId/summary が制御状態と受信イベントを返す", async () => {
    const server = await startDemoServer({ port: 0 });
    servers.push(server);

    const acq = await fetch(`${server.baseUrl}/rooms/room-demo/lease`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Schema-Version": "1",
        "X-Request-Id": "req-1",
      },
      body: JSON.stringify({ operatorId: "op-1", action: "ACQUIRE" }),
    });
    expect(acq.status).toBe(200);

    const push = await fetch(`${server.baseUrl}/rooms/room-demo/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Schema-Version": "1",
        "X-Request-Id": "req-2",
      },
      body: JSON.stringify({
        targetId: "target-1",
        controlSeq: 1,
        events: [
          { eventId: "ev-1", payload: { type: "temperature", amount: 12 } },
        ],
      }),
    });
    expect(push.status).toBe(200);

    const summaryRes = await fetch(
      `${server.baseUrl}/demo-api/rooms/room-demo/summary?targetId=target-1`,
    );
    expect(summaryRes.status).toBe(200);
    const summary = (await summaryRes.json()) as {
      controlSeq: number;
      control: { holderId: string | null };
      targetOnline: boolean;
      serverEvents: Array<{ eventId: string; eventSeq: number; amount: number }>;
    };
    expect(summary.controlSeq).toBe(1);
    expect(summary.control.holderId).toBe("op-1");
    expect(summary.targetOnline).toBe(false);
    expect(summary.serverEvents).toHaveLength(1);
    expect(summary.serverEvents[0]).toMatchObject({
      eventId: "ev-1",
      eventSeq: 1,
      amount: 12,
    });
  });
});
