import type { SendFilter } from "@csu/core";
import {
  DEFAULT_DEMO_OPERATOR_ID,
  DEFAULT_DEMO_ROOM_ID,
  DEFAULT_DEMO_TARGET_ID,
  DEMO_SCHEMA_VERSION,
} from "../shared.js";

interface SummaryResponse {
  readonly roomId: string;
  readonly controlSeq: number;
  readonly control: {
    readonly sendFilter: SendFilter;
    readonly holderId: string | null;
  };
  readonly targetOnline: boolean;
  readonly serverEvents: readonly {
    readonly eventSeq: number;
    readonly eventId: string;
    readonly targetId: string;
    readonly type: string;
    readonly amount: number;
  }[];
}

function el(testId: string): HTMLElement {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  if (!(node instanceof HTMLElement)) {
    throw new Error(`missing element: ${testId}`);
  }
  return node;
}

function inputEl(testId: string): HTMLInputElement {
  const node = el(testId);
  if (!(node instanceof HTMLInputElement)) {
    throw new Error(`expected input element: ${testId}`);
  }
  return node;
}

function selectEl(testId: string): HTMLSelectElement {
  const node = el(testId);
  if (!(node instanceof HTMLSelectElement)) {
    throw new Error(`expected select element: ${testId}`);
  }
  return node;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("roomId") ?? DEFAULT_DEMO_ROOM_ID;
  const targetId = params.get("targetId") ?? DEFAULT_DEMO_TARGET_ID;
  const initialOperatorId =
    params.get("operatorId") ?? DEFAULT_DEMO_OPERATOR_ID;
  const relayBaseUrl = (
    params.get("relayBaseUrl") ?? window.location.origin
  ).replace(/\/+$/, "");

  el("op-room").textContent = roomId;
  el("op-target-id").textContent = targetId;
  inputEl("input-operator-id").value = initialOperatorId;

  let seq = 0;
  const nextRequestId = (): string => {
    seq += 1;
    return `op-${Date.now()}-${seq}`;
  };

  async function refresh(): Promise<void> {
    const res = await fetch(
      `${relayBaseUrl}/demo-api/rooms/${encodeURIComponent(roomId)}/summary?targetId=${encodeURIComponent(targetId)}`,
    );
    if (!res.ok) {
      return;
    }
    const summary = (await res.json()) as SummaryResponse;
    el("target-online").textContent = summary.targetOnline
      ? "ONLINE"
      : "OFFLINE";
    el("op-control-seq").textContent = String(summary.controlSeq);
    el("op-holder-id").textContent = summary.control.holderId ?? "null";
    el("op-send-filter").textContent = JSON.stringify(
      summary.control.sendFilter,
    );
    el("server-event-count").textContent = String(summary.serverEvents.length);

    const list = el("server-events");
    list.replaceChildren(
      ...summary.serverEvents.map((item) => {
        const li = document.createElement("li");
        li.textContent = `seq=${item.eventSeq} ${item.eventId} (${item.targetId}) type=${item.type} amount=${item.amount}`;
        return li;
      }),
    );
  }

  async function callApi(path: string, body: unknown): Promise<void> {
    el("op-error").textContent = "";
    const res = await fetch(`${relayBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Schema-Version": DEMO_SCHEMA_VERSION,
        "X-Request-Id": nextRequestId(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
      };
      el("op-error").textContent = `${err.code ?? `HTTP_${res.status}`}: ${err.message ?? "request failed"}`;
    }
    await refresh();
  }

  function currentOperatorId(): string {
    return inputEl("input-operator-id").value.trim() || DEFAULT_DEMO_OPERATOR_ID;
  }

  el("btn-acquire").addEventListener("click", () => {
    void callApi(`/rooms/${encodeURIComponent(roomId)}/lease`, {
      operatorId: currentOperatorId(),
      action: "ACQUIRE",
    });
  });

  el("btn-renew").addEventListener("click", () => {
    void callApi(`/rooms/${encodeURIComponent(roomId)}/lease`, {
      operatorId: currentOperatorId(),
      action: "RENEW",
    });
  });

  el("btn-release").addEventListener("click", () => {
    void callApi(`/rooms/${encodeURIComponent(roomId)}/lease`, {
      operatorId: currentOperatorId(),
      action: "RELEASE",
    });
  });

  el("btn-apply-filter").addEventListener("click", () => {
    const mode = selectEl("select-filter-mode").value as
      | "NONE"
      | "ALL"
      | "TYPES";
    const rawTypes = inputEl("input-filter-types").value;
    const types = rawTypes
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const sendFilter: SendFilter =
      mode === "TYPES" ? { mode, types } : { mode };
    void callApi(`/rooms/${encodeURIComponent(roomId)}/control`, {
      operatorId: currentOperatorId(),
      targetId,
      sendFilter,
    });
  });

  // サーバー更新通知（SSE）を購読し、変更があるたびにサマリを再取得する。
  const observerId = `operator-observer-${Date.now()}`;
  const es = new EventSource(
    `${relayBaseUrl}/rooms/${encodeURIComponent(roomId)}/notifications?targetId=${encodeURIComponent(observerId)}&schemaVersion=${encodeURIComponent(DEMO_SCHEMA_VERSION)}&requestId=${encodeURIComponent(nextRequestId())}`,
  );
  es.onmessage = () => {
    void refresh();
  };

  window.setInterval(() => {
    void refresh();
  }, 500);

  await refresh();
}

void main().catch((error: unknown) => {
  const errEl = document.querySelector('[data-testid="op-error"]');
  if (errEl instanceof HTMLElement) {
    errEl.textContent =
      error instanceof Error ? error.message : String(error);
  }
});
