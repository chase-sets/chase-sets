import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { createPromoBarRuntime } from "../../features/promo-bar/api/runtime";
import { noopWaitlistAnalyticsRecorder, type WaitlistAnalyticsRecorder } from "../../features/waitlist/api/analytics";
import { createWaitlistRuntime } from "../../features/waitlist/api/runtime";
import { createPublicPolicyValuesRuntime, type PublicPolicySource } from "../../features/help/api/public-policy-values";

export type PublicPresenceHostPorts = Readonly<{
  notificationOutbox?: NotificationOutbox;
  waitlistAnalyticsRecorder?: WaitlistAnalyticsRecorder;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
  publicPolicySources?: readonly PublicPolicySource[];
}>;

export type PublicPresenceServices = Readonly<{
  waitlist: ReturnType<typeof createWaitlistRuntime>;
  promoBar: ReturnType<typeof createPromoBarRuntime>;
  waitlistAnalyticsRecorder: WaitlistAnalyticsRecorder;
  notificationOutbox: NotificationOutbox;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
  publicPolicyValues: ReturnType<typeof createPublicPolicyValuesRuntime>;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createPublicPresenceServices(
  pool: PgTransactionalPool,
  ports: PublicPresenceHostPorts = {},
): PublicPresenceServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "public-presence" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const notificationOutbox = ports.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const waitlistAnalyticsRecorder = ports.waitlistAnalyticsRecorder ?? noopWaitlistAnalyticsRecorder;
  const promoBar = createPromoBarRuntime(db);
  const waitlist = createWaitlistRuntime({
    eventStore,
    checkpointStore,
    db,
    notificationOutbox,
  });
  const publicPolicyValues = createPublicPolicyValuesRuntime(ports.publicPolicySources ?? []);

  return {
    waitlist,
    promoBar,
    waitlistAnalyticsRecorder,
    notificationOutbox,
    rateLimitPolicyResolver: ports.rateLimitPolicyResolver,
    publicPolicyValues,
    projectors: [...waitlist.projectors],
    pool,
    db,
  };
}
