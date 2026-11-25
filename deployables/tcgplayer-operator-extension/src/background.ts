import {
  createOperatorBackground,
  createSetNamesObservationDispatcher,
  type OperatorAdapters,
} from "@chase-sets/catalog/client";
import { fetchTcgplayerSetNames, createTcgplayerSealedFetch } from "./tcgplayer-set-name-endpoint";

const observationAlarm = "catalog-observation-poll";
const dispatchSetNames = createSetNamesObservationDispatcher(fetchTcgplayerSetNames);

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
  fetch: (input, init) => globalThis.fetch(input, init),
  dispatchObservationRequest: (_environment, request, post) => dispatchSetNames(request, post),
  setNames: fetchTcgplayerSetNames,
  sealedProducts: createTcgplayerSealedFetch(),
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
  if (
    typeof message === "object" &&
    message !== null &&
    "action" in message &&
    (message.action === "fetch-sealed-products" || message.action === "post-sealed-products")
  ) {
    void background
      .receiveSealedProducts(
        message,
        { id: sender.id, url: sender.url, origin: sender.origin, hasTab: sender.tab !== undefined },
        chrome.runtime.id,
      )
      .then(respond);
    return true;
  }
  void background
    .receiveSetNamePost(
      message,
      { id: sender.id, url: sender.url, origin: sender.origin, hasTab: sender.tab !== undefined },
      chrome.runtime.id,
    )
    .then((result) => {
      if (result !== null) {
        respond(result);
        return;
      }
      return background
        .receiveSetNames(
          message,
          { id: sender.id, url: sender.url, origin: sender.origin, hasTab: sender.tab !== undefined },
          chrome.runtime.id,
        )
        .then((probeResult) => {
          if (probeResult !== null) {
            respond(probeResult);
            return;
          }
          return background
            .receive(
              message,
              { id: sender.id, url: sender.url, origin: sender.origin, hasTab: sender.tab !== undefined },
              chrome.runtime.id,
            )
            .then(respond);
        });
    });
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
