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
import { createPlatformFeedbackRuntime } from "../../features/platform-feedback/api/runtime";
import { createSupportRequestRuntime } from "../../features/support-requests/api/runtime";
import {
  createReleaseControlsPolicyRuntime,
  type ReleaseControlsPolicyServices,
} from "../../features/release-controls/api/runtime";

export type PlatformOperationsHostPorts = Readonly<{
  transactionalEmailOutbox?: TransactionalEmailOutbox;
}>;

export type PlatformOperationsServices = Readonly<{
  db: PgTransactionalPool;
  releaseControls: ReleaseControlsPolicyServices;
  platformFeedback: ReturnType<typeof createPlatformFeedbackRuntime>;
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
  const transactionalEmailOutbox = ports.transactionalEmailOutbox ?? createPostgresTransactionalEmailOutbox({ db });
  const supportRequests = createSupportRequestRuntime({
    eventStore,
    checkpointStore,
    db,
    transactionalEmailOutbox,
  });

  return {
    db: pool,
    releaseControls: createReleaseControlsPolicyRuntime({ eventStore }),
    platformFeedback,
    supportRequests,
    projectors: [...platformFeedback.projectors, ...supportRequests.projectors],
  };
}
