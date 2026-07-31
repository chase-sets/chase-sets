import {
  bootstrapContextDatabase,
  countEventsWithPrefix,
  createProjectionAwarePool,
  drainContextRuntime,
  drainLocalProjectionHandlerSets,
  resolveModuleApiMounts,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  seedApiModuleIfEmpty,
  seedProfilesOverlap,
  syncContextProjectionGroups,
  withSchemaBootstrapLock,
  type MountedContextRuntimeEntry,
  type ResolvedApiMount,
  type SchemaBootstrapLockAcquisition,
  type SchemaBootstrapOptions,
} from "../bounded-context-runtime/index";
import type {
  BcApiModule,
  BcHostPort,
  BcSeedOptions,
  EnvironmentDataProfile,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { runtimeProfileMatches, sourceRuntimeHostMatches } from "./host-runtime-selection";
import { attachRuntimeLifecycleRegistry, type RuntimeLifecycleRegistry } from "./runtime-lifecycle";

export type { EnvironmentDataProfile } from "@chase-sets/bounded-context-module";

export type ApiHostName = "platform-api";
export type ApiHostRuntimeProfile = "landing" | "proof" | "public";

export const productionLikeDataProfiles: readonly EnvironmentDataProfile[] = [
  "critical-bootstrap",
  "catalog-integration-bootstrap",
];

export const nonProductionDataProfiles: readonly EnvironmentDataProfile[] = [
  "critical-bootstrap",
  "catalog-integration-bootstrap",
  "scenario-seed",
];

export const representativeCommerceStateDataProfiles: readonly EnvironmentDataProfile[] = [
  "critical-bootstrap",
  "catalog-integration-bootstrap",
  "representative-commerce-state",
];

export const adminQaActorFixturesDataProfiles: readonly EnvironmentDataProfile[] = [
  "critical-bootstrap",
  "catalog-integration-bootstrap",
  "admin-qa-actor-fixtures",
];

export type ApiContextManifest = Readonly<{
  contextName: string;
  apiDeployables?: readonly string[];
  apiRuntimeProfiles?: readonly string[];
  sourceRuntimeDeployables?: readonly string[];
  sourceRuntimeProfiles?: readonly string[];
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
  projectionGroups: ReturnType<typeof resolveModuleProjectionGroups>;
  subscriptionRunners: ReturnType<typeof resolveModuleSubscriptions>;
}>;

export type ApiHostMount = ResolvedApiMount;

type ApiHostPools = Readonly<
  Record<string, PgTransactionalPool | Readonly<Record<string, PgTransactionalPool>> | undefined>
> &
  Readonly<{ contextWaiters?: Readonly<Record<string, PgTransactionalPool>> }>;

export function getApiHostEntries<TRegistry extends ApiContextRegistry>(
  registry: TRegistry,
  hostName: ApiHostName,
  runtimeProfile?: ApiHostRuntimeProfile,
): readonly ApiContextRegistryEntry[] {
  return registry.filter((entry) => {
    const manifest = entry.manifest as ApiContextManifest;
    return (
      isApiHostActive(manifest, hostName, runtimeProfile) || isApiHostSourceOnly(manifest, hostName, runtimeProfile)
    );
  });
}

export function getApiHostContextNames<TRegistry extends ApiContextRegistry>(
  registry: TRegistry,
  hostName: ApiHostName,
  runtimeProfile?: ApiHostRuntimeProfile,
): readonly ApiHostContextName<TRegistry>[] {
  return getApiHostEntries(registry, hostName, runtimeProfile).map(
    (entry) => entry.contextName as ApiHostContextName<TRegistry>,
  );
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

function getApiHostMountRole(
  manifest: ApiContextManifest,
  hostName: ApiHostName,
  runtimeProfile?: ApiHostRuntimeProfile,
): "active" | "source-only" {
  return isApiHostActive(manifest, hostName, runtimeProfile) ? "active" : "source-only";
}

function isApiHostActive(
  manifest: ApiContextManifest,
  hostName: ApiHostName,
  runtimeProfile?: ApiHostRuntimeProfile,
): boolean {
  return Boolean(
    manifest.apiDeployables?.includes(hostName) && runtimeProfileMatches(manifest.apiRuntimeProfiles, runtimeProfile),
  );
}

function isApiHostSourceOnly(
  manifest: ApiContextManifest,
  hostName: ApiHostName,
  runtimeProfile?: ApiHostRuntimeProfile,
): boolean {
  return sourceRuntimeHostMatches(manifest, hostName, runtimeProfile);
}

export function createApiHost(
  registry: ApiContextRegistry,
  hostName: ApiHostName,
  options: Readonly<{
    pools: ApiHostPools;
    hostPorts?: Readonly<Record<string, unknown>>;
    runtimeProfile?: ApiHostRuntimeProfile;
    runtimeLifecycle?: RuntimeLifecycleRegistry;
  }>,
): ApiHostRuntime {
  const entries = getApiHostEntries(registry, hostName, options.runtimeProfile);
  const services = Object.fromEntries(
    entries.map((entry) => {
      const pool = getContextPool(options.pools, hostName, entry.contextName);
      const notificationWaiterPool = options.pools.contextWaiters?.[entry.contextName] ?? pool;
      const servicePool = attachRuntimeLifecycleRegistry(createProjectionAwarePool(pool), options.runtimeLifecycle);
      const serviceNotificationWaiterPool = attachRuntimeLifecycleRegistry(
        createProjectionAwarePool(notificationWaiterPool),
        options.runtimeLifecycle,
      );

      return [
        entry.contextName,
        entry.module.createServices(
          servicePool,
          getHostPortsForContext(entry.manifest as ApiContextManifest, options.hostPorts ?? {}) as never,
          { notificationWaiterPool: serviceNotificationWaiterPool },
        ),
      ];
    }),
  );

  const mountedContexts = entries.map((entry) => {
    const pool = getContextPool(options.pools, hostName, entry.contextName);
    const notificationWaiterPool = options.pools.contextWaiters?.[entry.contextName] ?? pool;
    const contextServices = services[entry.contextName];
    const mountRole = getApiHostMountRole(entry.manifest as ApiContextManifest, hostName, options.runtimeProfile);
    const mountedNotificationWaiterPool = attachRuntimeLifecycleRegistry(
      notificationWaiterPool,
      options.runtimeLifecycle,
    );

    return {
      contextName: entry.contextName,
      mountRole,
      module: entry.module,
      services: contextServices,
      pool,
      notificationWaiterPool: mountedNotificationWaiterPool,
      projectionHandlerSets: entry.module.projectionHandlerSets?.(contextServices as never) ?? [],
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
    projectionGroups,
    subscriptionRunners,
  };
}

function getContextPool(pools: ApiHostPools, hostName: ApiHostName, contextName: string): PgTransactionalPool {
  const pool = pools[contextName];
  if (isPgTransactionalPool(pool)) {
    return pool;
  }

  throw new Error(`API host '${hostName}' is missing a pool for context '${contextName}'.`);
}

function isPgTransactionalPool(value: unknown): value is PgTransactionalPool {
  return Boolean(value && typeof value === "object" && "query" in value);
}

export function resolveApiHostMounts(runtime: ApiHostRuntime): readonly ApiHostMount[] {
  return runtime.mountedContexts.flatMap((entry) =>
    entry.mountRole === "source-only"
      ? []
      : resolveModuleApiMounts(entry.module, entry.services as never).map((mount) => ({
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

export function getApiHostSeedOrder(
  registry: ApiContextRegistry,
  hostName: ApiHostName,
  runtimeProfile?: ApiHostRuntimeProfile,
  options?: Pick<BcSeedOptions, "enabledDataProfiles" | "environmentName">,
): readonly string[] {
  const entries = getApiHostEntries(registry, hostName, runtimeProfile);
  const seedEntries = entries.filter(
    (entry) =>
      getApiHostMountRole(entry.manifest as ApiContextManifest, hostName, runtimeProfile) === "active" ||
      Boolean(options && entry.module.seedProfiles && seedProfilesOverlap(entry.module.seedProfiles, options)),
  );
  const seedNames = seedEntries.map((entry) => entry.contextName);
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
    for (const dependencyName of getSeedDependencyNames(entry, seedNames)) {
      visit(dependencyName as ApiHostContextName);
    }
    inProgress.delete(contextName);
    visited.add(contextName);
    orderedNames.push(contextName);
  }

  for (const contextName of seedNames) {
    visit(contextName);
  }

  return orderedNames;
}

function shouldRunFullBootstrapDrain(options: BcSeedOptions & Readonly<{ fullBootstrapDrain?: boolean }>): boolean {
  return options.fullBootstrapDrain === true || options.enabledDataProfiles.includes("scenario-seed");
}

function shouldRunContextSeed(context: Pick<MountedContextRuntimeEntry, "module">, options: BcSeedOptions): boolean {
  return Boolean(context.module.seed && seedProfilesOverlap(context.module.seedProfiles, options));
}

export type ApiHostSeedOptions = BcSeedOptions &
  Readonly<{
    runtimeProfile?: ApiHostRuntimeProfile;
    schemaBootstrap?: SchemaBootstrapOptions;
    /**
     * Upper bound for any single seed substep (schema bootstrap or module seed for one
     * context). When a substep exceeds it, seeding fails with a descriptive error instead of
     * hanging silently until the deploy quiesce kills the bootstrap job.
     */
    substepTimeoutMs?: number;
    /**
     * Opt in to the full post-seed projection drain even when the enabled data
     * profiles would not trigger it. Worker-less runtimes (for example the
     * representative commerce state command) need converged read models so a
     * repeat run's seed reconciliation guards observe what earlier runs created.
     */
    fullBootstrapDrain?: boolean;
  }>;

async function runSeedSubstep<T>(label: string, timeoutMs: number | undefined, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  console.log(`[seed-api-host] ${label} started.`);
  try {
    const result = await withSeedSubstepTimeout(label, timeoutMs, action);
    console.log(`[seed-api-host] ${label} completed in ${Date.now() - startedAt}ms.`);
    return result;
  } catch (error) {
    console.error(`[seed-api-host] ${label} failed after ${Date.now() - startedAt}ms.`, error);
    throw error;
  }
}

async function withSeedSubstepTimeout<T>(
  label: string,
  timeoutMs: number | undefined,
  action: () => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined) {
    return action();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new SeedApiHostSubstepTimeoutError(label, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

class SeedApiHostSubstepTimeoutError extends Error {
  readonly code = "BOOTSTRAP_SEED_SUBSTEP_TIMEOUT";
  readonly failureClass = "bootstrap-seed-substep-timeout";

  constructor(label: string, timeoutMs: number) {
    super(
      `[seed-api-host] failure_class=bootstrap-seed-substep-timeout; substep '${label}' exceeded ${timeoutMs}ms without completing. ` +
        "This usually means a schema migration or seed is blocked on a database lock " +
        "(for example ACCESS EXCLUSIVE contention from live read traffic during a rolling deploy) " +
        "or is awaiting a projection no running worker can apply. Inspect active database sessions.",
    );
    this.name = "SeedApiHostSubstepTimeoutError";
  }
}

export async function seedApiHostIfEmpty(
  registry: ApiContextRegistry,
  hostName: ApiHostName,
  runtime: ApiHostRuntime,
  options: ApiHostSeedOptions = {
    enabledDataProfiles: nonProductionDataProfiles,
    environmentName: null,
  },
): Promise<void> {
  const bootstrapLockContext = runtime.mountedContexts[0];
  if (!bootstrapLockContext) {
    return;
  }

  await withSchemaBootstrapLock(bootstrapLockContext.pool, options.schemaBootstrap, (lockAcquisition) =>
    seedApiHostIfEmptyWithHeldBootstrapLock(registry, hostName, runtime, options, lockAcquisition),
  );
}

async function seedApiHostIfEmptyWithHeldBootstrapLock(
  registry: ApiContextRegistry,
  hostName: ApiHostName,
  runtime: ApiHostRuntime,
  options: ApiHostSeedOptions,
  lockAcquisition: SchemaBootstrapLockAcquisition,
): Promise<void> {
  const mountedContextsByName = new Map(runtime.mountedContexts.map((entry) => [entry.contextName, entry]));
  const runFullDrain = shouldRunFullBootstrapDrain(options);
  const substepTimeoutMs = options.substepTimeoutMs;
  const schemaBootstrap: SchemaBootstrapOptions = {
    ...options.schemaBootstrap,
    advisoryLockMode: "held-by-caller",
  };

  for (const context of runtime.mountedContexts) {
    await runSeedSubstep(`schema-bootstrap:${context.contextName}`, substepTimeoutMs, () =>
      bootstrapContextDatabase(context.module, context.pool, schemaBootstrap),
    );
  }

  for (const contextName of getApiHostSeedOrder(registry, hostName, options.runtimeProfile, options)) {
    const context = mountedContextsByName.get(contextName);
    if (!context) {
      throw new Error(`API host '${hostName}' is missing mounted context '${contextName}' during seed.`);
    }

    const runContextSeed = shouldRunContextSeed(context, options);
    if (!runContextSeed) {
      await runSeedSubstep(`seed:${contextName}`, substepTimeoutMs, () =>
        seedApiModuleForHostBootstrap(context, options, lockAcquisition),
      );
      continue;
    }

    if (context.mountRole === "source-only") {
      await runSeedSubstep(`seed:${contextName}`, substepTimeoutMs, () =>
        seedApiModuleForHostBootstrap(context, options, lockAcquisition),
      );
      await runSeedSubstep(`projection-drain:${contextName}`, substepTimeoutMs, async () => {
        await drainLocalProjectionHandlerSets(context.contextName, context.pool, context.projectionHandlerSets);
        await seedApiModuleForHostBootstrap(context, options, lockAcquisition);
        await drainLocalProjectionHandlerSets(context.contextName, context.pool, context.projectionHandlerSets);
      });
      continue;
    }

    if (runFullDrain) {
      await runSeedSubstep(`projection-sync:${contextName}`, substepTimeoutMs, () =>
        syncContextProjectionGroups(runtime, contextName, {
          requiredOnly: true,
        }),
      );
    }
    await runSeedSubstep(`seed:${contextName}`, substepTimeoutMs, () =>
      seedApiModuleForHostBootstrap(context, options, lockAcquisition),
    );
    if (runFullDrain) {
      await runSeedSubstep(`projection-drain:${contextName}`, substepTimeoutMs, async () => {
        await syncContextProjectionGroups(runtime, contextName);
        await drainContextRuntime(runtime);
        await seedApiModuleForHostBootstrap(context, options, lockAcquisition);
        await syncContextProjectionGroups(runtime, contextName);
        await drainContextRuntime(runtime);
      });
    }
  }

  if (runFullDrain) {
    await runSeedSubstep("projection-drain:all", substepTimeoutMs, () => drainContextRuntime(runtime));

    // A final reconciliation pass lets seeds that depend on downstream facts
    // (for example marketplace review seeds that need delivered fulfillment
    // shipments) complete once every context has seeded and drained.
    for (const contextName of getApiHostSeedOrder(registry, hostName, options.runtimeProfile, options)) {
      const context = mountedContextsByName.get(contextName);
      if (!context || !shouldRunContextSeed(context, options)) {
        continue;
      }
      await runSeedSubstep(`seed-reconcile:${contextName}`, substepTimeoutMs, async () => {
        await seedApiModuleForHostBootstrap(context, options, lockAcquisition);
        await syncContextProjectionGroups(runtime, contextName);
        await drainContextRuntime(runtime);
      });
    }

    // Settle every subscription at its source head before the host reports ready.
    // Steady-state drains defer small idle checkpoint fast-forwards, which would
    // otherwise leave cross-context projections that subscribe to a subset of a
    // source's event types reporting a false tail lag whenever the source seeds
    // trailing non-subscribed events.
    await runSeedSubstep("projection-settle:all", substepTimeoutMs, () =>
      drainContextRuntime(runtime, { settleIdleCheckpoints: true }),
    );
  }
}

async function seedApiModuleForHostBootstrap(
  context: MountedContextRuntimeEntry,
  options: BcSeedOptions,
  lockAcquisition: SchemaBootstrapLockAcquisition,
): Promise<void> {
  // A queued twin must not re-enter an active context's general seed against
  // events whose projections the predecessor may not have drained. Event
  // presence is not semantic readiness, though: contexts with required bootstrap
  // state may declare a narrow idempotent reconciler. Drain first so it observes
  // all predecessor events, reconcile, then drain the repair before readiness.
  if (
    lockAcquisition.waited &&
    context.mountRole === "active" &&
    shouldRunContextSeed(context, options) &&
    (await countEventsWithPrefix(context.pool, context.module.streamPrefix)) > 0
  ) {
    if (context.module.reconcileBootstrapState) {
      console.log(`${context.contextName} events already exist after queued bootstrap. Reconciling required state.`);
      await reconcileRequiredBootstrapState(context, options);
      return;
    }
    console.log(
      `${context.contextName} events already exist after queued bootstrap. Draining existing events without general seed re-entry.`,
    );
    await drainLocalProjectionHandlerSets(context.contextName, context.pool, context.projectionHandlerSets);
    return;
  }

  await seedApiModuleIfEmpty(context.module, context.pool, context.services, options);
  if (
    context.mountRole === "active" &&
    shouldRunContextSeed(context, options) &&
    context.module.reconcileBootstrapState &&
    !shouldRunFullBootstrapDrain(options)
  ) {
    console.log(`${context.contextName} seed completed. Reconciling required state before readiness.`);
    await reconcileRequiredBootstrapState(context, options);
  }
}

async function reconcileRequiredBootstrapState(context: MountedContextRuntimeEntry, options: BcSeedOptions) {
  const reconcile = context.module.reconcileBootstrapState;
  if (!reconcile) {
    return;
  }

  await drainLocalProjectionHandlerSets(context.contextName, context.pool, context.projectionHandlerSets);
  await reconcile(context.pool, context.services, options);
  await drainLocalProjectionHandlerSets(context.contextName, context.pool, context.projectionHandlerSets);
}
