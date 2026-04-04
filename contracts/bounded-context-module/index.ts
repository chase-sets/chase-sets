/**
 * Framework-agnostic contract for a bounded-context module.
 *
 * Context packages expose either a `module` constant or a module factory for
 * cases that require runtime configuration.
 */
export type BcProjector = Readonly<{
  runOnce(): Promise<Readonly<{ processed: number }>>;
}>;

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
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly href: string;
  readonly order: number;
  readonly visibility: BcShellContributionVisibility;
  readonly requiredPermissions: readonly string[];
}>;

export type BcApiMountKind = "primary" | "additional";

export type BcApiMount = Readonly<{
  readonly mountPath: string;
  readonly kind: BcApiMountKind;
  readonly requiresAuth: boolean;
  readonly drainProjectorsOnWrite: boolean;
}>;

export interface BcApiModule<
  TServices = unknown,
  TPool = unknown,
  TPorts = unknown,
  TRouter = unknown,
  TProjector extends BcProjector = BcProjector,
> {
  readonly contextName: string;
  readonly routePrefix: string;
  readonly streamPrefix: string;
  readonly schemaSql: string;
  createServices(pool: TPool, ports: TPorts): TServices;
  buildApi(services: TServices): TRouter;
  projectors(services: TServices): readonly TProjector[];
  seed?(pool: TPool): Promise<void>;
}
