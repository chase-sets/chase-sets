import type {
  EventPayloadMap,
  ProjectionHandlerSet,
  ProjectionErrorPolicy,
  ProjectionRunContext,
  ProjectorHandlerContext,
  ProjectorHandlerMap,
} from "@chase-sets/event-core/projector";
import type { TransportEvent, TypedTransportEvent } from "@chase-sets/event-core/transport";

/**
 * Framework-agnostic contract for a bounded-context module.
 *
 * Context packages expose either a `module` constant or a module factory for
 * cases that require runtime configuration.
 */
export type BcProjectionHandlerSet = ProjectionHandlerSet;

export type BcEventPayload = TransportEvent["data"];

export type BcEventSubscriptionHandlerEvent<
  TPayload extends BcEventPayload = BcEventPayload,
  TEventType extends string = string,
> = Readonly<TypedTransportEvent<TPayload, TEventType>>;

export type BcEventSubscriptionHandler<
  TPayload extends BcEventPayload = BcEventPayload,
  TEventType extends string = string,
> = {
  handle(
    event: BcEventSubscriptionHandlerEvent<TPayload, TEventType>,
    context?: ProjectorHandlerContext,
  ): Promise<void>;
}["handle"];

export type BcEventSubscriptionHandlerMap<TEventPayloads extends EventPayloadMap = EventPayloadMap> = Readonly<{
  [TEventType in keyof TEventPayloads & string]?: BcEventSubscriptionHandler<TEventPayloads[TEventType], TEventType>;
}>;

export function defineEventSubscriptionHandlers<TEventPayloads extends EventPayloadMap>(
  handlers: BcEventSubscriptionHandlerMap<TEventPayloads>,
): BcEventSubscriptionHandlerMap<TEventPayloads> {
  return handlers;
}

export function defineEventReactionHandlers<TEventPayloads extends EventPayloadMap>(
  handlers: BcEventSubscriptionHandlerMap<TEventPayloads>,
): BcEventSubscriptionHandlerMap<TEventPayloads> {
  return handlers;
}

export type BcRouteType = "route" | "index";
export type BcRoutePlacement = "root" | "layout";

export type BcRouteModule = Readonly<{
  readonly routeId: string;
  readonly routePath: string;
  readonly fileExport: string;
  readonly routeType: BcRouteType;
  readonly sourceContext: string;
  readonly placement?: BcRoutePlacement;
  readonly section?: string;
}>;

export type BcDeployableContribution = Readonly<{
  readonly deployable: string;
  readonly routes: readonly BcRouteModule[];
}>;

export type BcShellContributionSlot = "primary-nav" | "top-nav" | "bottom-nav";
export type BcShellContributionVisibility = "always" | "signed-in" | "signed-out";

export type BcShellContributionItemBase = Readonly<{
  readonly key: string;
  readonly label: string;
  readonly labelKey?: string;
  readonly icon: string;
  readonly order: number;
  readonly visibility: BcShellContributionVisibility;
  readonly requiredPermissions: readonly string[];
}>;

export type BcShellContributionItem = BcShellContributionItemBase &
  Readonly<
    | {
        readonly href: string;
        readonly children?: readonly BcShellContributionItem[];
      }
    | {
        readonly href?: string;
        readonly children: readonly BcShellContributionItem[];
      }
  >;

export type BcShellContribution = BcShellContributionItem &
  Readonly<{
    readonly deployable: string;
    readonly slot: BcShellContributionSlot;
    readonly placements?: readonly BcShellContributionSlot[];
    readonly section?: string;
  }>;

export type BcHostPort = Readonly<{
  readonly portName: string;
}>;

export type BcApiMountKind = "primary" | "additional";

export type BcReadFreshnessDependency = Readonly<
  | {
      projectionName: string;
      readModelTable?: never;
      targetContextName?: string;
    }
  | {
      readModelTable: string;
      projectionName?: never;
      targetContextName?: string;
    }
>;

export type BcReadFreshnessRoute = Readonly<{
  readonly routePath: string;
  readonly methods?: readonly ("GET" | "HEAD")[];
  readonly dependencies: readonly BcReadFreshnessDependency[];
}>;

export type BcApiMount = Readonly<{
  readonly mountPath: string;
  readonly kind: BcApiMountKind;
  readonly requiresAuth: boolean;
  readonly readFreshnessRoutes?: readonly BcReadFreshnessRoute[];
}>;

export type BcMcpToolDeclaration = Readonly<{
  readonly name: string;
  readonly ownerSlice?: string;
}>;

