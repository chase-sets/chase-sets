import csat from "./features/csat/metadata.json" with { type: "json" };
import cases from "./features/cases/metadata.json" with { type: "json" };
import attention from "./features/attention/metadata.json" with { type: "json" };
import privacy from "./features/privacy/metadata.json" with { type: "json" };

export const contextManifest = {
  scheduledJobs: attention.scheduledJobs,
  contextName: "customer-feedback",
  packageName: "@chase-sets/customer-feedback",
  localeCatalogs: [...csat.localeCatalogs, ...attention.localeCatalogs],
  ownedNouns: [...csat.ownedNouns, ...cases.ownedNouns, ...attention.ownedNouns, ...privacy.ownedNouns],
  streamPrefix: "customer-feedback.",
  apiBasePath: "/api/customer-feedback",
  slices: [csat.slice, cases.slice, attention.slice, privacy.slice],
  allowedSupportDirectories: ["runtime-support"],
  publicExports: [".", "./context", "./routes/*", "./server", "./integration/link-intents"],
  allowedContextDependencies: [],
  seedRequirements: [],
  eventReactions: cases.eventReactions,
  eventSubscriptions: csat.eventSubscriptions,
  projectionGroups: [
    ...csat.projectionGroups,
    ...cases.caseProjectionGroups,
    ...attention.projectionGroups,
    cases.deliveryRecordingProjection,
    {
      projectionName: "platform-policy-document-projection",
      sourceContextNames: ["customer-feedback"],
      ownedTables: ["platform_policy_documents", "platform_policy_document_history"],
      requiredDuringBootstrap: false,
      resetStrategy: "truncate-owned-tables",
    },
  ],
  hostPorts: [],
  apiDeployables: ["platform-api"],
  apiRuntimeProfiles: ["proof", "public"],
  apiMounts: [
    {
      mountPath: "/api/customer-feedback",
      kind: "primary",
      requiresAuth: true,
    },
  ],
  mutationConsistencyInventory: [...privacy.mutationConsistencyInventory, ...attention.mutationConsistencyInventory],
  agentCoverage: attention.agentCoverage,
  deployableContributions: attention.deployableContributions,
  shellContributions: attention.navigation,
  directoryIntent: {
    csat: csat.directoryIntent,
    cases: cases.directoryIntent,
    attention: attention.directoryIntent,
    privacy: privacy.directoryIntent,
    "runtime-support": {
      classification: "support",
      purpose:
        "Provide CSAT invitation event-store, wake notification, schema, and runtime service composition for the aggregate and projections.",
      expectedConsumers: ["Root customer-feedback module composition"],
    },
    routes: {
      classification: "routes",
      purpose:
        "Reserve Customer Feedback route metadata for the future csat invitation, survey, and operator page route contributions.",
      expectedConsumers: ["Future generated deployable route adapters"],
    },
  },
  runtimeDeployables: ["platform-worker"],
  workerRuntimeProfiles: ["proof", "public"],
};
