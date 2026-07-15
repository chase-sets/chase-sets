import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createCsatInvitationRuntime } from "../../features/csat/api/runtime";
import { createFeedbackCaseRuntime } from "../../features/cases/api/runtime";
import { createFeedbackAttentionDigestRunner } from "../../features/attention/api/digest-runner";
import { createFeedbackNotificationDeliveryGuard } from "../../features/attention/integrations/notifications/delivery-authorization";

/**
 * Runtime services for the Customer Feedback context.
 *
 * Composes the invitation and feedback case aggregates, event-store wake wiring,
 * and context-owned query projections while keeping the deployable host thin.
 */
export type CustomerFeedbackServices = Readonly<{
  invitations: ReturnType<typeof createCsatInvitationRuntime>;
  cases: ReturnType<typeof createFeedbackCaseRuntime>;
  runAttentionDigest: ReturnType<typeof createFeedbackAttentionDigestRunner>;
  notificationDeliveryGuard: ReturnType<typeof createFeedbackNotificationDeliveryGuard>;
  eventStore: ReturnType<typeof createPostgresEventStore>;
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
  const cases = createFeedbackCaseRuntime({ eventStore, db });
  return {
    invitations,
    cases,
    runAttentionDigest: createFeedbackAttentionDigestRunner({ eventStore, db }),
    notificationDeliveryGuard: createFeedbackNotificationDeliveryGuard(cases.getByCaseId),
    eventStore,
    projectors: [...invitations.projectors, ...cases.projectors],
    pool,
    db,
  };
}
