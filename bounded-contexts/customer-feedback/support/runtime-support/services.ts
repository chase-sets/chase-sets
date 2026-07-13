import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createCsatInvitationRuntime } from "../../features/csat/api/runtime";

/**
 * Runtime services for the Customer Feedback context.
 *
 * Composes the invitation aggregate, event-store wake wiring, and context-owned
 * query projections while keeping the deployable host thin.
 */
export type CustomerFeedbackServices = Readonly<{
  invitations: ReturnType<typeof createCsatInvitationRuntime>;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export type CustomerFeedbackHostPorts = Readonly<Record<string, never>>;

export function createCustomerFeedbackServices(
  pool: PgTransactionalPool,
  _ports: CustomerFeedbackHostPorts = {},
): CustomerFeedbackServices {
  const db = pool as PgQueryable;
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({
      sourceContextName: "customer-feedback",
    }),
  });
  const invitations = createCsatInvitationRuntime({ eventStore, db });
  return { invitations, projectors: invitations.projectors, pool, db };
}
