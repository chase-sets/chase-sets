import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { TransactionalEmailOutbox } from "@chase-sets/communications-email";
import { createPostgresTransactionalEmailOutbox } from "@chase-sets/transactional-email-outbox";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createWaitlistRuntime } from "../../features/waitlist/api/runtime";

export type PublicPresenceHostPorts = Readonly<{
  transactionalEmailOutbox?: TransactionalEmailOutbox;
}>;

export type PublicPresenceServices = Readonly<{
  waitlist: ReturnType<typeof createWaitlistRuntime>;
  transactionalEmailOutbox: TransactionalEmailOutbox;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createPublicPresenceServices(
  pool: PgTransactionalPool,
  ports: PublicPresenceHostPorts = {},
): PublicPresenceServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const transactionalEmailOutbox = ports.transactionalEmailOutbox ?? createPostgresTransactionalEmailOutbox({ db });
  const waitlist = createWaitlistRuntime({
    eventStore,
    checkpointStore,
    db,
    transactionalEmailOutbox,
  });

  return {
    waitlist,
    transactionalEmailOutbox,
    projectors: [...waitlist.projectors],
    pool,
    db,
  };
}
