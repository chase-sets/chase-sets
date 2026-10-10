import { observeJournal, type Boundary } from "./journal-boundaries";

const reasons: string[] = [];
const alarmFires: { name: string; at: number }[] = [];
const writes = { storage: 0, alarms: 0 };
for (const area of [chrome.storage.local, chrome.storage.session]) {
  for (const name of ["set", "remove"] as const) {
    const original = area[name].bind(area);
    Reflect.set(area, name, (...args: unknown[]) => {
      writes.storage++;
      return Reflect.apply(original, area, args);
    });
  }
}
for (const name of ["create", "clear"] as const) {
  const original = chrome.alarms[name].bind(chrome.alarms);
  Reflect.set(chrome.alarms, name, (...args: unknown[]) => {
    writes.alarms++;
    return Reflect.apply(original, chrome.alarms, args);
  });
}
chrome.runtime.onInstalled.addListener(({ reason }) => {
  reasons.push(reason);
});
chrome.runtime.onStartup.addListener(() => {
  reasons.push("startup");
});
chrome.alarms.onAlarm.addListener(({ name }) => {
  alarmFires.push({ name, at: Date.now() });
});
let observed = observeJournal(indexedDB);
export const observation = {
  reasons,
  alarmFires,
  arm(boundary?: Boundary) {
    observed.restore();
    observed = observeJournal(indexedDB, boundary);
  },
  snapshot() {
    return { reasons, alarmFires, writes, transactions: observed.observations, interrupted: observed.interrupted() };
  },
};
