import {
  createOperatorBackground,
  createSetNamesObservationDispatcher,
  type OperatorAdapters,
} from "@chase-sets/catalog/client";
import { fetchTcgplayerSetNames, createTcgplayerSealedFetch } from "./tcgplayer-set-name-endpoint";

const observationAlarm = "catalog-observation-poll";
const dispatchSetNames = createSetNamesObservationDispatcher(fetchTcgplayerSetNames);
const fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init);

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
  fetch: fetcher,
  dispatchObservationRequest: (_environment, request, post) => dispatchSetNames(request, post),
  setNames: fetchTcgplayerSetNames,
  sealedProducts: createTcgplayerSealedFetch(fetcher),
};
const background = createOperatorBackground(adapters);
async function ensureObservationAlarm() {
  if (!(await chrome.alarms.get(observationAlarm)))
    await chrome.alarms.create(observationAlarm, { periodInMinutes: 5 });
}
const restoreObservationAlarm = () => {
  void ensureObservationAlarm().catch(() => undefined);
};
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === observationAlarm) void background.pollObservations();
});
chrome.runtime.onInstalled.addListener(restoreObservationAlarm);
chrome.runtime.onStartup.addListener(restoreObservationAlarm);
restoreObservationAlarm();
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  const attribution = { id: sender.id, url: sender.url, origin: sender.origin, hasTab: sender.tab !== undefined };
  void background
    .receiveSetNames(message, attribution, chrome.runtime.id)
    .then(async (result) => result ?? background.receive(message, attribution, chrome.runtime.id))
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
