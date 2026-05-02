import { loadObservabilityConfig, startObservability } from "@chase-sets/observability";

export const platformApiObservability = startObservability(
  loadObservabilityConfig(process.env, {
    serviceName: "platform-api",
    serviceVersion: "0.1.0",
  }),
);
