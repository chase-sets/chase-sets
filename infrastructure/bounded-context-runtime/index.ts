export * from "./api-mounts";
export * from "./inline-apply";
export { createProjectionAwarePool } from "./projection-transactions";
export {
  bootstrapContextDatabase,
  composeModuleSchemaSql,
  composeSchemaSql,
  eventSubscriptionSchemaSql,
  SCHEMA_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE,
  SCHEMA_BOOTSTRAP_LOCK_QUERY_TIMEOUT_MS,
  SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_RETRY_BUDGET_MS,
  SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_SETTING,
  SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_RETRIES,
  SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS,
  SCHEMA_MIGRATIONS_TABLE,
  waitForDatabase,
  withSchemaBootstrapLock,
} from "./schema";
export type { SchemaBootstrapLockAcquisition, SchemaBootstrapOptions } from "./schema";
export {
  allEnvironmentDataProfiles,
  countEventsWithPrefix,
  defaultSeedDataProfiles,
  defaultSeedOptions,
  seedApiModuleIfEmpty,
  seedApiModulesIfEmpty,
  seedProfileEnabled,
  seedProfilesOverlap,
} from "./seeding";
export {
  countSeedStreamEvents,
  createSeedAggregateReconciler,
  loadSeedAggregateState,
  loadSeedStreamEvents,
  planSeedAggregateSteps,
  reconcileSeedAggregates,
} from "./seed-aggregate-state";
export type {
  SeedAggregateIdentity,
  SeedAggregateReconciler,
  SeedAggregateReconcilerInput,
  SeedAggregateState,
  SeedAggregateStateInput,
  SeedAggregateStateKind,
  SeedAggregateStepPlan,
  SeedAggregateStepPlanInput,
} from "./seed-aggregate-state";
export type {
  ContextProcessSet,
  ContextSubscriptionRunner,
  ContextSubscriptionStatus,
  MountedContextRuntimeEntry,
  ProjectionBlockedStreamDetails,
  ProjectionStreamRetryResult,
  SubscriptionLedgerMetrics,
  SubscriptionReplayState,
} from "./subscriptions";
export {
  compactRuntimeSubscriptionLedgers,
  createSubscriptionRunner,
  drainContextProcesses,
  drainLocalProjectionHandlerSets,
  rebuildLocalProjectionHandlerSets,
  drainContextRuntime,
  drainSubscriptionRunners,
  listProjectionBlockedStreamDetails,
  LocalProjectorSubscriptionDeclarationError,
  resolveModuleSubscriptions,
  retryLocalProjectionBlockedStream,
  retryProjectionBlockedStream,
  sortSubscriptionRunners,
  summarizeRuntimeSubscriptionLedgers,
  syncContextSubscriptions,
} from "./subscriptions";
export { createCheckpointKey, loadSubscriptionCheckpoint } from "./subscription-store";
export type {
  ContextProjectionGroup,
  ContextProjectionGroupStatus,
  ProjectionReplayContextSummary,
  ProjectionReplaySummary,
} from "./projection-groups";
export {
  cleanupRuntimeProjectionGenerations,
  getProjectionGroup,
  getProjectionReplaySummary,
  listProjectionGroupStatuses,
  rebuildAllContextProjectionGroups,
  rebuildContextProjectionGroup,
  rebuildProjectionGroup,
  refreshProjectionGroupStatuses,
  refreshProjectionReplaySummary,
  resetProjectionGroup,
  resolveModuleProjectionGroups,
  summarizeProjectionReplayStatuses,
  syncContextProjectionGroups,
  syncProjectionGroup,
} from "./projection-groups";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createProjectionAwarePool } from "./projection-transactions";
import { bootstrapContextDatabase } from "./schema";
import { seedApiModuleIfEmpty } from "./seeding";
import { drainContextProcesses, resolveModuleSubscriptions, type MountedContextRuntimeEntry } from "./subscriptions";

export function createContextServices<TServices, TPool, TPorts>(
  module: BcApiModule<TServices, TPool, TPorts>,
  pool: TPool,
  ports: TPorts,
): TServices {
  return module.createServices(pool, ports);
}

export function composeApiModules<
  TPool,
  TModules extends readonly Readonly<{
    module: BcApiModule<unknown, TPool, unknown>;
    ports: unknown;
  }>[],
>(
  pool: TPool,
  modules: TModules,
): {
  [K in keyof TModules]: TModules[K] extends Readonly<{
    module: BcApiModule<infer TServices, TPool, infer _TPorts>;
    ports: infer _TProvidedPorts;
  }>
    ? Readonly<{
        module: TModules[K]["module"];
        services: TServices;
      }>
    : never;
} {
  return modules.map(({ module, ports }) => ({
    module,
    services: module.createServices(pool, ports),
  })) as {
    [K in keyof TModules]: TModules[K] extends Readonly<{
      module: BcApiModule<infer TServices, TPool, infer _TPorts>;
      ports: infer _TProvidedPorts;
    }>
      ? Readonly<{
          module: TModules[K]["module"];
          services: TServices;
        }>
      : never;
  };
}

export async function bootstrapApiModule<TServices, TPool extends PgTransactionalPool, TPorts>(
  module: BcApiModule<TServices, TPool, TPorts>,
  pool: TPool,
  ports: TPorts,
  options: Readonly<{
    databaseLabel?: string;
    completionLabel?: string;
  }> = {},
): Promise<TServices> {
  const completionLabel = options.completionLabel ?? module.contextName;
  await bootstrapContextDatabase(
    {
      contextName: options.databaseLabel ?? completionLabel,
      schemaSql: module.schemaSql,
      schemaMigrations: module.schemaMigrations,
    },
    pool,
  );
  await seedApiModuleIfEmpty(module, pool);
  const services = module.createServices(createProjectionAwarePool(pool), ports);
  const mountedContext: MountedContextRuntimeEntry = {
    contextName: module.contextName,
    mountRole: "active",
    module: module as BcApiModule,
    services,
    pool,
    projectionHandlerSets: module.projectionHandlerSets?.(services) ?? [],
  };
  await drainContextProcesses({ subscriptionRunners: resolveModuleSubscriptions([mountedContext]) });
  console.log(`${completionLabel} projections are up to date.`);
  console.log(`${completionLabel} bootstrap complete.`);
  return services;
}

export function buildOpenGraphMeta({
  title,
  description = title,
  siteName = "Chase Sets",
  imageUrl,
  type = "website",
}: Readonly<{
  title: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
  type?: "website" | "product";
}>) {
  const meta = [
    { title },
    { name: "description", content: description },
    { property: "og:site_name", content: siteName },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: type },
    {
      name: "twitter:card",
      content: imageUrl ? "summary_large_image" : "summary",
    },
  ];

  if (imageUrl) {
    meta.push({ property: "og:image", content: imageUrl });
  }

  return meta;
}
