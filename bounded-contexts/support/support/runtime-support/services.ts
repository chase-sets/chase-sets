import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createSupportRequestRuntime } from "../../features/support-requests/api/runtime";

export type SupportServices = Readonly<{
  supportRequests: ReturnType<typeof createSupportRequestRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createSupportServices(
  pool: PgTransactionalPool,
): SupportServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const supportRequests = createSupportRequestRuntime({
    eventStore,
    checkpointStore,
    db,
  });

  return {
    supportRequests,
    projectors: [...supportRequests.projectors],
    pool,
    db,
  };
}
