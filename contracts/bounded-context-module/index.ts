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

export type BcEventSubscriptionDeclaration = Readonly<{
  readonly sourceContextName: string;
  readonly projectionName: string;
  readonly subscriptionVersion: number;
  readonly projectionHandlerSetNames: readonly string[];
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
  readonly projectionRevision?: number;
  readonly sourceContextNames: readonly string[];
  readonly ownedTables: readonly string[];
  readonly sideEffectOnly?: boolean;
  readonly resetStrategy?: BcProjectionGroupResetStrategy;
  readonly requiredDuringBootstrap?: boolean;
}>;

export type BcEventSubscription = Readonly<{
  readonly subscriptionName: string;
  readonly sourceContextName: string;
  readonly projectionName: string;
  readonly subscriptionVersion: number;
  readonly handlers: ProjectorHandlerMap;
  readonly eventTypes?: readonly string[];
  readonly streamPrefixes?: readonly string[];
  readonly errorPolicy?: ProjectionErrorPolicy;
  readonly batchSize?: number;
  readonly checkpointBatchSize?: number;
  readonly order?: number;
}>;

export type BcContextManifest = Readonly<{
  readonly contextName: string;
  readonly apiBasePath: string;
  readonly streamPrefix: string;
  readonly apiMounts?: readonly unknown[];
  readonly eventSubscriptions?: readonly BcEventSubscriptionDeclaration[];
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
      sourceContextName: declaration.sourceContextName,
      projectionName: declaration.projectionName,
      subscriptionVersion: declaration.subscriptionVersion,
      handlers: normalizedRegistration.filterToEventTypes
        ? selectEventSubscriptionHandlers(handlerMap, declaration.eventTypes)
        : handlerMap,
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

export type EnvironmentDataProfile =
  | "critical-bootstrap"
  | "catalog-integration-bootstrap"
  | "scenario-seed"
  | "representative-commerce-state";

export type BcSeedOptions = Readonly<{
  enabledDataProfiles: readonly EnvironmentDataProfile[];
  environmentName?: string | null;
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
  readonly apiMounts: readonly BcApiMount[];
  readonly projectionGroups?: readonly BcProjectionGroupDeclaration[];
  createServices(pool: TPool, ports: THostPorts): TServices;
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
    apiMounts: (input.manifest.apiMounts ?? []) as readonly BcApiMount[],
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

function defaultSubscriptionName(contextName: string, projectionName: string): string {
  const contextPrefix = `${contextName}-`;
  return projectionName.startsWith(contextPrefix)
    ? `${contextName}.${projectionName.slice(contextPrefix.length)}`
    : `${contextName}.${projectionName}`;
}

function coerceProjectorHandlerMap(handlers: ProjectorHandlerMap | BcEventSubscriptionHandlerMap): ProjectorHandlerMap {
  return handlers as ProjectorHandlerMap;
}
