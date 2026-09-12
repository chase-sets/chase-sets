import { readIndexedDbCanary, SYNTHETIC_CANARY } from "./probe-canary";

async function captureTrustedPopup(): Promise<void> {
  const local = await chrome.storage.local.get("authority");
  const session = await chrome.storage.session.get("authority");
  const response = (await chrome.runtime.sendMessage({ kind: "probe-worker-ping" })) as { kind?: string } | undefined;
  const record = {
    origin: location.origin,
    storageLocalCanaryReadable: local.authority === SYNTHETIC_CANARY,
    storageSessionCanaryReadable: session.authority === SYNTHETIC_CANARY,
    indexedDbCanaryReadable: await readIndexedDbCanary(),
    workerMessageReached: response?.kind === "probe-worker-pong",
  };
  await chrome.runtime.sendMessage({ kind: "probe-trusted-popup-observation", observation: record });
  document.querySelector("#result")!.textContent = JSON.stringify(record);
}

void captureTrustedPopup();
