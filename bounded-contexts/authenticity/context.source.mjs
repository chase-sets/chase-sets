import cases from "./features/cases/metadata.json" with { type: "json" };

export const contextManifest = {
  contextName: "authenticity",
  packageName: "@chase-sets/authenticity",
  localeCatalogs: cases.localeCatalogs,
  ownedNouns: cases.ownedNouns,
  streamPrefix: "authenticity.",
  accountCapabilities: [
    {
      key: "authenticity.seller-included",
      description: "Declares whether an Account may use seller-included authenticity evidence.",
      kind: "boolean",
      defaultValue: false,
    },
  ],
  apiBasePath: "/api/authenticity",
  slices: [cases.slice],
  allowedSupportDirectories: ["runtime-support"],
  publicExports: [".", "./context"],
  allowedContextDependencies: [],
  seedRequirements: [],
  projectionGroups: cases.projectionGroups,
  hostPorts: [
    {
      portName: "authenticityFacilityDirectory",
      providedBy: "platform-api",
      purpose:
        "Platform-configured authenticity facility address and operating identity for the single platform-operated facility; the provider-port seam for later third-party authenticators.",
    },
  ],
  apiDeployables: ["platform-api"],
  apiMounts: [
    {
      mountPath: "/api/authenticity",
      kind: "primary",
      requiresAuth: true,
    },
  ],
  mcpCapabilities: cases.mcpCapabilities,
  mutationConsistencyInventory: cases.mutationConsistencyInventory,
  deployableContributions: [],
  shellContributions: [],
  directoryIntent: {
    cases: cases.directoryIntent,
    "runtime-support": {
      classification: "support",
      purpose:
        "Provide authenticity event-store composition, the platform-operated facility directory port, and shared domain primitives.",
      expectedConsumers: ["cases"],
    },
    routes: {
      classification: "routes",
      purpose: "Reserve authenticity-case route metadata for future deployable page route contributions.",
      expectedConsumers: ["Future generated deployable route adapters"],
    },
  },
  runtimeDeployables: ["platform-worker"],
  apiRuntimeProfiles: ["proof", "public"],
  workerRuntimeProfiles: ["proof", "public"],
};
