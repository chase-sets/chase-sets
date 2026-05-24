import type {
  ProjectionErrorPolicy,
  Projector as EventProjector,
  ProjectorHandlerMap,
} from "@chase-sets/event-core/projector";

/**
 * Framework-agnostic contract for a bounded-context module.
 *
 * Context packages expose either a `module` constant or a module factory for
 * cases that require runtime configuration.
 */
export type BcProjector = EventProjector;

export type BcRouteType = "route" | "index";
export type BcRoutePlacement = "root" | "layout";

export type BcRouteModule = Readonly<{
  readonly routeId: string;
  readonly routePath: string;
  readonly fileExport: string;
  readonly routeType: BcRouteType;
  readonly sourceContext: string;
  readonly placement?: BcRoutePlacement;
}>;

export type BcDeployableContribution = Readonly<{
  readonly deployable: string;
  readonly routes: readonly BcRouteModule[];
}>;

export type BcShellContributionSlot = "primary-nav" | "top-nav" | "bottom-nav";
export type BcShellContributionVisibility = "always" | "signed-in" | "signed-out";

export type BcShellContribution = Readonly<{
  readonly deployable: string;
  readonly slot: BcShellContributionSlot;
  readonly placements?: readonly BcShellContributionSlot[];
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly href: string;
  readonly order: number;
  readonly visibility: BcShellContributionVisibility;
  readonly requiredPermissions: readonly string[];
}>;

export type BcHostPort = Readonly<{
  readonly portName: string;
}>;

export type BcApiMountKind = "primary" | "additional";

export type BcApiMount = Readonly<{
  readonly mountPath: string;
  readonly kind: BcApiMountKind;
  readonly requiresAuth: boolean;
  readonly drainProjectorsOnWrite: boolean;
}>;

export type BcEventSubscriptionDeclaration = Readonly<{
  readonly sourceContextName: string;
  readonly projectionName: string;
  readonly subscriptionVersion: number;
  readonly projectorNames: readonly string[];
  readonly eventTypes?: readonly string[];
  readonly streamPrefixes?: readonly string[];
  readonly errorPolicy?: ProjectionErrorPolicy;
  readonly order?: number;
}>;

export type BcProjectionGroupDeclaration = Readonly<{
  readonly projectionName: string;
  readonly projectionRevision?: number;
  readonly sourceContextNames: readonly string[];
  readonly ownedTables: readonly string[];
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
  readonly order?: number;
}>;

export type BcProjectionGroup = BcProjectionGroupDeclaration &
  Readonly<{
    readonly reset?: () => Promise<void>;
  }>;

export type EnvironmentDataProfile = "critical-bootstrap" | "catalog-integration-bootstrap" | "scenario-seed";

export type BcSeedOptions = Readonly<{
  enabledDataProfiles: readonly EnvironmentDataProfile[];
  environmentName?: string | null;
}>;

export interface BcApiModule<
  TServices = unknown,
  TPool = unknown,
  THostPorts = unknown,
  TRouter = unknown,
  TProjector extends BcProjector = BcProjector,
> {
  readonly contextName: string;
  readonly routePrefix: string;
  readonly streamPrefix: string;
  readonly schemaSql: string;
  readonly apiMounts: readonly BcApiMount[];
  readonly projectionGroups?: readonly BcProjectionGroupDeclaration[];
  createServices(pool: TPool, ports: THostPorts): TServices;
  buildApis(services: TServices): readonly TRouter[];
  projectors(services: TServices): readonly TProjector[];
  buildSubscriptions?(services: TServices): readonly BcEventSubscription[];
  buildProjectionGroups?(services: TServices): readonly BcProjectionGroup[];
  seedProfiles?: readonly EnvironmentDataProfile[];
  seed?(pool: TPool, services?: TServices, options?: BcSeedOptions): Promise<void>;
}
