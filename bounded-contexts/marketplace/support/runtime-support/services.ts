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
import {
  createMarketplaceListingAuthority,
  type MarketplaceListingAuthorityPorts,
} from "../../features/listings/api/listing-authority";
import { createMarketplaceOfferRuntime } from "../../features/offers/api/runtime";
import { createMarketplaceReportRuntime } from "../../features/reports/api/runtime";
import { createReviewRuntime } from "../../features/reviews/api/runtime";
import { createSellerMetricsRuntime } from "../../features/seller-metrics/api/runtime";
import { createListingEvidencePolicyRuntime } from "../../features/listing-evidence-policy/api/runtime";
import type { SellerAttentionSource } from "@chase-sets/seller-attention-queue";
import { createSellerAttentionQueueRuntime } from "../../features/seller-desk/read-model/runtime";
import { createListingActionAttentionSourceFromReadModel } from "../../features/listings/read-model/seller-attention-source";
import { createOfferResponseAttentionSourceFromReadModel } from "../../features/offers/read-model/seller-attention-source";
import { createMarketplaceChannelInboundClampRuntime } from "../../features/channel-inbound-clamp/api/runtime";
import { createBuyerOfferPolicyRuntime } from "../../features/offer-policy/api/runtime";

export type MarketplaceServiceOptions = Readonly<{
  listingTargetAuthority?: import("../../features/listings/api/target-contracts").ListingTargetAuthority;
  listingCurrentReadiness?: import("../../features/listings/read-model/target-queries").ListingCurrentReadinessReader;
  listingAuthority?: MarketplaceListingAuthorityPorts;
  commercialTermsResolver?: CommercialTermsResolver;
  listingPhotoStorage?: ListingPhotoStorage;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
  /** Post-delivery review nudges (m108) ride this outbox. */
  notificationOutbox?: NotificationOutbox;
  sellerAttentionSources?: readonly SellerAttentionSource[];
}>;

export type MarketplaceServices = Readonly<{
  listingAuthority: ReturnType<typeof createMarketplaceListingAuthority>;
  listings: ReturnType<typeof createMarketplaceListingRuntime>;
  offers: ReturnType<typeof createMarketplaceOfferRuntime>;
  buyerOfferPolicies: ReturnType<typeof createBuyerOfferPolicyRuntime>;
  reports: ReturnType<typeof createMarketplaceReportRuntime>;
  reviews: ReturnType<typeof createReviewRuntime>;
  sellerMetrics: ReturnType<typeof createSellerMetricsRuntime>;
  listingEvidencePolicies: ReturnType<typeof createListingEvidencePolicyRuntime>;
  /** The shared platform-policy runtime, mounted for this context's `definePolicy` documents (listing-gate, seller-behavioral-metrics policies). */
  policies: PolicyRuntime;
  projectors: readonly ProjectionHandlerSet[];
  commercialTermsResolver: CommercialTermsResolver;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
  notificationOutbox: NotificationOutbox;
  pool: PgTransactionalPool;
  db: PgQueryable;
  sellerAttentionQueue: ReturnType<typeof createSellerAttentionQueueRuntime>;
  channelInboundClamp: ReturnType<typeof createMarketplaceChannelInboundClampRuntime>;
}>;

export function createMarketplaceServices(
  pool: PgTransactionalPool,
  options: MarketplaceServiceOptions = {},
): MarketplaceServices {
  const rawEventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "marketplace" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const listingAuthority = createMarketplaceListingAuthority(
    { eventStore: rawEventStore, db },
    options.listingAuthority ?? {
      consumer: () => {
        throw new Error("Marketplace Listing authority consumer is not mounted.");
      },
    },
  );
  const eventStore = listingAuthority.eventStore;
  const commercialTermsResolver = options.commercialTermsResolver ?? createMarketplaceCommercialTermsResolver(db);
  const notificationOutbox = options.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const policies = createPolicyRuntime({ eventStore, db });
  const listingEvidencePolicies = createListingEvidencePolicyRuntime({ db, policies });
  const deps = {
    eventStore,
    checkpointStore,
    db,
    commercialTermsResolver,
    policies,
    listingEvidencePolicyEvaluator: listingEvidencePolicies,
    ...(options.listingTargetAuthority ? { listingTargetAuthority: options.listingTargetAuthority } : {}),
    ...(options.listingCurrentReadiness ? { listingCurrentReadiness: options.listingCurrentReadiness } : {}),
    ...(options.listingPhotoStorage ? { listingPhotoStorage: options.listingPhotoStorage } : {}),
  } as const;
  const listings = createMarketplaceListingRuntime(deps);
  const offers = createMarketplaceOfferRuntime(deps);
  const buyerOfferPolicies = createBuyerOfferPolicyRuntime({ eventStore, db });
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
  const sellerAttentionQueue = createSellerAttentionQueueRuntime([
    ...(options.sellerAttentionSources ?? []),
    createOfferResponseAttentionSourceFromReadModel(db),
    createListingActionAttentionSourceFromReadModel(db),
  ]);
  const channelInboundClamp = createMarketplaceChannelInboundClampRuntime(pool, listings, eventStore);
  return {
    listingAuthority,
    listings,
    offers,
    buyerOfferPolicies,
    reports,
    reviews,
    sellerMetrics,
    listingEvidencePolicies,
    policies,
    projectors: [
      ...listings.projectors,
      ...offers.projectors,
      ...buyerOfferPolicies.projectors,
      ...reviews.projectors,
      ...policies.projectors,
    ],
    commercialTermsResolver,
    rateLimitPolicyResolver: options.rateLimitPolicyResolver,
    notificationOutbox,
    pool,
    db,
    sellerAttentionQueue,
    channelInboundClamp,
  };
}
