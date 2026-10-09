/// <reference types="vite/client" />
import {
  createConnectorBackground,
  createConnectorOperationCoordinator,
  createConnectorRetentionStore,
  type ConnectorExecutor,
} from "@chase-sets/channels/client";
import { chromeStorage } from "./adapters/chrome-storage";
import { chromeSession } from "./adapters/chrome-session";
import { chromeAlarms } from "./adapters/chrome-alarms";
import { chromeIdentity } from "./adapters/chrome-identity";
import { chromeAction } from "./adapters/chrome-action";
import { chromeRuntime } from "./adapters/chrome-runtime";
import { chromeIndexedDB } from "./adapters/chrome-indexeddb";
import { connectorTransport } from "./adapters/connector-transport";
import { connectorHostRegistry } from "./host-registry";

export function composeConnectorBackground({ executors }: Readonly<{ executors: readonly ConnectorExecutor[] }>) {
  const session = chromeSession();
  const alarms = chromeAlarms();
  const database = chromeIndexedDB();
  const clock = { now: () => Date.now() };
  const platformOrigin = import.meta.env.VITE_PLATFORM_API_URL;
  const request = connectorTransport({
    platformOrigin,
    hostRegistry: connectorHostRegistry,
    permissionRegistry: ["identity", "storage", "alarms"],
  });
  const retentionStore = createConnectorRetentionStore({
    ...database,
    session,
    clock,
    scheduleDeadline: (when) => alarms.create("connector-retention-deadline", { when }),
  });
  const coordinator = createConnectorOperationCoordinator({ ...database, executors, platformOrigin, request, clock });
  const background = createConnectorBackground({
    storage: chromeStorage(),
    session,
    alarms,
    identity: chromeIdentity(),
    action: chromeAction(),
    runtime: chromeRuntime(),
    sweep: retentionStore,
    transport: {
      platformOrigin,
      clientId: import.meta.env.VITE_CONNECTOR_CLIENT_ID,
      request,
      coordinate: coordinator.coordinate,
    },
    clock,
  });
  return { background, retentionStore };
}
