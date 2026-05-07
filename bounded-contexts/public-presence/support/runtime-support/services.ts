import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createWaitlistRuntime } from "../../features/waitlist/api/runtime";

export type PublicPresenceServices = Readonly<{
  waitlist: ReturnType<typeof createWaitlistRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createPublicPresenceServices(
  pool: PgTransactionalPool,
): PublicPresenceServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const waitlist = createWaitlistRuntime({
    eventStore,
    checkpointStore,
    db,
  });

  return {
    waitlist,
    projectors: [...waitlist.projectors],
    pool,
    db,
  };
}
