import { createConnectorOperationCoordinator, type ConnectorExecutor } from "@chase-sets/channels/client";
import { connectorTransport } from "../src/adapters/connector-transport";
import { syntheticExecutor } from "../__tests__/harness/executors.harness";
import { connectorHostRegistry, platformOrigin } from "../__tests__/harness/origins";

let authority: "paired-idle" | "report-only" | "absent" = "paired-idle";
let clock: number | undefined;
let release: (() => void) | undefined;
const request = connectorTransport({
  platformOrigin,
  hostRegistry: connectorHostRegistry,
  permissionRegistry: ["identity", "storage", "alarms"],
});
self.onmessage = async ({ data }) => {
  if (data.action === "release") {
    release?.();
    return;
  }
  if (data.action === "authority") {
    authority = data.value;
    return;
  }
  if (data.action === "clock") {
    clock = data.value;
    return;
  }
  if (data.action !== "coordinate") return;
  const executor: ConnectorExecutor = {
    ...syntheticExecutor(data.unit),
    prepare: async () => {
      self.postMessage({ phase: "prepared" });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ready: true };
    },
  };
  const coordinator = createConnectorOperationCoordinator({
    indexedDB,
    keyRange: IDBKeyRange,
    executors: [executor],
    platformOrigin,
    request,
    clock: { now: () => clock ?? Date.now() },
  });
  const result = await coordinator.coordinate({
    connectionId: "connection_synthetic",
    accessToken: data.accessToken,
    authority: async () => authority,
  });
  self.postMessage({ phase: "settled", result });
};
