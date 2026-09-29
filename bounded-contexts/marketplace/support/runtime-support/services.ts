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
import { createListingEvidencePolicyRuntime } from "../../features/listing-evidence-policy/api/runtime";
import type { SellerAttentionSource } from "@chase-sets/seller-attention-queue";
import { createSellerAttentionQueueRuntime } from "../../features/seller-desk/read-model/runtime";
import { createListingActionAttentionSourceFromReadModel } from "../../features/listings/read-model/seller-attention-source";
import { createOfferResponseAttentionSourceFromReadModel } from "../../features/offers/read-model/seller-attention-source";
import { createMarketplaceChannelInboundClampRuntime } from "../../features/channel-inbound-clamp/api/runtime";
import { createBuyerOfferPolicyRuntime } from "../../features/offer-policy/api/runtime";
import type { ManagedOfferPricing } from "../../features/offers/api/managed-authority";
import { createManagedOfferWork } from "../../features/offers/integrations/managed-work";
import { buildManagedOfferProjectionHandlers } from "../../features/offers/read-model/managed-projection";
import { createProjectionHandlerSet } from "@chase-sets/event-core/projector";

export type MarketplaceServiceOptions = Readonly<{
  managedOfferPricing?: ManagedOfferPricing;
  commercialTermsResolver?: CommercialTermsResolver;
  listingPhotoStorage?: ListingPhotoStorage;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
  /** Post-delivery review nudges (m108) ride this outbox. */
  notificationOutbox?: NotificationOutbox;
  sellerAttentionSources?: readonly SellerAttentionSource[];
}>;

export type MarketplaceServices = Readonly<{
  managedOfferWork: ReturnType<typeof createManagedOfferWork>;
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
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "marketplace" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
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
    ...(options.managedOfferPricing ? { managedOfferPricing: options.managedOfferPricing } : {}),
    ...(options.listingPhotoStorage ? { listingPhotoStorage: options.listingPhotoStorage } : {}),
  } as const;
  const listings = createMarketplaceListingRuntime(deps);
  const offers = createMarketplaceOfferRuntime(deps);
  const managedOfferWork = createManagedOfferWork({ eventStore, db, offers });
  const buyerOfferPolicies = createBuyerOfferPolicyRuntime({
    eventStore,
    db,
    ...(options.managedOfferPricing
      ? {
          managedOfferPricing: options.managedOfferPricing,
          enforcement: {
            assertInstalled() {
              if (!eventStore.appendToStreams) throw new Error("Managed Offer atomic enforcement is unavailable.");
            },
          },
        }
      : {}),
  });
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
  const channelInboundClamp = createMarketplaceChannelInboundClampRuntime(pool, listings);
  return {
    managedOfferWork,
    listings,
    offers,
    buyerOfferPolicies,
    reports,
    reviews,
    sellerMetrics,
    listingEvidencePolicies,
    policies,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "marketplace-managed-offer-projection",
        handlers: buildManagedOfferProjectionHandlers(db),
      }),
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