export type BcMcpResourceDeclaration = Readonly<{
  readonly uriTemplate: string;
  readonly ownerSlice?: string;
}>;

export type BcMcpCapabilities = Readonly<{
  readonly tools?: readonly BcMcpToolDeclaration[];
  readonly resources?: readonly BcMcpResourceDeclaration[];
}>;

export type BcMcpHandlers<TToolHandler = unknown, TResourceHandler = unknown> = Readonly<{
  readonly toolHandlers?: Readonly<Record<string, TToolHandler>>;
  readonly resourceHandlers?: Readonly<Record<string, TResourceHandler>>;
}>;

export type BcAnonymousRoute = Readonly<{
  readonly routePath: string;
  readonly methods: readonly string[];
  readonly match?: "exact" | "prefix";
}>;

export type BcEventSubscriptionDeclaration = Readonly<{
  readonly sourceContextName: string;
  readonly projectionName: string;
  readonly subscriptionVersion: number;
  readonly projectionHandlerSetNames: readonly string[];
  readonly sourceContextMount?: BcSourceContextMount;
  readonly eventTypes?: readonly string[];
  readonly streamPrefixes?: readonly string[];
  readonly errorPolicy?: ProjectionErrorPolicy;
  readonly batchSize?: number;
  readonly checkpointBatchSize?: number;
  readonly projectionTransactionTimeoutMs?: number;
  readonly projectionStatementTimeoutMs?: number;
  /**
   * How long a single event may stay stuck (failing to apply) before the runtime
   * quarantines it as poison so the checkpoint can advance. Guards against an
   * event whose projection work can never fit its transaction budget silently
   * stalling the whole projection forever. `0`/omitted uses the runtime default.
   */
  readonly projectionTransactionBudgetEscalationMs?: number;
  /**
   * Maximum number of dependent rows this projection's cascade may refresh in one
   * event transaction before the runtime commits the chunk and resumes the same
   * event on a later pass. Bounds fan-out so a structural event cannot exceed its
   * transaction budget. Omitted/`0` uses the runtime default.
   */
  readonly projectionCascadeChunkSize?: number;
  readonly order?: number;
}>;

export const BC_SOURCE_CONTEXT_MOUNTS = ["required", "when-mounted", "when-all-sources-mounted"] as const;
export type BcSourceContextMount = (typeof BC_SOURCE_CONTEXT_MOUNTS)[number];

export type BcSubscriptionHandlerKind = "projection" | "reaction";
export type BcReactionIdempotencyPolicy = "idempotent-command-dispatch";
export type BcReactionRetryPolicy = "retry-from-last-checkpoint";
export type BcReactionFailurePolicy = "surface-as-reaction-failure";

export type BcEventReactionDeclaration = Readonly<{
  readonly sourceContextName: string;
  readonly reactionName: string;
  readonly subscriptionVersion: number;
  readonly reactionHandlerSetNames: readonly string[];
  readonly sourceContextMount?: BcSourceContextMount;
  readonly idempotencyPolicy: BcReactionIdempotencyPolicy;
  readonly retryPolicy: BcReactionRetryPolicy;
  readonly failurePolicy: BcReactionFailurePolicy;
  readonly eventTypes?: readonly string[];
  readonly streamPrefixes?: readonly string[];
  readonly errorPolicy?: ProjectionErrorPolicy;
  readonly order?: number;
}>;

export const BC_PROJECTION_GROUP_RESET_STRATEGIES = [
  "replay-only",
  "append-only-no-reset",
  "truncate-owned-tables",
  "generation-cutover",
] as const;
export type BcProjectionGroupResetStrategy = (typeof BC_PROJECTION_GROUP_RESET_STRATEGIES)[number];

export type BcProjectionGroupDeclaration = Readonly<{
  readonly projectionName: string;
  readonly handlerKind?: BcSubscriptionHandlerKind;
  readonly projectionRevision?: number;
  readonly sourceContextNames: readonly string[];
  readonly sourceContextMount?: BcSourceContextMount;
  readonly optionalSourceContextNames?: readonly string[];
  readonly ownedTables: readonly string[];
  readonly sideEffectOnly?: boolean;
  readonly resetStrategy?: BcProjectionGroupResetStrategy;
  readonly requiredDuringBootstrap?: boolean;
}>;

export const BC_RUNTIME_PROFILES = ["landing", "proof", "public"] as const;
export type BcRuntimeProfile = (typeof BC_RUNTIME_PROFILES)[number];
export type BcApiRuntimeProfile = BcRuntimeProfile;
export type BcWorkerRuntimeProfile = BcRuntimeProfile;

