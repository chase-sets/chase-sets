import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { ListingPhotoStorage } from ".";
import { createMarketplaceCommercialTermsResolver, type CommercialTermsResolver } from "../../api";
import { createMarketplaceListingRuntime } from "../../features/listings/api/runtime";
import { createMarketplaceOfferRuntime } from "../../features/offers/api/runtime";
import { createMarketplaceReportRuntime } from "../../features/reports/api/runtime";
import { createReviewRuntime } from "../../features/reviews/api/runtime";
import { createSellerMetricsRuntime } from "../../features/seller-metrics/api/runtime";

export type MarketplaceServiceOptions = Readonly<{
  commercialTermsResolver?: CommercialTermsResolver;
  listingPhotoStorage?: ListingPhotoStorage;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
  /** Post-delivery review nudges (m108) ride this outbox. */
  notificationOutbox?: NotificationOutbox;
}>;

export type MarketplaceServices = Readonly<{
  listings: ReturnType<typeof createMarketplaceListingRuntime>;
  offers: ReturnType<typeof createMarketplaceOfferRuntime>;
  reports: ReturnType<typeof createMarketplaceReportRuntime>;
  reviews: ReturnType<typeof createReviewRuntime>;
  sellerMetrics: ReturnType<typeof createSellerMetricsRuntime>;
  /** The shared platform-policy runtime, mounted for this context's `definePolicy` documents (listing-gate, seller-behavioral-metrics policies). */
  policies: PolicyRuntime;
  projectors: readonly ProjectionHandlerSet[];
  commercialTermsResolver: CommercialTermsResolver;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
  notificationOutbox: NotificationOutbox;
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createMarketplaceServices(
  pool: PgTransactionalPool,
  options: MarketplaceServiceOptions = {},
): MarketplaceServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "marketplace" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const commercialTermsResolver = options.commercialTermsResolver ?? createMarketplaceCommercialTermsResolver(db);
  const notificationOutbox = options.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const policies = createPolicyRuntime({ eventStore, db });
  const deps = {
    eventStore,
    checkpointStore,
    db,
    commercialTermsResolver,
    policies,
    ...(options.listingPhotoStorage ? { listingPhotoStorage: options.listingPhotoStorage } : {}),
  } as const;
  const listings = createMarketplaceListingRuntime(deps);
  const offers = createMarketplaceOfferRuntime(deps);
  const reports = createMarketplaceReportRuntime({
    eventStore,
    db,
  });
  const reviews = createReviewRuntime({
    eventStore,
    checkpointStore,
    db,
    notificationOutbox,
  });
  const sellerMetrics = createSellerMetricsRuntime({ db, policies });

  return {
    listings,
    offers,
    reports,
    reviews,
    sellerMetrics,
    policies,
    projectors: [...listings.projectors, ...offers.projectors, ...reviews.projectors, ...policies.projectors],
    commercialTermsResolver,
    rateLimitPolicyResolver: options.rateLimitPolicyResolver,
    notificationOutbox,
    pool,
    db,
  };
}
