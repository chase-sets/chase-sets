import { SYNTHETIC_CANARY, writeIndexedDbCanary } from "./probe-canary";

let actionClickCount = 0;
let trustedPopupObservation: unknown;

chrome.action.onClicked.addListener(() => {
  actionClickCount += 1;
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== "object" || message === null || !("kind" in message)) return;
  if (message.kind === "probe-worker-ping") {
    sendResponse({ kind: "probe-worker-pong" });
  }
  if (message.kind === "probe-trusted-popup-observation" && "observation" in message) {
    trustedPopupObservation = message.observation;
    sendResponse({ kind: "probe-trusted-popup-observation-recorded" });
  }
});

const authorityProbe = {
  async prepare(): Promise<void> {
    trustedPopupObservation = undefined;
    await chrome.storage.local.set({ authority: SYNTHETIC_CANARY });
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.session.set({ authority: SYNTHETIC_CANARY });
    await writeIndexedDbCanary();
  },
  actionClickCount(): number {
    return actionClickCount;
  },
  trustedPopupObservation(): unknown {
    return trustedPopupObservation;
  },
};

Object.assign(globalThis, { __chaseSetsChromiumAuthorityProbe: authorityProbe });
