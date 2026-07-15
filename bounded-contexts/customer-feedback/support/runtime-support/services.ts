import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createCsatInvitationRuntime } from "../../features/csat/api/runtime";
import { createFeedbackCaseRuntime } from "../../features/cases/api/runtime";
import { createFeedbackAttentionDigestRunner } from "../../features/attention/api/digest-runner";
import { createFeedbackNotificationDeliveryGuard } from "../../features/attention/integrations/notifications/delivery-authorization";
import { createCustomerFeedbackPrivacyRuntime } from "../../features/privacy/api/runtime";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";

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
  privacy: ReturnType<typeof createCustomerFeedbackPrivacyRuntime>;
  policies: PolicyRuntime;
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
  const policies = createPolicyRuntime({ eventStore, db });
  const invitations = createCsatInvitationRuntime({ eventStore, db, policies });
  const cases = createFeedbackCaseRuntime({ eventStore, db });
  const privacy = createCustomerFeedbackPrivacyRuntime({ pool, db, invitations, policies });
  return {
    invitations,
    cases,
    runAttentionDigest: createFeedbackAttentionDigestRunner({ eventStore, db }),
    notificationDeliveryGuard: createFeedbackNotificationDeliveryGuard(cases.getByCaseId),
    eventStore,
    privacy,
    policies,
    projectors: [...invitations.projectors, ...cases.projectors, ...policies.projectors],
    pool,
    db,
  };
}
