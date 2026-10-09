import { composeConnectorBackground } from "./compose";
import { connectorExecutors } from "./executors";

export const { background, retentionStore } = composeConnectorBackground({ executors: connectorExecutors });
export const boot = background.boot();
