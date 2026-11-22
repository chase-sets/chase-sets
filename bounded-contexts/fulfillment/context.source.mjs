import shipments from "./features/shipments/metadata.json" with { type: "json" };
import returnShipments from "./features/return-shipments/metadata.json" with { type: "json" };
import sellerCheckoutReadiness from "./features/seller-checkout-readiness/metadata.json" with { type: "json" };

// Preserve the canonical order where the context interleaves feature contributions.
export const contextManifest = {
  scheduledJobs: [...shipments.scheduledJobs, ...returnShipments.scheduledJobs],
  contextName: "fulfillment",
  packageName: "@chase-sets/fulfillment",
  localeCatalogs: [
    ...shipments.localeCatalogs,
    ...returnShipments.localeCatalogs,
    ...sellerCheckoutReadiness.localeCatalogs,
  ],
  ownedNouns: ["shipment", "return-shipment"],
  streamPrefix: "fulfillment.",
  apiBasePath: "/api/marketplace",
  slices: ["shipments", "return-shipments", "seller-checkout-readiness"],
  allowedSupportDirectories: ["request-support", "runtime-support", "seed-support"],
  publicExports: [".", "./context", "./routes/*", "./seed-support/*", "./server", "./integration/link-intents"],
  allowedContextDependencies: [],
  seedRequirements: ["identity", "payments", "ordering"],
  eventSubscriptions: [...shipments.eventSubscriptions, ...returnShipments.eventSubscriptions],
  projectionGroups: [
    ...shipments.projectionGroups,
    returnShipments.supportProjection,
    shipments.shipmentProjection,
    ...returnShipments.projectionGroups,
  ],
  hostPorts: [
    ...sellerCheckoutReadiness.hostPorts,
    ...shipments.hostPorts,
    ...returnShipments.hostPorts,
    shipments.notificationOutbox,
  ],
  mcpCapabilities: {
    tools: [...shipments.mcpCapabilities.tools, ...returnShipments.mcpCapabilities.tools],
    resources: shipments.mcpCapabilities.resources,
  },
  apiDeployables: ["platform-api"],
  apiMounts: [
    {
      mountPath: "/api/marketplace",
      kind: "primary",
      requiresAuth: true,
      readFreshnessRoutes: shipments.apiMounts.readFreshnessRoutes,
    },
    shipments.apiMounts.provider,
  ],
  readAfterWriteRouteInventory: shipments.readAfterWriteRouteInventory,
  rawFetchCensus: "complete",
  mutationConsistencyInventory: [
    ...sellerCheckoutReadiness.mutationConsistencyInventory,
    ...shipments.mutationConsistencyInventory,
    ...returnShipments.mutationConsistencyInventory,
    shipments.commandCenterActions,
  ],
  agentCoverage: returnShipments.agentCoverage,
  deployableContributions: [
    {
      deployable: "marketplace-web",
      routes: [...sellerCheckoutReadiness.marketplaceRoutes, ...shipments.marketplaceRoutes],
    },
    { deployable: "admin-web", routes: returnShipments.adminRoutes },
  ],
  shellContributions: [...returnShipments.navigation, ...shipments.navigation],
  directoryIntent: {
    shipments: shipments.directoryIntent,
    "return-shipments": returnShipments.directoryIntent,
    "seller-checkout-readiness": sellerCheckoutReadiness.directoryIntent,
    ...{
      "request-support": {
        classification: "support",
        purpose: "Provide reusable request-support assets shared by fulfillment-owned features and composition seams.",
        expectedConsumers: ["return-shipments", "seller-checkout-readiness", "shipments"],
        crossCuttingRuntimeComposition: true,
      },
      "runtime-support": {
        classification: "support",
        purpose: "Provide reusable runtime-support assets shared by fulfillment-owned features and composition seams.",
        expectedConsumers: ["seller-checkout-readiness"],
      },
      "seed-support": {
        classification: "support",
        purpose: "Provide reusable seed-support assets shared by fulfillment-owned features and composition seams.",
        expectedConsumers: ["Multiple fulfillment slices", "Deployable composition for fulfillment"],
        crossCuttingRuntimeComposition: true,
      },
      routes: {
        classification: "routes",
        purpose: "Expose fulfillment-owned route modules consumed by generated deployable adapters.",
        expectedConsumers: ["Generated deployable route adapters"],
      },
    },
  },
  runtimeDeployables: ["platform-worker"],
  sourceRuntimeDeployables: ["platform-api", "platform-worker"],
  sourceRuntimeProfiles: ["landing"],
  apiRuntimeProfiles: ["proof", "public"],
  workerRuntimeProfiles: ["proof", "public"],
};
