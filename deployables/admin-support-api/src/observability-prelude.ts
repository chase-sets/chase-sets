import { loadObservabilityConfig, startObservability } from "@chase-sets/observability";

export const adminSupportApiObservability = startObservability(
  loadObservabilityConfig(process.env, {
    serviceName: "admin-support-api",
    serviceVersion: "0.1.0",
  }),
);
