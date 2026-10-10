// SYNTHETIC #9257 code-replacement worker. The bundle builder compiles `identity` into these bytes;
// nothing reads it back from the installed directory at runtime, so a stale worker reports its own bytes.
const identity = /* compiled-identity */ null;
const startedAt = new Date().toISOString();
const installs = [];

chrome.runtime.onInstalled.addListener((details) => {
  installs.push({
    reason: details.reason,
    previousVersion: details.previousVersion ?? null,
    observedAt: new Date().toISOString(),
  });
});
// A registered startup listener lets Chromium start the worker on each profile launch without a page or message wake.
chrome.runtime.onStartup.addListener(() => {});

globalThis.codeReplacementProbe = { identity, startedAt, installs };