type BcEventSubscriptionManifestDeclaration = Omit<BcEventSubscriptionDeclaration, "sourceContextMount"> &
  Readonly<{
    readonly sourceContextMount?: string;
  }>;

type BcEventReactionManifestDeclaration = Omit<BcEventReactionDeclaration, "sourceContextMount"> &
  Readonly<{
    readonly sourceContextMount?: string;
  }>;

type BcProjectionGroupManifestDeclaration = Omit<BcProjectionGroupDeclaration, "sourceContextMount" | "resetStrategy"> &
  Readonly<{
    readonly sourceContextMount?: string;
    readonly resetStrategy?: string;
  }>;

export type BcEventSubscription = Readonly<{
  readonly subscriptionName: string;
  readonly handlerKind?: BcSubscriptionHandlerKind;
  readonly sourceContextName: string;
  readonly sourceContextMount?: BcSourceContextMount;
  readonly projectionName: string;
  readonly reactionName?: string;
  readonly subscriptionVersion: number;
  readonly handlers: ProjectorHandlerMap;
  /** Runtime-derived from the matching local projection handler set. */
  readonly inlineApply?: boolean;
  readonly idempotencyPolicy?: BcReactionIdempotencyPolicy;
  readonly retryPolicy?: BcReactionRetryPolicy;
  readonly failurePolicy?: BcReactionFailurePolicy;
  readonly eventTypes?: readonly string[];
  readonly streamPrefixes?: readonly string[];
  readonly errorPolicy?: ProjectionErrorPolicy;
  readonly batchSize?: number;
  readonly checkpointBatchSize?: number;
  readonly projectionTransactionTimeoutMs?: number;
  readonly projectionStatementTimeoutMs?: number;
  readonly projectionTransactionBudgetEscalationMs?: number;
  readonly projectionCascadeChunkSize?: number;
  readonly order?: number;
}>;

export type BcContextManifest = Readonly<{
  readonly contextName: string;
  readonly apiBasePath: string;
  readonly streamPrefix: string;
  readonly apiMounts?: readonly BcApiMount[];
  readonly anonymousRoutes?: readonly BcAnonymousRoute[];
  readonly mcpCapabilities?: BcMcpCapabilities;
  readonly eventSubscriptions?: readonly BcEventSubscriptionDeclaration[];
  readonly eventReactions?: readonly BcEventReactionDeclaration[];
  readonly projectionGroups?: readonly BcProjectionGroupDeclaration[];
  readonly apiRuntimeProfiles?: readonly BcApiRuntimeProfile[];
  readonly workerRuntimeProfiles?: readonly BcWorkerRuntimeProfile[];
}>;

export type BcContextManifestInput = Omit<
  BcContextManifest,
  | "apiMounts"
  | "anonymousRoutes"
  | "eventSubscriptions"
  | "eventReactions"
  | "projectionGroups"
  | "apiRuntimeProfiles"
  | "workerRuntimeProfiles"
> &
  Readonly<{
    readonly apiMounts?: readonly unknown[];
    readonly anonymousRoutes?: readonly unknown[];
    readonly eventSubscriptions?: readonly BcEventSubscriptionManifestDeclaration[];
    readonly eventReactions?: readonly BcEventReactionManifestDeclaration[];
    readonly projectionGroups?: readonly BcProjectionGroupManifestDeclaration[];
    readonly apiRuntimeProfiles?: readonly string[];
    readonly workerRuntimeProfiles?: readonly string[];
  }>;

export function defineBoundedContextManifest(manifest: BcContextManifestInput): BcContextManifest {
  return normalizeContextManifest(manifest);
}

export type BcEventSubscriptionHandlerMapBuilder<TEventPayloads extends EventPayloadMap = EventPayloadMap> = (
  declaration: BcEventSubscriptionDeclaration,
) => ProjectorHandlerMap | BcEventSubscriptionHandlerMap<TEventPayloads>;

export type BcEventSubscriptionHandlerRegistration<TEventPayloads extends EventPayloadMap = EventPayloadMap> =
  | BcEventSubscriptionHandlerMapBuilder<TEventPayloads>
  | Readonly<{
      subscriptionName?: string;
      buildHandlers: BcEventSubscriptionHandlerMapBuilder<TEventPayloads>;
      filterToEventTypes?: boolean;
    }>;

export type BcEventSubscriptionHandlerRegistrations<TEventPayloads extends EventPayloadMap = EventPayloadMap> =
  Readonly<Record<string, BcEventSubscriptionHandlerRegistration<TEventPayloads>>>;

