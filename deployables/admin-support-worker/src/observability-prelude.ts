import { loadObservabilityConfig, startObservability } from "@chase-sets/observability";

export const adminSupportWorkerObservability = startObservability(
  loadObservabilityConfig(process.env, {
    serviceName: "admin-support-worker",
    serviceVersion: "0.1.0",
  }),
);
