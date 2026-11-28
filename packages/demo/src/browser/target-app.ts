import {
  ControlStore,
  DomainStore,
  type DomainEventInput,
  type StoragePort,
  type StoredEvent,
  SyncEngine,
} from "@csu/core";
import { IndexedDbStoragePort } from "@csu/storage-indexeddb";
import { HttpTransport } from "@csu/transport-http";
import {
  DEFAULT_DEMO_ROOM_ID,
  DEFAULT_DEMO_TARGET_ID,
  DEMO_SCHEMA_VERSION,
  INITIAL_DEMO_STATE,
  demoReducer,
} from "../shared.js";

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

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("roomId") ?? DEFAULT_DEMO_ROOM_ID;
  const targetId = params.get("targetId") ?? DEFAULT_DEMO_TARGET_ID;
  const dbName = params.get("dbName") ?? `csu-demo-${roomId}-${targetId}`;
  const relayBaseUrl = (
    params.get("relayBaseUrl") ?? window.location.origin
  ).replace(/\/+$/, "");
  const rawPresence = Number(params.get("presenceIntervalMs") ?? "5000");
  const presenceIntervalMs =
    Number.isFinite(rawPresence) && rawPresence > 0 ? rawPresence : 5000;
  const rawRetry = Number(params.get("retryDelayMs") ?? "0");
  const retryDelaysMs =
    Number.isFinite(rawRetry) && rawRetry > 0
      ? [rawRetry, rawRetry * 2, rawRetry * 4]
      : undefined;
  const autoConnect = params.get("autoConnect") !== "false";

  el("target-room").textContent = roomId;
  el("target-id").textContent = targetId;

  const baseStorage = await IndexedDbStoragePort.open({ dbName });
  let renderPending = false;
  let seq = 0;

  const controlStore = new ControlStore();
  let engine!: SyncEngine;

  const scheduleRender = () => {
    if (renderPending) {
      return;
    }
    renderPending = true;
    queueMicrotask(() => {
      renderPending = false;
      void render();
    });
  };

  // markSent 完了時に UI を即時再描画するための薄いラッパー。
  const storage: StoragePort = {
    append: (event: DomainEventInput): Promise<StoredEvent> =>
      baseStorage.append(event),
    readAll: (r: string): Promise<readonly StoredEvent[]> =>
      baseStorage.readAll(r),
    readPending: (r: string): Promise<readonly StoredEvent[]> =>
      baseStorage.readPending(r),
    markSent: async (eventId: string, eventSeq: number): Promise<void> => {
      await baseStorage.markSent(eventId, eventSeq);
      scheduleRender();
    },
  };

  // ControlStore.applyControl の反映時にも即時再描画する。
  const origApplyControl = controlStore.applyControl.bind(controlStore);
  controlStore.applyControl = (controlSeq, next) => {
    const applied = origApplyControl(controlSeq, next);
    scheduleRender();
    return applied;
  };

  const domainStore = new DomainStore(
    storage,
    roomId,
    demoReducer,
    INITIAL_DEMO_STATE,
  );
  await domainStore.restore();

  const transport = new HttpTransport({
    baseUrl: relayBaseUrl,
    schemaVersion: DEMO_SCHEMA_VERSION,
  });

  engine = new SyncEngine({
    roomId,
    targetId,
    storage,
    controlStore,
    transport,
    presenceIntervalMs,
    ...(retryDelaysMs !== undefined ? { retryDelaysMs } : {}),
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
    newRequestId: () => {
      seq += 1;
      return `target-${targetId}-${Date.now()}-${seq}`;
    },
    onStateChange: () => scheduleRender(),
    onStopped: (reason, error) => {
      el("target-error").textContent =
        `Stopped: ${reason}${error instanceof Error ? ` (${error.message})` : ""}`;
      scheduleRender();
    },
  });

  async function render(): Promise<void> {
    const all = await storage.readAll(roomId);
    const pending = await storage.readPending(roomId);
    const pendingSet = new Set(pending.map((e) => e.eventId));

    const currentControl = controlStore.getControl();
    el("sync-state").textContent = engine.state;
    el("domain-total").textContent = String(domainStore.state.total);
    el("domain-count").textContent = String(domainStore.state.eventCount);
    el("pending-count").textContent = String(pending.length);
    el("target-control-seq").textContent = String(controlStore.getControlSeq());
    el("target-holder-id").textContent = currentControl.holderId ?? "null";
    el("target-send-filter").textContent = JSON.stringify(
      currentControl.sendFilter,
    );

    const list = el("local-events");
    list.replaceChildren(
      ...all.map((e) => {
        const li = document.createElement("li");
        const status = pendingSet.has(e.eventId) ? "PENDING" : "SENT";
        li.textContent = `#${e.localSeq} [${status}] ${e.eventId} type=${e.payload.type} amount=${String(e.payload.amount ?? 0)}`;
        return li;
      }),
    );
  }

  el("btn-connect").addEventListener("click", () => {
    el("target-error").textContent = "";
    engine.connect();
    scheduleRender();
  });

  el("btn-disconnect").addEventListener("click", () => {
    engine.disconnect();
    scheduleRender();
  });

  el("btn-add-event").addEventListener("click", () => {
    void (async () => {
      el("target-error").textContent = "";
      const type = inputEl("input-event-type").value.trim() || "add";
      const amount = Number(inputEl("input-event-amount").value || "0");
      seq += 1;
      const eventId = `ev-${Date.now()}-${seq}`;
      await domainStore.apply({
        eventId,
        payload: { type, amount: Number.isFinite(amount) ? amount : 0 },
      });
      engine.notifyLocalEvents();
      await render();
    })();
  });

  await render();
  if (autoConnect) {
    engine.connect();
    await render();
  }
}

void main().catch((error: unknown) => {
  const stateEl = document.querySelector('[data-testid="sync-state"]');
  if (stateEl instanceof HTMLElement) {
    stateEl.textContent = "Error";
  }
  const errEl = document.querySelector('[data-testid="target-error"]');
  if (errEl instanceof HTMLElement) {
    errEl.textContent =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  }
});
