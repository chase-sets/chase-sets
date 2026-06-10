import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { TransactionalEmailOutbox } from "@chase-sets/communications-email";
import { createPostgresTransactionalEmailOutbox } from "@chase-sets/transactional-email-outbox";
import { createSupportRequestRuntime } from "../../features/support-requests/api/runtime";

export type SupportHostPorts = Readonly<{
  transactionalEmailOutbox?: TransactionalEmailOutbox;
}>;

export type SupportServices = Readonly<{
  supportRequests: ReturnType<typeof createSupportRequestRuntime>;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createSupportServices(pool: PgTransactionalPool, ports: SupportHostPorts = {}): SupportServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "support" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const transactionalEmailOutbox = ports.transactionalEmailOutbox ?? createPostgresTransactionalEmailOutbox({ db });
  const supportRequests = createSupportRequestRuntime({
    eventStore,
    checkpointStore,
    db,
    transactionalEmailOutbox,
  });

  return {
    supportRequests,
    projectors: [...supportRequests.projectors],
    pool,
    db,
  };
}
