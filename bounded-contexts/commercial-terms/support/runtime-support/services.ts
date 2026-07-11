import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createAgreementRuntime } from "../../features/agreements/api/runtime";
import { createResolutionRuntime } from "../../features/resolutions/api/runtime";
import { createScheduleRuntime } from "../../features/schedules/api/runtime";

export type CommercialTermsServices = Readonly<{
  schedules: ReturnType<typeof createScheduleRuntime>;
  agreements: ReturnType<typeof createAgreementRuntime>;
  resolutions: ReturnType<typeof createResolutionRuntime>;
  /** The shared platform-policy runtime, mounted for this context's `definePolicy` documents (currently just the checkout processing-fee policy). */
  policies: PolicyRuntime;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createCommercialTermsServices(pool: PgTransactionalPool): CommercialTermsServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({
      sourceContextName: "commercial-terms",
    }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const schedules = createScheduleRuntime({
    eventStore,
    checkpointStore,
    db,
  });
  const agreements = createAgreementRuntime({
    eventStore,
    checkpointStore,
    db,
  });
  const resolutions = createResolutionRuntime({
    db,
  });
  const policies = createPolicyRuntime({
    eventStore,
    db,
  });

  return {
    schedules,
    agreements,
    resolutions,
    policies,
    projectors: [...schedules.projectors, ...agreements.projectors, ...policies.projectors],
    pool,
    db,
  };
}
