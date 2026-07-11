import { createPostgresEventStore, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createAgreementRuntime } from "../../features/agreements/api/runtime";
import { createResolutionRuntime } from "../../features/resolutions/api/runtime";
import { createScheduleRuntime } from "../../features/schedules/api/runtime";
import { createCommercialTermsPolicyRuntime, type CommercialTermsPolicyRuntime } from "./policy-runtime";

export type CommercialTermsServices = Readonly<{
  schedules: ReturnType<typeof createScheduleRuntime>;
  agreements: ReturnType<typeof createAgreementRuntime>;
  resolutions: ReturnType<typeof createResolutionRuntime>;
  /**
   * The shared platform-policy runtime, mounted once for every
   * commercial-terms `definePolicy` document: the checkout processing-fee
   * policy, and schedules and agreements. There is exactly one
   * aggregate/projection pair for all three.
   */
  policies: CommercialTermsPolicyRuntime;
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
  const db = pool as PgQueryable;
  const policies = createCommercialTermsPolicyRuntime({
    eventStore,
    db,
  });
  const schedules = createScheduleRuntime({
    policies,
    db,
  });
  const agreements = createAgreementRuntime({
    policies,
    db,
  });
  const resolutions = createResolutionRuntime({
    db,
  });

  return {
    schedules,
    agreements,
    resolutions,
    policies,
    projectors: [...policies.projectors],
    pool,
    db,
  };
}
