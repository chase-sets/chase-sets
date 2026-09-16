import { createTransport } from "./transport.js";
import { options } from "./options.js";

const hold = createTransport(chrome.runtime.getManifest(), options.registry);
const state = { pendingFetch: false, pendingTransaction: false, transactionCompleted: false, refusal: null };

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
  const { fires = [], scheduledAt } = await chrome.storage.local.get(["fires", "scheduledAt"]);
  if (fires.length >= 2) return;
  const at = new Date().toISOString();
  await chrome.storage.local.set({ fires: [...fires, at], scheduledAt });
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

globalThis.restartProbe = {
  state,
  async prepare() {
    await ready;
    await chrome.storage.local.set({ localCanary: "SYNTHETIC_LOCAL_CANARY", fires: [], scheduledAt: Date.now() });
    await chrome.storage.session.set({ sessionCanary: "SYNTHETIC_SESSION_CANARY" });
    await chrome.alarms.create("probe-work", { periodInMinutes: 0.5 });
  },
  async startTwo() {
    await chrome.alarms.create("probe-two", { when: Date.now() });
  },
};
