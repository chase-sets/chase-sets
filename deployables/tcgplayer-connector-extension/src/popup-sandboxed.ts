import { readIndexedDbCanary, SYNTHETIC_PLATFORM_URL } from "./probe-canary";

async function captureSandboxedPopup(): Promise<void> {
  const status = new URLSearchParams(location.search).get("status");
  const extensionChrome = (
    globalThis as typeof globalThis & {
      chrome?: {
        storage: {
          local: { get(key: string): Promise<Record<string, unknown>> };
          session: { get(key: string): Promise<Record<string, unknown>> };
        };
      };
    }
  ).chrome;
  const chromeType = typeof extensionChrome;
  let storageLocalReachable = false;
  let storageSessionReachable = false;
  if (chromeType !== "undefined") {
    try {
      storageLocalReachable = Boolean(await extensionChrome?.storage.local.get("authority"));
    } catch {
      // Chromium's refusal is the measured capability.
    }
    try {
      storageSessionReachable = Boolean(await extensionChrome?.storage.session.get("authority"));
    } catch {
      // Probe each storage area independently even when local storage refuses.
    }
  }
  const opened = window.open(SYNTHETIC_PLATFORM_URL);
  const record = {
    origin: location.origin,
    chromeType,
    storageLocalReachable,
    storageSessionReachable,
    indexedDbReachable: await readIndexedDbCanary(),
    queryReceived: status === JSON.stringify({ schemaVersion: 1, state: "synthetic-status" }),
    windowOpenReturnedWindow: opened !== null,
  };
  document.querySelector("#result")!.textContent = JSON.stringify(record);
}

void captureSandboxedPopup();