export type BuildEventSubscriptionsFromManifestInput<TEventPayloads extends EventPayloadMap = EventPayloadMap> =
  Readonly<{
    contextName: string;
    manifest: Pick<BcContextManifestInput, "eventSubscriptions">;
    handlers: BcEventSubscriptionHandlerRegistrations<TEventPayloads>;
  }>;

export function buildEventSubscriptionsFromManifest<TEventPayloads extends EventPayloadMap = EventPayloadMap>({
  contextName,
  manifest,
  handlers,
}: BuildEventSubscriptionsFromManifestInput<TEventPayloads>): readonly BcEventSubscription[] {
  const declarations = manifest.eventSubscriptions ?? [];

  return Object.entries(handlers).map(([subscriptionKey, registration]) => {
    const { sourceContextName, projectionName } = parseEventSubscriptionKey(subscriptionKey);
    const declaration = declarations.find(
      (entry) => entry.sourceContextName === sourceContextName && entry.projectionName === projectionName,
    );

    if (!declaration) {
      throw new Error(
        `Context '${contextName}' is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
      );
    }

    const normalizedDeclaration = normalizeEventSubscriptionDeclaration(contextName, declaration);
    const normalizedRegistration = normalizeEventSubscriptionHandlerRegistration(
      contextName,
      projectionName,
      registration,
    );
    const handlerMap = coerceProjectorHandlerMap(normalizedRegistration.buildHandlers(normalizedDeclaration));

    return {
      subscriptionName: normalizedRegistration.subscriptionName,
      handlerKind: "projection",
      sourceContextName: normalizedDeclaration.sourceContextName,
      ...(normalizedDeclaration.sourceContextMount
        ? { sourceContextMount: normalizedDeclaration.sourceContextMount }
        : {}),
      projectionName: normalizedDeclaration.projectionName,
      subscriptionVersion: normalizedDeclaration.subscriptionVersion,
      handlers: normalizedRegistration.filterToEventTypes
        ? selectEventSubscriptionHandlers(handlerMap, normalizedDeclaration.eventTypes)
        : handlerMap,
      eventTypes: normalizedDeclaration.eventTypes,
      streamPrefixes: normalizedDeclaration.streamPrefixes,
      errorPolicy: normalizedDeclaration.errorPolicy,
      batchSize: normalizedDeclaration.batchSize,
      checkpointBatchSize: normalizedDeclaration.checkpointBatchSize,
      projectionTransactionTimeoutMs: normalizedDeclaration.projectionTransactionTimeoutMs,
      projectionStatementTimeoutMs: normalizedDeclaration.projectionStatementTimeoutMs,
      projectionTransactionBudgetEscalationMs: normalizedDeclaration.projectionTransactionBudgetEscalationMs,
      projectionCascadeChunkSize: normalizedDeclaration.projectionCascadeChunkSize,
      order: normalizedDeclaration.order,
    };
  });
}

export type BcEventReactionHandlerMapBuilder<TEventPayloads extends EventPayloadMap = EventPayloadMap> = (
  declaration: BcEventReactionDeclaration,
) => ProjectorHandlerMap | BcEventSubscriptionHandlerMap<TEventPayloads>;

export type BcEventReactionHandlerRegistration<TEventPayloads extends EventPayloadMap = EventPayloadMap> =
  | BcEventReactionHandlerMapBuilder<TEventPayloads>
  | Readonly<{
      subscriptionName?: string;
      buildHandlers: BcEventReactionHandlerMapBuilder<TEventPayloads>;
      filterToEventTypes?: boolean;
    }>;

export type BcEventReactionHandlerRegistrations<TEventPayloads extends EventPayloadMap = EventPayloadMap> = Readonly<
  Record<string, BcEventReactionHandlerRegistration<TEventPayloads>>
>;

export type BuildEventReactionsFromManifestInput<TEventPayloads extends EventPayloadMap = EventPayloadMap> = Readonly<{
  contextName: string;
  manifest: Pick<BcContextManifestInput, "eventReactions">;
  handlers: BcEventReactionHandlerRegistrations<TEventPayloads>;
}>;

export function buildEventReactionsFromManifest<TEventPayloads extends EventPayloadMap = EventPayloadMap>({
  contextName,
  manifest,
  handlers,
}: BuildEventReactionsFromManifestInput<TEventPayloads>): readonly BcEventSubscription[] {
  const declarations = manifest.eventReactions ?? [];

  return Object.entries(handlers).map(([reactionKey, registration]) => {
    const { sourceContextName, reactionName } = parseEventReactionKey(reactionKey);
    const declaration = declarations.find(
      (entry) => entry.sourceContextName === sourceContextName && entry.reactionName === reactionName,
    );

    if (!declaration) {
      throw new Error(
        `Context '${contextName}' is missing an eventReactions declaration for '${sourceContextName}' -> '${reactionName}'.`,
      );
    }

    const normalizedDeclaration = normalizeEventReactionDeclaration(contextName, declaration);
    const normalizedRegistration = normalizeEventReactionHandlerRegistration(contextName, reactionName, registration);
    const handlerMap = coerceProjectorHandlerMap(normalizedRegistration.buildHandlers(normalizedDeclaration));

    return {
      subscriptionName: normalizedRegistration.subscriptionName,
      handlerKind: "reaction",
      sourceContextName: normalizedDeclaration.sourceContextName,
      ...(normalizedDeclaration.sourceContextMount
        ? { sourceContextMount: normalizedDeclaration.sourceContextMount }
        : {}),
      projectionName: normalizedDeclaration.reactionName,
      reactionName: normalizedDeclaration.reactionName,
      subscriptionVersion: normalizedDeclaration.subscriptionVersion,
      handlers: normalizedRegistration.filterToEventTypes
        ? selectEventSubscriptionHandlers(handlerMap, normalizedDeclaration.eventTypes)
        : handlerMap,
      idempotencyPolicy: normalizedDeclaration.idempotencyPolicy,
      retryPolicy: normalizedDeclaration.retryPolicy,
      failurePolicy: normalizedDeclaration.failurePolicy,
      eventTypes: normalizedDeclaration.eventTypes,
      streamPrefixes: normalizedDeclaration.streamPrefixes,
      errorPolicy: normalizedDeclaration.errorPolicy,
      order: normalizedDeclaration.order,
    };
  });
}

export function selectEventSubscriptionHandlers(
  handlers: ProjectorHandlerMap,
  eventTypes: readonly string[] | undefined,
): ProjectorHandlerMap {
  if (!eventTypes) {
    return handlers;
  }

  return Object.fromEntries(
    eventTypes.flatMap((eventType) => (handlers[eventType] ? [[eventType, handlers[eventType]]] : [])),
  );
}

export type BcProjectionGroup = BcProjectionGroupDeclaration &
  Readonly<{
    readonly reset?: (context?: ProjectionRunContext) => Promise<void>;
  }>;

export const ENVIRONMENT_DATA_PROFILES = [
  "critical-bootstrap",
  "catalog-integration-bootstrap",
  "scenario-seed",
  "representative-commerce-state",
  "admin-qa-actor-fixtures",
] as const;

export type EnvironmentDataProfile = (typeof ENVIRONMENT_DATA_PROFILES)[number];

export type BcSchemaMigration = Readonly<{
  readonly migrationId: string;
  readonly description: string;
  readonly statements: readonly string[];
}>;

/**
 * A context-owned declaration consumed by the platform worker's shared
 * retention-sweep runner. `predicateSql` is evaluated against the `candidate`
 * table alias and must be a trusted, parameter-free SQL expression.
 */
export type BcRetentionSweep = Readonly<{
  readonly name: string;
  readonly tableName: string;
  readonly predicateSql: string;
  readonly orderBySql: string;
  readonly intervalMs: number;
  readonly batchLimit: number;
}>;

export type BcRetentionExemption = Readonly<{
  readonly tableName: string;
  readonly owner: string;
  readonly reason: string;
}>;

export type BcSeedOptions = Readonly<{
  enabledDataProfiles: readonly EnvironmentDataProfile[];
  environmentName?: string | null;
}>;

export type BcCreateServicesOptions<TPool = unknown> = Readonly<{
  notificationWaiterPool?: TPool;
}>;

export interface BcApiModule<
  TServices = unknown,
  TPool = unknown,
  THostPorts = unknown,
  TRouter = unknown,
  TProjectionHandlerSet extends BcProjectionHandlerSet = BcProjectionHandlerSet,
> {
  readonly contextName: string;
  readonly routePrefix: string;
  readonly streamPrefix: string;
  readonly schemaSql: string;
  readonly schemaMigrations?: readonly BcSchemaMigration[];
  readonly retentionSweeps?: readonly BcRetentionSweep[];
  readonly retentionExemptions?: readonly BcRetentionExemption[];
  readonly apiMounts: readonly BcApiMount[];
  readonly anonymousRoutes?: readonly BcAnonymousRoute[];
  readonly mcpCapabilities?: BcMcpCapabilities;
  readonly projectionGroups?: readonly BcProjectionGroupDeclaration[];
  createServices(pool: TPool, ports: THostPorts, options?: BcCreateServicesOptions<TPool>): TServices;
  buildApis(services: TServices): readonly TRouter[];
  buildMcpHandlers?(services: TServices): BcMcpHandlers;
  projectionHandlerSets?(services: TServices): readonly TProjectionHandlerSet[];
  buildSubscriptions?(services: TServices): readonly BcEventSubscription[];
  buildProjectionGroups?(services: TServices): readonly BcProjectionGroup[];
  seedProfiles?: readonly EnvironmentDataProfile[];
  seed?(pool: TPool, services?: TServices, options?: BcSeedOptions): Promise<void>;
  /**
   * Context-owned, idempotent reconciliation for required bootstrap state.
   * Platform hosts may invoke this after waiting for another bootstrap that
   * failed, once local projections have drained. It must not replay scenario
   * or other non-idempotent seed behavior.
   */
  reconcileBootstrapState?(pool: TPool, services?: TServices, options?: BcSeedOptions): Promise<void>;
}

export type DefineBoundedContextModuleInput<
  TServices,
  TPool,
  THostPorts,
  TRouter = unknown,
  TProjectionHandlerSet extends BcProjectionHandlerSet = BcProjectionHandlerSet,
> = Readonly<{
  manifest: BcContextManifestInput;
  schemaSql: string;
  schemaMigrations?: readonly BcSchemaMigration[];
  retentionSweeps?: readonly BcRetentionSweep[];
  retentionExemptions?: readonly BcRetentionExemption[];
  createServices: BcApiModule<TServices, TPool, THostPorts, TRouter, TProjectionHandlerSet>["createServices"];
  buildApis: BcApiModule<TServices, TPool, THostPorts, TRouter, TProjectionHandlerSet>["buildApis"];
  buildMcpHandlers?: BcApiModule<TServices, TPool, THostPorts, TRouter, TProjectionHandlerSet>["buildMcpHandlers"];
  projectionHandlerSets?: BcApiModule<
    TServices,
    TPool,
    THostPorts,
    TRouter,
    TProjectionHandlerSet
  >["projectionHandlerSets"];
  buildSubscriptions?: BcApiModule<TServices, TPool, THostPorts, TRouter, TProjectionHandlerSet>["buildSubscriptions"];
  buildProjectionGroups?: BcApiModule<
    TServices,
    TPool,
    THostPorts,
    TRouter,
    TProjectionHandlerSet
  >["buildProjectionGroups"];
  seedProfiles?: readonly EnvironmentDataProfile[];
  seed?: BcApiModule<TServices, TPool, THostPorts, TRouter, TProjectionHandlerSet>["seed"];
  reconcileBootstrapState?: BcApiModule<
    TServices,
    TPool,
    THostPorts,
    TRouter,
    TProjectionHandlerSet
  >["reconcileBootstrapState"];
}>;

export function defineBoundedContextModule<
  TServices,
  TPool,
  THostPorts,
  TRouter = unknown,
  TProjectionHandlerSet extends BcProjectionHandlerSet = BcProjectionHandlerSet,
>(
  input: DefineBoundedContextModuleInput<TServices, TPool, THostPorts, TRouter, TProjectionHandlerSet>,
): BcApiModule<TServices, TPool, THostPorts, TRouter, TProjectionHandlerSet> {
  const manifest = normalizeContextManifest(input.manifest);

  return {
    contextName: manifest.contextName,
    routePrefix: manifest.apiBasePath,
    streamPrefix: manifest.streamPrefix,
    schemaSql: input.schemaSql,
    ...(input.schemaMigrations ? { schemaMigrations: input.schemaMigrations } : {}),
    ...(input.retentionSweeps ? { retentionSweeps: input.retentionSweeps } : {}),
    ...(input.retentionExemptions ? { retentionExemptions: input.retentionExemptions } : {}),
    apiMounts: manifest.apiMounts ?? [],
    anonymousRoutes: manifest.anonymousRoutes ?? [],
    ...(manifest.mcpCapabilities ? { mcpCapabilities: manifest.mcpCapabilities } : {}),
    ...(manifest.projectionGroups ? { projectionGroups: manifest.projectionGroups } : {}),
    createServices: input.createServices,
    buildApis: input.buildApis,
    ...(input.buildMcpHandlers ? { buildMcpHandlers: input.buildMcpHandlers } : {}),
    ...(input.projectionHandlerSets ? { projectionHandlerSets: input.projectionHandlerSets } : {}),
    ...(input.buildSubscriptions ? { buildSubscriptions: input.buildSubscriptions } : {}),
    ...(input.buildProjectionGroups ? { buildProjectionGroups: input.buildProjectionGroups } : {}),
    ...(input.seedProfiles ? { seedProfiles: input.seedProfiles } : {}),
    ...(input.seed ? { seed: input.seed } : {}),
    ...(input.reconcileBootstrapState ? { reconcileBootstrapState: input.reconcileBootstrapState } : {}),
  };
}

function normalizeContextManifest(manifest: BcContextManifestInput): BcContextManifest {
  return {
    contextName: manifest.contextName,
    apiBasePath: manifest.apiBasePath,
    streamPrefix: manifest.streamPrefix,
    ...(manifest.apiMounts ? { apiMounts: manifest.apiMounts as readonly BcApiMount[] } : {}),
    ...(manifest.anonymousRoutes ? { anonymousRoutes: manifest.anonymousRoutes as readonly BcAnonymousRoute[] } : {}),
    ...(manifest.mcpCapabilities ? { mcpCapabilities: manifest.mcpCapabilities } : {}),
    ...(manifest.eventSubscriptions
      ? {
          eventSubscriptions: manifest.eventSubscriptions.map((declaration) =>
            normalizeEventSubscriptionDeclaration(manifest.contextName, declaration),
          ),
        }
      : {}),
    ...(manifest.eventReactions
      ? {
          eventReactions: manifest.eventReactions.map((declaration) =>
            normalizeEventReactionDeclaration(manifest.contextName, declaration),
          ),
        }
      : {}),
    ...(manifest.projectionGroups
      ? {
          projectionGroups: manifest.projectionGroups.map((declaration) =>
            normalizeProjectionGroupDeclaration(manifest.contextName, declaration),
          ),
        }
      : {}),
    ...(manifest.apiRuntimeProfiles
      ? {
          apiRuntimeProfiles: normalizeRuntimeProfiles(
            manifest.contextName,
            "apiRuntimeProfiles",
            manifest.apiRuntimeProfiles,
          ),
        }
      : {}),
    ...(manifest.workerRuntimeProfiles
      ? {
          workerRuntimeProfiles: normalizeRuntimeProfiles(
            manifest.contextName,
            "workerRuntimeProfiles",
            manifest.workerRuntimeProfiles,
          ),
        }
      : {}),
  };
}

function normalizeEventSubscriptionDeclaration(
  contextName: string,
  declaration: BcEventSubscriptionManifestDeclaration,
): BcEventSubscriptionDeclaration {
  const { sourceContextMount: rawSourceContextMount, ...rest } = declaration;
  const sourceContextMount = normalizeOptionalSourceContextMount(
    contextName,
    declaration.projectionName,
    rawSourceContextMount,
  );

  return {
    ...rest,
    ...(sourceContextMount ? { sourceContextMount } : {}),
  };
}

function normalizeEventReactionDeclaration(
  contextName: string,
  declaration: BcEventReactionManifestDeclaration,
): BcEventReactionDeclaration {
  const { sourceContextMount: rawSourceContextMount, ...rest } = declaration;
  const sourceContextMount = normalizeOptionalSourceContextMount(
    contextName,
    declaration.reactionName,
    rawSourceContextMount,
  );

  return {
    ...rest,
    ...(sourceContextMount ? { sourceContextMount } : {}),
  };
}

function normalizeProjectionGroupDeclaration(
  contextName: string,
  declaration: BcProjectionGroupManifestDeclaration,
): BcProjectionGroupDeclaration {
  const {
    sourceContextMount: rawSourceContextMount,
    resetStrategy: rawResetStrategy,
    projectionName,
    ...rest
  } = declaration;
  const sourceContextMount = normalizeOptionalSourceContextMount(contextName, projectionName, rawSourceContextMount);
  const resetStrategy = normalizeOptionalProjectionGroupResetStrategy(contextName, projectionName, rawResetStrategy);

  return {
    ...rest,
    projectionName,
    ...(sourceContextMount ? { sourceContextMount } : {}),
    ...(resetStrategy ? { resetStrategy } : {}),
  };
}

function normalizeOptionalSourceContextMount(
  contextName: string,
  projectionName: string,
  value: string | undefined,
): BcSourceContextMount | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isSourceContextMount(value)) {
    return value;
  }

  throw new Error(
    `Context '${contextName}' projection '${projectionName}' declares unsupported sourceContextMount '${value}'. Expected one of: ${BC_SOURCE_CONTEXT_MOUNTS.join(", ")}.`,
  );
}

function normalizeOptionalProjectionGroupResetStrategy(
  contextName: string,
  projectionName: string,
  value: string | undefined,
): BcProjectionGroupResetStrategy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isProjectionGroupResetStrategy(value)) {
    return value;
  }

  throw new Error(
    `Context '${contextName}' projection group '${projectionName}' declares unsupported resetStrategy '${value}'. Expected one of: ${BC_PROJECTION_GROUP_RESET_STRATEGIES.join(", ")}.`,
  );
}

function normalizeRuntimeProfiles(
  contextName: string,
  propertyName: "apiRuntimeProfiles" | "workerRuntimeProfiles",
  values: readonly string[],
): readonly BcRuntimeProfile[] {
  return values.map((value) => {
    if (isRuntimeProfile(value)) {
      return value;
    }

    throw new Error(
      `Context '${contextName}' declares unsupported ${propertyName} entry '${value}'. Expected one of: ${BC_RUNTIME_PROFILES.join(", ")}.`,
    );
  });
}

function isSourceContextMount(value: string): value is BcSourceContextMount {
  return includesString(BC_SOURCE_CONTEXT_MOUNTS, value);
}

function isProjectionGroupResetStrategy(value: string): value is BcProjectionGroupResetStrategy {
  return includesString(BC_PROJECTION_GROUP_RESET_STRATEGIES, value);
}

function isRuntimeProfile(value: string): value is BcRuntimeProfile {
  return includesString(BC_RUNTIME_PROFILES, value);
}

function parseEventSubscriptionKey(
  subscriptionKey: string,
): Readonly<{ sourceContextName: string; projectionName: string }> {
  const separatorIndex = subscriptionKey.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === subscriptionKey.length - 1) {
    throw new Error(`Invalid event subscription key '${subscriptionKey}'. Use '<sourceContextName>.<projectionName>'.`);
  }

  return {
    sourceContextName: subscriptionKey.slice(0, separatorIndex),
    projectionName: subscriptionKey.slice(separatorIndex + 1),
  };
}

function parseEventReactionKey(reactionKey: string): Readonly<{ sourceContextName: string; reactionName: string }> {
  const separatorIndex = reactionKey.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === reactionKey.length - 1) {
    throw new Error(`Invalid event reaction key '${reactionKey}'. Use '<sourceContextName>.<reactionName>'.`);
  }

  return {
    sourceContextName: reactionKey.slice(0, separatorIndex),
    reactionName: reactionKey.slice(separatorIndex + 1),
  };
}

function normalizeEventSubscriptionHandlerRegistration(
  contextName: string,
  projectionName: string,
  registration: BcEventSubscriptionHandlerRegistration,
): Readonly<{
  subscriptionName: string;
  buildHandlers: BcEventSubscriptionHandlerMapBuilder;
  filterToEventTypes: boolean;
}> {
  if (typeof registration === "function") {
    return {
      subscriptionName: defaultSubscriptionName(contextName, projectionName),
      buildHandlers: registration,
      filterToEventTypes: false,
    };
  }

  return {
    subscriptionName: registration.subscriptionName ?? defaultSubscriptionName(contextName, projectionName),
    buildHandlers: registration.buildHandlers,
    filterToEventTypes: registration.filterToEventTypes ?? false,
  };
}

function normalizeEventReactionHandlerRegistration(
  contextName: string,
  reactionName: string,
  registration: BcEventReactionHandlerRegistration,
): Readonly<{
  subscriptionName: string;
  buildHandlers: BcEventReactionHandlerMapBuilder;
  filterToEventTypes: boolean;
}> {
  if (typeof registration === "function") {
    return {
      subscriptionName: defaultSubscriptionName(contextName, reactionName),
      buildHandlers: registration,
      filterToEventTypes: false,
    };
  }

  return {
    subscriptionName: registration.subscriptionName ?? defaultSubscriptionName(contextName, reactionName),
    buildHandlers: registration.buildHandlers,
    filterToEventTypes: registration.filterToEventTypes ?? false,
  };
}

function defaultSubscriptionName(contextName: string, projectionName: string): string {
  const contextPrefix = `${contextName}-`;
  return projectionName.startsWith(contextPrefix)
    ? `${contextName}.${projectionName.slice(contextPrefix.length)}`
    : `${contextName}.${projectionName}`;
}

function coerceProjectorHandlerMap(handlers: ProjectorHandlerMap | BcEventSubscriptionHandlerMap): ProjectorHandlerMap {
  return handlers as ProjectorHandlerMap;
}

function includesString<const TValues extends readonly string[]>(
  values: TValues,
  value: string,
): value is TValues[number] {
  return (values as readonly string[]).includes(value);
}
