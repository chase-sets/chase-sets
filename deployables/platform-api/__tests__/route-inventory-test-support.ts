import { apiContextRegistry } from "../src/generated/api-context-registry";

const activeMountRole: "active" = "active";

export function createServiceProxy(): unknown {
  const target = () => createServiceProxy();

  return new Proxy(target, {
    get(_target, property) {
      if (property === "then") {
        return undefined;
      }

      return createServiceProxy();
    },
    has() {
      return true;
    },
    apply() {
      return createServiceProxy();
    },
  });
}

export function createRouteInventoryRuntime() {
  const mountedContexts = apiContextRegistry
    .filter((entry) => entry.manifest.apiDeployables?.includes("platform-api"))
    .map((entry) => ({
      contextName: entry.contextName,
      mountRole: activeMountRole,
      module: entry.module,
      services: createServiceProxy(),
      pool: createServiceProxy(),
      projectionHandlerSets: [],
    }));
  const services = Object.fromEntries(mountedContexts.map((entry) => [entry.contextName, entry.services]));
  const projectionGroups = mountedContexts.flatMap((entry) =>
    (entry.module.projectionGroups ?? []).map((group) => ({
      projectionName: group.projectionName,
      projectionRevision: group.projectionRevision ?? 1,
      targetContextName: entry.contextName,
      sourceContextNames: group.sourceContextNames,
      optionalSourceContextNames: group.optionalSourceContextNames ?? [],
      ownedTables: group.ownedTables,
      resetStrategy: group.resetStrategy,
      requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
      subscriptionRunners: [],
      reset: async () => {},
      getStatus: () => ({}),
      refreshStatus: async () => ({}),
      markRevisionSynced: async () => {},
    })),
  );

  return {
    mountedContexts,
    mountedModules: mountedContexts.map((entry) => ({
      module: entry.module,
      services: entry.services,
    })),
    services,
    projectionGroups,
    subscriptionRunners: [],
  };
}
