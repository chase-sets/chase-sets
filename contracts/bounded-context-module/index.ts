/**
 * Framework-agnostic contract for a bounded-context module.
 *
 * Context packages expose either a `module` constant or a module factory for
 * cases that require runtime configuration.
 */
export type BcProjector = Readonly<{
  runOnce(): Promise<Readonly<{ processed: number }>>;
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

export type BcWebRouteModule = Readonly<{
  readonly routeId: string;
  readonly routePath: string;
  readonly sourceContext: string;
}>;
