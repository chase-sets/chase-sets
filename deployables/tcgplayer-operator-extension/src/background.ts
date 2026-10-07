import {
  createOperatorBackground,
  operatorCookieName,
  operatorCookieUrl,
  type OperatorAdapters,
} from "@chase-sets/catalog/client";

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
  readCookie: () => chrome.cookies.get({ name: operatorCookieName, url: operatorCookieUrl, storeId: "0" }),
  async schedule(environment, when) {
    await chrome.alarms.create(`operator-session.${environment}`, { when });
  },
  async badge(required) {
    await chrome.action.setBadgeText({ text: required ? "!" : "" });
  },
  fetch: globalThis.fetch.bind(globalThis),
  now: Date.now,
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
chrome.cookies.onChanged.addListener((change) => {
  void background.cookieChanged(change);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "operator-session.renew") void background.resume();
  else if (alarm.name === "operator-session.staging") void background.alarm("staging");
  else if (alarm.name === "operator-session.production") void background.alarm("production");
});
async function resume() {
  await chrome.alarms.create("operator-session.renew", { periodInMinutes: 30 });
  await background.resume();
}
chrome.runtime.onInstalled.addListener(() => {
  void resume();
});
chrome.runtime.onStartup.addListener(() => {
  void resume();
});
void resume();
