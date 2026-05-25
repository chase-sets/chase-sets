import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createReviewRuntime } from "../../features/reviews/api/runtime";

export type ReputationServices = Readonly<{
  reviews: ReturnType<typeof createReviewRuntime>;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createReputationServices(pool: PgTransactionalPool): ReputationServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const reviews = createReviewRuntime({
    eventStore,
    checkpointStore,
    db,
  });

  return {
    reviews,
    projectors: [...reviews.projectors],
    pool,
    db,
  };
}
