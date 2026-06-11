import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createPlatformFeedbackRuntime } from "../../features/platform-feedback/api/runtime";
import {
  createReleaseControlsPolicyRuntime,
  type ReleaseControlsPolicyServices,
} from "../../features/release-controls/api/runtime";

export type PlatformOperationsServices = Readonly<{
  db: PgTransactionalPool;
  releaseControls: ReleaseControlsPolicyServices;
  platformFeedback: ReturnType<typeof createPlatformFeedbackRuntime>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createPlatformOperationsServices(pool: PgTransactionalPool): PlatformOperationsServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({
      sourceContextName: "platform-operations",
    }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const platformFeedback = createPlatformFeedbackRuntime({
    eventStore,
    checkpointStore,
    db: pool as PgQueryable,
  });

  return {
    db: pool,
    releaseControls: createReleaseControlsPolicyRuntime({ eventStore }),
    platformFeedback,
    projectors: [...platformFeedback.projectors],
  };
}
