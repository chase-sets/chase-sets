import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createPlatformFeedbackRuntime } from "../../features/platform-feedback/api/runtime";

export type ExperienceServices = Readonly<{
  platformFeedback: ReturnType<typeof createPlatformFeedbackRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createExperienceServices(
  pool: PgTransactionalPool,
): ExperienceServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const platformFeedback = createPlatformFeedbackRuntime({
    eventStore,
    checkpointStore,
    db,
  });

  return {
    platformFeedback,
    projectors: [...platformFeedback.projectors],
    pool,
    db,
  };
}
