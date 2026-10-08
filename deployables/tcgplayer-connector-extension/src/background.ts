import { createConnectorBackground } from "@chase-sets/channels/client";
import { chromeStorage } from "./adapters/chrome-storage";
import { chromeSession } from "./adapters/chrome-session";
import { chromeAlarms } from "./adapters/chrome-alarms";
import { chromeIdentity } from "./adapters/chrome-identity";
import { chromeAction } from "./adapters/chrome-action";
import { chromeRuntime } from "./adapters/chrome-runtime";

export const background = createConnectorBackground({
  storage: chromeStorage(),
  session: chromeSession(),
  alarms: chromeAlarms(),
  identity: chromeIdentity(),
  action: chromeAction(),
  runtime: chromeRuntime(),
  sweep: { run: async () => ({ ok: true, nextDeadline: null }) },
  transport: {
    platformOrigin: import.meta.env.VITE_PLATFORM_API_URL,
    clientId: import.meta.env.VITE_CONNECTOR_CLIENT_ID,
    request: (request) => fetch(request),
  },
  clock: { now: Date.now },
});

export const boot = background.boot();
