import {
  bootstrapContextDatabase,
  collectProjectors,
  drainContextRuntime,
  resolveModuleApiMounts,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  seedApiModuleIfEmpty,
  seedProfilesOverlap,
  syncContextProjectionGroups,
  type MountedContextRuntimeEntry,
} from "../bounded-context-runtime/index";
import type {
  BcApiModule,
  BcApiMount,
  BcHostPort,
  BcSeedOptions,
  EnvironmentDataProfile,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";

export type { EnvironmentDataProfile } from "@chase-sets/bounded-context-module";

export type ApiHostName = "platform-api" | "admin-support-api";

export const productionLikeDataProfiles: readonly EnvironmentDataProfile[] = [
  "critical-bootstrap",
  "catalog-integration-bootstrap",
];

export const nonProductionDataProfiles: readonly EnvironmentDataProfile[] = [
  "critical-bootstrap",
  "catalog-integration-bootstrap",
  "scenario-seed",
];

export type ApiContextManifest = Readonly<{
  contextName: string;
  apiDeployables?: readonly string[];
  hostPorts?: readonly BcHostPort[];
  seedRequirements?: readonly string[];
}>;

export type ApiContextRegistryEntry = Readonly<{
  contextName: string;
  packageName: string;
  manifest: ApiContextManifest;
  module: BcApiModule;
}>;

export type ApiContextRegistry = readonly ApiContextRegistryEntry[];
export type ApiHostContextName<TRegistry extends ApiContextRegistry = ApiContextRegistry> =
  TRegistry[number]["contextName"];

export type ApiHostRuntime = Readonly<{
  mountedContexts: readonly MountedContextRuntimeEntry[];
  mountedModules: readonly Readonly<{
    module: BcApiModule;
    services: unknown;
  }>[];
  services: Readonly<Record<string, unknown>>;
  projectors: ReturnType<typeof collectProjectors>;
  projectionGroups: ReturnType<typeof resolveModuleProjectionGroups>;
  subscriptionRunners: ReturnType<typeof resolveModuleSubscriptions>;
}>;

export type ApiHostMount = BcApiMount &
  Readonly<{
    contextName: string;
    router: unknown;
  }>;

export function getApiHostEntries<TRegistry extends ApiContextRegistry>(
  registry: TRegistry,
  hostName: ApiHostName,
): readonly ApiContextRegistryEntry[] {
  return registry.filter((entry) => (entry.manifest as ApiContextManifest).apiDeployables?.includes(hostName));
}

export function getApiHostContextNames<TRegistry extends ApiContextRegistry>(
  registry: TRegistry,
  hostName: ApiHostName,
): readonly ApiHostContextName<TRegistry>[] {
  return getApiHostEntries(registry, hostName).map((entry) => entry.contextName as ApiHostContextName<TRegistry>);
}

function getHostPortsForContext(manifest: ApiContextManifest, hostPorts: Readonly<Record<string, unknown>>) {
  const entries = manifest.hostPorts ?? [];
  if (entries.length === 0) {
    return undefined;
  }

  const resolvedPorts: Record<string, unknown> = {};
  for (const hostPort of entries) {
    resolvedPorts[hostPort.portName] = hostPorts[hostPort.portName];
  }

  return resolvedPorts;
}

export function createApiHost(
  registry: ApiContextRegistry,
  hostName: ApiHostName,
  options: Readonly<{
    pools: Readonly<Record<string, PgTransactionalPool>>;
    hostPorts?: Readonly<Record<string, unknown>>;
  }>,
): ApiHostRuntime {
  const entries = getApiHostEntries(registry, hostName);
  const services = Object.fromEntries(
    entries.map((entry) => {
      const pool = options.pools[entry.contextName];
      if (!pool) {
        throw new Error(`API host '${hostName}' is missing a pool for context '${entry.contextName}'.`);
      }

      return [
        entry.contextName,
        entry.module.createServices(
          pool,
          getHostPortsForContext(entry.manifest as ApiContextManifest, options.hostPorts ?? {}) as never,
        ),
      ];
    }),
  );

  const mountedContexts = entries.map((entry) => {
    const pool = options.pools[entry.contextName];
    const contextServices = services[entry.contextName];

    return {
      contextName: entry.contextName,
      mountRole: "active" as const,
      module: entry.module,
      services: contextServices,
      pool,
      projectors: entry.module.projectors(contextServices as never),
    };
  });

  const mountedModules = mountedContexts.map((entry) => ({
    module: entry.module,
    services: entry.services,
  }));
  const subscriptionRunners = resolveModuleSubscriptions(mountedContexts);
  const projectionGroups = resolveModuleProjectionGroups(mountedContexts, subscriptionRunners);

  return {
    mountedContexts,
    mountedModules,
    services,
    projectors: collectProjectors(
      mountedContexts.map((entry) => ({
        projectors: entry.projectors,
      })),
    ),
    projectionGroups,
    subscriptionRunners,
  };
}

export function resolveApiHostMounts(runtime: ApiHostRuntime): readonly ApiHostMount[] {
  return runtime.mountedContexts.flatMap((entry) =>
    resolveModuleApiMounts(entry.module, entry.services as never).map((mount) => ({
      ...mount,
      contextName: entry.contextName,
    })),
  );
}

function getSeedDependencyNames(
  entry: ApiContextRegistryEntry,
  activeNames: readonly ApiHostContextName[],
): readonly ApiHostContextName[] {
  const activeNameSet = new Set(activeNames);
  return ((entry.manifest as ApiContextManifest).seedRequirements ?? []).filter(
    (dependency): dependency is ApiHostContextName => activeNameSet.has(dependency as ApiHostContextName),
  );
}

export function getApiHostSeedOrder(registry: ApiContextRegistry, hostName: ApiHostName): readonly string[] {
  const entries = getApiHostEntries(registry, hostName);
  const activeNames = entries.map((entry) => entry.contextName);
  const byName = new Map(entries.map((entry) => [entry.contextName, entry]));
  const visited = new Set<string>();
  const inProgress = new Set<string>();
  const orderedNames: ApiHostContextName[] = [];

  function visit(contextName: ApiHostContextName) {
    if (visited.has(contextName)) {
      return;
    }

    if (inProgress.has(contextName)) {
      throw new Error(`API host '${hostName}' has a circular seed dependency involving '${contextName}'.`);
    }

    const entry = byName.get(contextName);
    if (!entry) {
      throw new Error(`API host '${hostName}' is missing registry entry '${contextName}'.`);
    }

    inProgress.add(contextName);
    for (const dependencyName of getSeedDependencyNames(entry, activeNames)) {
      visit(dependencyName as ApiHostContextName);
    }
    inProgress.delete(contextName);
    visited.add(contextName);
    orderedNames.push(contextName);
  }

  for (const contextName of activeNames) {
    visit(contextName);
  }

  return orderedNames;
}

function shouldRunFullBootstrapDrain(options: BcSeedOptions): boolean {
  return options.enabledDataProfiles.includes("scenario-seed");
}

function shouldRunContextSeed(context: Pick<MountedContextRuntimeEntry, "module">, options: BcSeedOptions): boolean {
  return Boolean(context.module.seed && seedProfilesOverlap(context.module.seedProfiles, options));
}

export async function seedApiHostIfEmpty(
  registry: ApiContextRegistry,
  hostName: ApiHostName,
  runtime: ApiHostRuntime,
  options: BcSeedOptions = {
    enabledDataProfiles: nonProductionDataProfiles,
    environmentName: null,
  },
): Promise<void> {
  const mountedContextsByName = new Map(runtime.mountedContexts.map((entry) => [entry.contextName, entry]));
  const runFullDrain = shouldRunFullBootstrapDrain(options);

  for (const context of runtime.mountedContexts) {
    await bootstrapContextDatabase(context.module, context.pool);
  }

  for (const contextName of getApiHostSeedOrder(registry, hostName)) {
    const context = mountedContextsByName.get(contextName);
    if (!context) {
      throw new Error(`API host '${hostName}' is missing mounted context '${contextName}' during seed.`);
    }

    const runContextSeed = shouldRunContextSeed(context, options);
    if (!runContextSeed) {
      await seedApiModuleIfEmpty(context.module, context.pool, context.services, options);
      continue;
    }

    await syncContextProjectionGroups(runtime, contextName, {
      requiredOnly: true,
    });
    await seedApiModuleIfEmpty(context.module, context.pool, context.services, options);
    await syncContextProjectionGroups(runtime, contextName, {
      requiredOnly: !runFullDrain,
    });
    if (runFullDrain) {
      await drainContextRuntime(runtime);
    }
  }

  if (runFullDrain) {
    await drainContextRuntime(runtime);
  }
}
