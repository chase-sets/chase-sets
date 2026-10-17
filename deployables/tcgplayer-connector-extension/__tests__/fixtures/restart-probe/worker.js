import { createTransport } from "./transport.js";
import { options } from "./options.js";

const hold = createTransport(chrome.runtime.getManifest(), options.registry);
const state = { pendingFetch: false, pendingTransaction: false, transactionCompleted: false, refusal: null };
const startedAt = new Date().toISOString();
const ensures = [];
let inFlightEnsure;
let prepared;
const initialPreparation = new Promise((resolve) => {
  prepared = resolve;
});

function ensureAlarm(entrypoint) {
  const invocation = { entrypoint, startedAt: new Date().toISOString(), coalesced: !!inFlightEnsure };
  ensures.push(invocation);
  if (!inFlightEnsure) {
    inFlightEnsure = (async () => {
      const { localCanary } = await chrome.storage.local.get("localCanary");
      if (!localCanary) await initialPreparation;
      const existing = await chrome.alarms.get("probe-work");
      const createStartedAt = existing ? null : new Date().toISOString();
      if (!existing) await chrome.alarms.create("probe-work", { periodInMinutes: 0.5 });
      return {
        getResult: existing ?? null,
        created: !existing,
        createStartedAt,
        alarm: await chrome.alarms.get("probe-work"),
      };
    })().finally(() => {
      inFlightEnsure = undefined;
    });
  }
  return inFlightEnsure.then((result) => {
    Object.assign(invocation, result, { settledAt: new Date().toISOString() });
    return invocation;
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const ready = (async () => {
  if (options.deleteOnStartup) await requestResult(indexedDB.deleteDatabase("restart-probe"));
  const request = indexedDB.open("restart-probe", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: "id" });
  return requestResult(request);
})();

async function write(records) {
  const database = await ready;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("records", "readwrite");
    for (const record of records) transaction.objectStore("records").put(record);
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
}

async function work() {
  const { localCanary, fires = [] } = await chrome.storage.local.get(["localCanary", "fires"]);
  if (!localCanary) await initialPreparation;
  if (fires.length >= 2) return;
  const at = new Date().toISOString();
  await chrome.storage.local.set({ fires: [...fires, at] });
  if (!options.orderingMutant && fires.length === 0) await write([{ id: "op-1", state: "dispatched", at }]);
  try {
    state.pendingFetch = true;
    await hold();
    state.pendingFetch = false;
    if (options.orderingMutant && fires.length === 0) await write([{ id: "op-1", state: "dispatched", at }]);
    await write([{ id: "op-1", state: "receipt-captured" }]);
  } catch (error) {
    state.pendingFetch = false;
    state.refusal = error.message;
  }
}

async function two() {
  const database = await ready;
  const transaction = database.transaction("records", "readwrite");
  const records = transaction.objectStore("records");
  records.put({ id: "op-1", state: "two-record", at: "SYNTHETIC_ATOMIC_CANARY" });
  records.put({ id: "op-2", state: "two-record", at: "SYNTHETIC_ATOMIC_CANARY" });
  state.pendingTransaction = true;
  // Keep real IDB requests outstanding across the termination boundary, not a simulated transaction.
  const deadline = performance.now() + 15_000;
  function keepPending() {
    if (performance.now() < deadline) records.get("op-1").onsuccess = keepPending;
  }
  keepPending();
  transaction.oncomplete = () => {
    state.pendingTransaction = false;
    state.transactionCompleted = true;
  };
  transaction.onabort = () => {
    state.pendingTransaction = false;
  };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "probe-work") void work();
  if (alarm.name === "probe-two") void two();
});
chrome.runtime.onStartup.addListener(() => {
  if (!options.omitAlarmReensure) void ensureAlarm("onStartup");
});
chrome.runtime.onInstalled.addListener((details) => {
  if (!options.omitAlarmReensure) void ensureAlarm(`onInstalled:${details.reason}`);
});
const startupReady = options.omitAlarmReensure ? Promise.resolve() : ensureAlarm("top-level");

globalThis.restartProbe = {
  state,
  ensures,
  startedAt,
  startupReady,
  ensureAlarm,
  async prepare() {
    await ready;
    await chrome.storage.local.set({ localCanary: "SYNTHETIC_LOCAL_CANARY", fires: [] });
    await chrome.storage.session.set({ sessionCanary: "SYNTHETIC_SESSION_CANARY" });
    prepared();
    if (options.omitAlarmReensure) await ensureAlarm("prepare");
    await startupReady;
    return { preparedAt: new Date().toISOString(), alarm: await chrome.alarms.get("probe-work"), ensures };
  },
  async startTwo() {
    await chrome.alarms.create("probe-two", { when: Date.now() });
  },
};
