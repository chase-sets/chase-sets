import { createOperatorBackground, type OperatorAdapters } from "@chase-sets/catalog/client";

const adapters: OperatorAdapters = {
  storage: {
    trust: () => chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    async read(key) {
      return (await chrome.storage.local.get(key))[key];
    },
    async write(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
  },
  async badge(required) {
    await chrome.action.setBadgeText({ text: required ? "!" : "" });
  },
  fetch: globalThis.fetch.bind(globalThis),
};
const background = createOperatorBackground(adapters);
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  void background
    .receive(
      message,
      { id: sender.id, url: sender.url, origin: sender.origin, hasTab: sender.tab !== undefined },
      chrome.runtime.id,
    )
    .then(respond);
  return true;
});
chrome.runtime.onMessageExternal.addListener((message: unknown, sender, respond) => {
  void background
    .receiveHandoff(
      message,
      {
        id: sender.id,
        url: sender.url,
        origin: sender.origin,
        frameId: sender.frameId,
        hasTab: sender.tab !== undefined,
      },
      chrome.runtime.id,
    )
    .then(respond);
  return true;
});
