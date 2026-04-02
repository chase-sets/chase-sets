import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createReputationReviewRuntime } from "./reviews/runtime";

export type ReputationServices = Readonly<{
  reviews: ReturnType<typeof createReputationReviewRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createReputationServices(
  pool: PgTransactionalPool,
): ReputationServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const reviews = createReputationReviewRuntime({
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
