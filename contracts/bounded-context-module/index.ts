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
  readonly projectionTransactionTimeoutMs?: number;
  readonly projectionStatementTimeoutMs?: number;
  readonly order?: number;
}>;

export type BcSourceContextMount = "required" | "when-mounted";

export type BcSubscriptionHandlerKind = "projection" | "reaction";
export type BcReactionIdempotencyPolicy = "idempotent-command-dispatch";
export type BcReactionRetryPolicy = "retry-from-last-checkpoint";
export type BcReactionFailurePolicy = "surface-as-reaction-failure";

export type BcEventReactionDeclaration = Readonly<{
  readonly sourceContextName: string;
  readonly reactionName: string;
  readonly subscriptionVersion: number;
  readonly reactionHandlerSetNames: readonly string[];
  readonly idempotencyPolicy: BcReactionIdempotencyPolicy;
  readonly retryPolicy: BcReactionRetryPolicy;
  readonly failurePolicy: BcReactionFailurePolicy;
  readonly eventTypes?: readonly string[];
  readonly streamPrefixes?: readonly string[];
  readonly errorPolicy?: ProjectionErrorPolicy;
  readonly order?: number;
}>;

export type BcProjectionGroupResetStrategy =
  | "replay-only"
  | "append-only-no-reset"
  | "truncate-owned-tables"
  | "generation-cutover";

export type BcProjectionGroupDeclaration = Readonly<{
  readonly projectionName: string;
  readonly handlerKind?: BcSubscriptionHandlerKind;
  readonly projectionRevision?: number;
  readonly sourceContextNames: readonly string[];
  readonly optionalSourceContextNames?: readonly string[];
  readonly ownedTables: readonly string[];
  readonly sideEffectOnly?: boolean;
  readonly resetStrategy?: BcProjectionGroupResetStrategy;
  readonly requiredDuringBootstrap?: boolean;
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
  readonly order?: number;
}>;

export type BcContextManifest = Readonly<{
  readonly contextName: string;
  readonly apiBasePath: string;
  readonly streamPrefix: string;
  readonly apiMounts?: readonly unknown[];
  readonly anonymousRoutes?: readonly unknown[];
  readonly eventSubscriptions?: readonly BcEventSubscriptionDeclaration[];
  readonly eventReactions?: readonly BcEventReactionDeclaration[];
  readonly projectionGroups?: readonly unknown[];
}>;

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
    manifest: Pick<BcContextManifest, "eventSubscriptions">;
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

    const normalizedRegistration = normalizeEventSubscriptionHandlerRegistration(
      contextName,
      projectionName,
      registration,
    );
    const handlerMap = coerceProjectorHandlerMap(normalizedRegistration.buildHandlers(declaration));

    return {
      subscriptionName: normalizedRegistration.subscriptionName,
      handlerKind: "projection",
      sourceContextName: declaration.sourceContextName,
      ...(declaration.sourceContextMount ? { sourceContextMount: declaration.sourceContextMount } : {}),
      projectionName: declaration.projectionName,
      subscriptionVersion: declaration.subscriptionVersion,
      handlers: normalizedRegistration.filterToEventTypes
        ? selectEventSubscriptionHandlers(handlerMap, declaration.eventTypes)
        : handlerMap,
      eventTypes: declaration.eventTypes,
      streamPrefixes: declaration.streamPrefixes,
      errorPolicy: declaration.errorPolicy,
      projectionTransactionTimeoutMs: declaration.projectionTransactionTimeoutMs,
      projectionStatementTimeoutMs: declaration.projectionStatementTimeoutMs,
      order: declaration.order,
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
  manifest: Pick<BcContextManifest, "eventReactions">;
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

    const normalizedRegistration = normalizeEventReactionHandlerRegistration(contextName, reactionName, registration);
    const handlerMap = coerceProjectorHandlerMap(normalizedRegistration.buildHandlers(declaration));

    return {
      subscriptionName: normalizedRegistration.subscriptionName,
      handlerKind: "reaction",
      sourceContextName: declaration.sourceContextName,
      projectionName: declaration.reactionName,
      reactionName: declaration.reactionName,
      subscriptionVersion: declaration.subscriptionVersion,
      handlers: normalizedRegistration.filterToEventTypes
        ? selectEventSubscriptionHandlers(handlerMap, declaration.eventTypes)
        : handlerMap,
      idempotencyPolicy: declaration.idempotencyPolicy,
      retryPolicy: declaration.retryPolicy,
      failurePolicy: declaration.failurePolicy,
      eventTypes: declaration.eventTypes,
      streamPrefixes: declaration.streamPrefixes,
      errorPolicy: declaration.errorPolicy,
      order: declaration.order,
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
] as const;

export type EnvironmentDataProfile = (typeof ENVIRONMENT_DATA_PROFILES)[number];

export type BcSchemaMigration = Readonly<{
  readonly migrationId: string;
  readonly description: string;
  readonly statements: readonly string[];
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
  readonly apiMounts: readonly BcApiMount[];
  readonly anonymousRoutes?: readonly BcAnonymousRoute[];
  readonly projectionGroups?: readonly BcProjectionGroupDeclaration[];
  createServices(pool: TPool, ports: THostPorts, options?: BcCreateServicesOptions<TPool>): TServices;
  buildApis(services: TServices): readonly TRouter[];
  projectionHandlerSets?(services: TServices): readonly TProjectionHandlerSet[];
  buildSubscriptions?(services: TServices): readonly BcEventSubscription[];
  buildProjectionGroups?(services: TServices): readonly BcProjectionGroup[];
  seedProfiles?: readonly EnvironmentDataProfile[];
  seed?(pool: TPool, services?: TServices, options?: BcSeedOptions): Promise<void>;
}

export type DefineBoundedContextModuleInput<
  TServices,
  TPool,
  THostPorts,
  TRouter = unknown,
  TProjectionHandlerSet extends BcProjectionHandlerSet = BcProjectionHandlerSet,
> = Readonly<{
  manifest: BcContextManifest;
  schemaSql: string;
  schemaMigrations?: readonly BcSchemaMigration[];
  createServices: BcApiModule<TServices, TPool, THostPorts, TRouter, TProjectionHandlerSet>["createServices"];
  buildApis: BcApiModule<TServices, TPool, THostPorts, TRouter, TProjectionHandlerSet>["buildApis"];
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
  return {
    contextName: input.manifest.contextName,
    routePrefix: input.manifest.apiBasePath,
    streamPrefix: input.manifest.streamPrefix,
    schemaSql: input.schemaSql,
    ...(input.schemaMigrations ? { schemaMigrations: input.schemaMigrations } : {}),
    apiMounts: (input.manifest.apiMounts ?? []) as readonly BcApiMount[],
    anonymousRoutes: (input.manifest.anonymousRoutes ?? []) as readonly BcAnonymousRoute[],
    ...(input.manifest.projectionGroups
      ? { projectionGroups: input.manifest.projectionGroups as readonly BcProjectionGroupDeclaration[] }
      : {}),
    createServices: input.createServices,
    buildApis: input.buildApis,
    ...(input.projectionHandlerSets ? { projectionHandlerSets: input.projectionHandlerSets } : {}),
    ...(input.buildSubscriptions ? { buildSubscriptions: input.buildSubscriptions } : {}),
    ...(input.buildProjectionGroups ? { buildProjectionGroups: input.buildProjectionGroups } : {}),
    ...(input.seedProfiles ? { seedProfiles: input.seedProfiles } : {}),
    ...(input.seed ? { seed: input.seed } : {}),
  };
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
