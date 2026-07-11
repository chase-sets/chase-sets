import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createPlatformFeedbackRuntime } from "../../features/platform-feedback/api/runtime";
import { createDashboardQueryService } from "../../features/insights-dashboards/read-model/queries";
import { createReportedContentRuntime } from "../../features/reported-content/api/runtime";
import { createRiskAlertRuntime } from "../../features/risk-alerts/api/runtime";
import { createSupportRequestRuntime } from "../../features/support-requests/api/runtime";

export type PlatformOperationsHostPorts = Readonly<{
  notificationOutbox?: NotificationOutbox;
}>;

export type PlatformOperationsServices = Readonly<{
  db: PgTransactionalPool;
  insightsDashboards: ReturnType<typeof createDashboardQueryService>;
  platformFeedback: ReturnType<typeof createPlatformFeedbackRuntime>;
  reportedContent: ReturnType<typeof createReportedContentRuntime>;
  riskAlerts: ReturnType<typeof createRiskAlertRuntime>;
  supportRequests: ReturnType<typeof createSupportRequestRuntime>;
  /** The shared platform-policy runtime, mounted for this context's `definePolicy` documents (currently just the rate-limit policy). */
  policies: PolicyRuntime;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createPlatformOperationsServices(
  pool: PgTransactionalPool,
  ports: PlatformOperationsHostPorts = {},
): PlatformOperationsServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({
      sourceContextName: "platform-operations",
    }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const platformFeedback = createPlatformFeedbackRuntime({
    eventStore,
    checkpointStore,
    db,
  });
  const reportedContent = createReportedContentRuntime({ db, eventStore });
  const riskAlerts = createRiskAlertRuntime({ db, eventStore });
  const notificationOutbox = ports.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const supportRequests = createSupportRequestRuntime({
    eventStore,
    checkpointStore,
    db,
    notificationOutbox,
  });
  const policies = createPolicyRuntime({ eventStore, db });

  return {
    db: pool,
    insightsDashboards: createDashboardQueryService(new Map()),
    platformFeedback,
    reportedContent,
    riskAlerts,
    supportRequests,
    policies,
    projectors: [
      ...platformFeedback.projectors,
      ...reportedContent.projectors,
      ...riskAlerts.projectors,
      ...supportRequests.projectors,
      ...policies.projectors,
    ],
  };
}
