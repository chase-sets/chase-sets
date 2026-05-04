import { loadObservabilityConfig, startObservability } from "@chase-sets/observability";

export const platformWorkerObservability = startObservability(
  loadObservabilityConfig(process.env, {
    serviceName: "platform-worker",
    serviceVersion: "0.1.0",
  }),
);
