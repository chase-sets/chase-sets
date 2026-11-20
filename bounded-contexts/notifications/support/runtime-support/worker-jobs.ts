import type { WorkerRunner } from "@chase-sets/bounded-context-module";
import type { WorkerJobInput } from "@chase-sets/platform-runtime/worker-jobs";
import type { NotificationsServices } from "../../features/notification-center/api/services";
import type { CustomerFeedbackServices } from "@chase-sets/customer-feedback/server";
import { createNotificationOutboxDispatcher, createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createPostgresWebNotificationAdapter } from "@chase-sets/web-notifications";
export function createNotificationDispatchRunners({
  runtime,
  config: { workerId },
  notification,
}: Pick<
  WorkerJobInput<Readonly<{ workerId: string }>>,
  "runtime" | "config" | "notification"
>): readonly WorkerRunner[] {
  if (!notification) throw new Error("Notification dispatch ports are unavailable.");
  const notificationCenterContext = runtime.mountedContexts.find((context) => context.contextName === "notifications");
  const preferenceResolver = (notificationCenterContext?.services as NotificationsServices | undefined)
    ?.notificationPreferenceResolver;
  if (!preferenceResolver) {
    throw new Error("Notifications preference resolver is unavailable for notification dispatch.");
  }
  const deliveryOutcomeReporter = (notificationCenterContext?.services as NotificationsServices | undefined)
    ?.notificationDeliveryOutcomeReporter;
  const customerFeedbackContext = runtime.mountedContexts.find(
    (context) => context.contextName === "customer-feedback",
  );
  const deliveryGuard = (customerFeedbackContext?.services as CustomerFeedbackServices | undefined)
    ?.notificationDeliveryGuard;
  const mobileMessageAdapters = notification.mobileMessageAdapters();
  return runtime.mountedContexts
    .filter((context) => notification.outboxContextNames.has(context.contextName))
    .map((context) => {
      const webNotificationDb = notificationCenterContext?.pool ?? context.pool;
      const dispatcher = createNotificationOutboxDispatcher({
        outbox: createPostgresNotificationOutbox({ db: context.pool }),
        preferenceResolver,
        ...(deliveryGuard ? { deliveryGuard } : {}),
        ...(deliveryOutcomeReporter ? { deliveryOutcomeReporter } : {}),
        adapters: [
          notification.emailAdapter,
          ...mobileMessageAdapters,
          createPostgresWebNotificationAdapter({ db: webNotificationDb }),
        ],
        claimOwnerId: `${workerId}:${context.contextName}:notifications`,
      });

      return {
        name: `${context.contextName}.notification-dispatcher`,
        kind: "job",
        runOnce: dispatcher.runOnce,
      };
    });
}
