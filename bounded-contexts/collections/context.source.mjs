import savedLists from "./features/saved-lists/metadata.json" with { type: "json" };
import savedListValuation from "./features/saved-list-valuation/metadata.json" with { type: "json" };

export const contextManifest = {
  contextName: "collections",
  packageName: "@chase-sets/collections",
  localeCatalogs: [...savedLists.localeCatalogs, ...savedListValuation.localeCatalogs],
  ownedNouns: savedLists.ownedNouns,
  streamPrefix: "collections.",
  apiBasePath: "/api/collections",
  slices: [savedLists.slice, savedListValuation.slice],
  allowedSupportDirectories: ["runtime-support"],
  publicExports: [".", "./context", "./server"],
  allowedContextDependencies: [],
  seedRequirements: ["catalog"],
  hostPorts: [
    {
      portName: "savedListAnalyticsRecorder",
      providedBy: "platform-api",
      purpose: "Records closed, identifier-free Saved List interaction labels without affecting HTTP responses.",
    },
    ...savedLists.hostPorts,
  ],
  eventSubscriptions: [...savedLists.eventSubscriptions, ...savedListValuation.eventSubscriptions],
  projectionGroups: [...savedLists.projectionGroups, ...savedListValuation.projectionGroups],
  mutationConsistencyInventory: savedLists.mutationConsistencyInventory,
  apiDeployables: ["platform-api"],
  apiRuntimeProfiles: ["proof", "public"],
  apiMounts: [
    {
      mountPath: "/api/collections",
      kind: "primary",
      requiresAuth: true,
      readFreshnessRoutes: savedLists.readFreshnessRoutes,
    },
  ],
  workerRuntimeProfiles: ["proof", "public"],
  readAfterWriteRouteInventory: savedLists.readAfterWriteRouteInventory,
  runtimeDeployables: ["platform-worker"],
  deployableContributions: [],
  shellContributions: [],
  directoryIntent: {
    "saved-lists": savedLists.directoryIntent,
    "saved-list-valuation": savedListValuation.directoryIntent,
    "runtime-support": {
      classification: "support",
      purpose:
        "Provide the Collections event-store schema and runtime service composition seam without taking Saved List behavior out of its slice.",
      expectedConsumers: ["saved-lists"],
    },
    routes: {
      classification: "routes",
      purpose: "Reserve Collections route metadata for later My Collection and shared Saved List route contributions.",
      expectedConsumers: ["Future generated deployable route adapters"],
    },
  },
};
