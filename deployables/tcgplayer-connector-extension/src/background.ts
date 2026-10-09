/// <reference types="vite/client" />
import { createConnectorBackground, createConnectorRetentionStore } from "@chase-sets/channels/client";
import { chromeStorage } from "./adapters/chrome-storage";
import { chromeSession } from "./adapters/chrome-session";
import { chromeAlarms } from "./adapters/chrome-alarms";
import { chromeIdentity } from "./adapters/chrome-identity";
import { chromeAction } from "./adapters/chrome-action";
import { chromeRuntime } from "./adapters/chrome-runtime";
import { chromeIndexedDB } from "./adapters/chrome-indexeddb";

const session = chromeSession();
const alarms = chromeAlarms();
const clock = { now: () => Date.now() };
export const retentionStore = createConnectorRetentionStore({
  ...chromeIndexedDB(),
  session,
  clock,
  scheduleDeadline: (when) => alarms.create("connector-retention-deadline", { when }),
});

export const background = createConnectorBackground({
  storage: chromeStorage(),
  session,
  alarms,
  identity: chromeIdentity(),
  action: chromeAction(),
  runtime: chromeRuntime(),
  sweep: retentionStore,
  transport: {
    platformOrigin: import.meta.env.VITE_PLATFORM_API_URL,
    clientId: import.meta.env.VITE_CONNECTOR_CLIENT_ID,
    request: (request) => fetch(request),
  },
  clock,
});

export const boot = background.boot();
