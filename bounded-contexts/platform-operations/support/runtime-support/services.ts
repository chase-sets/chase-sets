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
import { createPlatformFeedbackRuntime } from "../../features/platform-feedback/api/runtime";
import { createReportedContentRuntime } from "../../features/reported-content/api/runtime";
import { createRiskAlertRuntime } from "../../features/risk-alerts/api/runtime";
import { createSupportRequestRuntime } from "../../features/support-requests/api/runtime";

export type PlatformOperationsHostPorts = Readonly<{
  notificationOutbox?: NotificationOutbox;
}>;

export type PlatformOperationsServices = Readonly<{
  db: PgTransactionalPool;
  platformFeedback: ReturnType<typeof createPlatformFeedbackRuntime>;
  reportedContent: ReturnType<typeof createReportedContentRuntime>;
  riskAlerts: ReturnType<typeof createRiskAlertRuntime>;
  supportRequests: ReturnType<typeof createSupportRequestRuntime>;
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

  return {
    db: pool,
    platformFeedback,
    reportedContent,
    riskAlerts,
    supportRequests,
    projectors: [
      ...platformFeedback.projectors,
      ...reportedContent.projectors,
      ...riskAlerts.projectors,
      ...supportRequests.projectors,
    ],
  };
}
