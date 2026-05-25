import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";

export type InsightsServices = Readonly<{
  pool: PgTransactionalPool;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createInsightsServices(pool: PgTransactionalPool): InsightsServices {
  return {
    pool,
    projectors: [],
  };
}
