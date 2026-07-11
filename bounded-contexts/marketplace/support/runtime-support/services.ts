import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import type { ListingPhotoStorage } from ".";
import { createMarketplaceCommercialTermsResolver, type CommercialTermsResolver } from "../../api";
import { createMarketplaceListingRuntime } from "../../features/listings/api/runtime";
import { createMarketplaceOfferRuntime } from "../../features/offers/api/runtime";
import { createMarketplaceReportRuntime } from "../../features/reports/api/runtime";
import { createReviewRuntime } from "../../features/reviews/api/runtime";

export type MarketplaceServiceOptions = Readonly<{
  commercialTermsResolver?: CommercialTermsResolver;
  listingPhotoStorage?: ListingPhotoStorage;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
}>;

export type MarketplaceServices = Readonly<{
  listings: ReturnType<typeof createMarketplaceListingRuntime>;
  offers: ReturnType<typeof createMarketplaceOfferRuntime>;
  reports: ReturnType<typeof createMarketplaceReportRuntime>;
  reviews: ReturnType<typeof createReviewRuntime>;
  projectors: readonly ProjectionHandlerSet[];
  commercialTermsResolver: CommercialTermsResolver;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
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
  const deps = {
    eventStore,
    checkpointStore,
    db,
    commercialTermsResolver,
    ...(options.listingPhotoStorage ? { listingPhotoStorage: options.listingPhotoStorage } : {}),
  } as const;
  const listings = createMarketplaceListingRuntime(deps);
  const offers = createMarketplaceOfferRuntime(deps);
  const reports = createMarketplaceReportRuntime({
    eventStore,
  });
  const reviews = createReviewRuntime({
    eventStore,
    checkpointStore,
    db,
  });

  return {
    listings,
    offers,
    reports,
    reviews,
    projectors: [...listings.projectors, ...offers.projectors, ...reviews.projectors],
    commercialTermsResolver,
    rateLimitPolicyResolver: options.rateLimitPolicyResolver,
    pool,
    db,
  };
}
