/**
 * Framework-agnostic contract for a bounded-context module.
 *
 * Context packages expose either a `module` constant or a module factory for
 * cases that require runtime configuration.
 */
export type BcProjector = Readonly<{
  runOnce(): Promise<Readonly<{ processed: number }>>;
}>;

export interface BcModule<
  TServices = unknown,
  TPool = unknown,
  TRouter = unknown,
  TProjector extends BcProjector = BcProjector,
> {
  readonly routePrefix: string;
  readonly schemaSql: string;
  createServices(pool: TPool): TServices;
  buildApi(services: TServices): TRouter;
  projectors(services: TServices): readonly TProjector[];
  seed?(pool: TPool): Promise<void>;
}
