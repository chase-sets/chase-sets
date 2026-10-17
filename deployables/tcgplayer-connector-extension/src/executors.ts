import { createTcgplayerLiveExportExecutor, type ConnectorExecutor } from "@chase-sets/channels/client";

export const connectorExecutors = (
  ports: Parameters<typeof createTcgplayerLiveExportExecutor>[0],
): readonly ConnectorExecutor[] => [createTcgplayerLiveExportExecutor(ports)];
