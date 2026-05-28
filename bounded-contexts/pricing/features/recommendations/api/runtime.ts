import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createPostgresDurableJobStore,
  type DurableJobEvent,
  type DurableJobRecord,
} from "@chase-sets/platform-runtime/durable-job-store";
import {
  getAccountRecommendation,
  listAccountRecommendations,
  listAccountRecommendationsByIds,
  type AccountRecommendationListItem,
} from "../read-model/queries";
import { buildPricingRecommendationProjectionHandlers } from "../read-model/projection";
import {
  decidePricingRecommendation,
  evolvePricingRecommendation,
  initialPricingRecommendationState,
  type PricingMarketSignalType,
  type PricingRecommendationCommand,
  type PricingRecommendationEvent,
  type PricingRecommendationState,
} from "../domain/domain";

type PricingRecommendationRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type PricingMarketplaceListingGateway = Readonly<{
  previewListingTerms: (body: Readonly<{ priceAmount: string }>) => Promise<{ fee_quote_fingerprint: string }>;
  updateListingPrice: (
    listingId: string,
    body: Readonly<{ priceAmount: string; feeQuoteFingerprint?: string | null }>,
  ) => Promise<unknown>;
  createListing: (
    body: Readonly<{
      inventoryItemId: string;
      priceAmount: string;
      quantityCap: number;
    }>,
  ) => Promise<{ id?: string; listing_id?: string }>;
  staleFeeQuoteFingerprint?: (error: unknown) => string | null;
}>;

type RefreshCandidate = Readonly<{
  actionType: "active-listing-price-update" | "draft-listing-price-update" | "draft-listing-create";
  sellerAccountId: string;
  catalogItemId: string;
  productId: string;
  listingId: string | null;
  inventoryItemId: string | null;
  currentPriceAmount: string | null;
  quantityCap: number | null;
  competitorPriceAmount: string | null;
  offerPriceAmount: string | null;
}>;

export type PricingRecommendationJobAction = "refresh" | "apply" | "dismiss";

export type PricingRecommendationJobPayload = Readonly<{
  action: PricingRecommendationJobAction;
  accountId: string;
  recommendationIds: readonly string[];
}>;

export type PricingRecommendationJobProgress = Readonly<{
  phase: "queued" | "processing" | "completed" | "failed";
  completed: number;
  total: number;
  message: string | null;
}>;

export type PricingRecommendationJobResult = Readonly<{
  proposedCount?: number;
  appliedCount?: number;
  failedCount?: number;
  dismissedCount?: number;
}>;

export type PricingRecommendationJob = DurableJobRecord<
  PricingRecommendationJobPayload,
  PricingRecommendationJobProgress,
  PricingRecommendationJobResult
>;

function moneyNumber(value: string | number | null) {
  if (value === null) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function moneyString(value: number) {
  return value.toFixed(2);
}

function safeIdPart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function recommendationIdFor(candidate: RefreshCandidate) {
  const targetId = candidate.actionType === "draft-listing-create" ? candidate.inventoryItemId : candidate.listingId;
  return [
    "rec",
    safeIdPart(candidate.sellerAccountId),
    safeIdPart(candidate.actionType),
    safeIdPart(targetId ?? candidate.catalogItemId),
  ].join("_");
}

function recommendedAmount(candidate: RefreshCandidate) {
  const competitor = moneyNumber(candidate.competitorPriceAmount);
  const offer = moneyNumber(candidate.offerPriceAmount);
  if (competitor !== null) {
    return {
      marketPriceAmount: competitor,
      marketSignalType: "competition" as PricingMarketSignalType,
      recommendedListAmount: Math.max(0.01, Number((competitor - 0.01).toFixed(2))),
      reason: "Priced one cent below the lowest competing active listing.",
    };
  }
  if (offer !== null) {
    return {
      marketPriceAmount: offer,
      marketSignalType: "offer" as PricingMarketSignalType,
      recommendedListAmount: offer,
      reason: "Matched to the highest submitted buyer offer.",
    };
  }
  return null;
}

async function listRefreshCandidates(db: PgQueryable, accountId: string): Promise<RefreshCandidate[]> {
  const listingResult = await db.query<{
    action_type: RefreshCandidate["actionType"];
    seller_account_id: string;
    catalog_catalog_item_id: string;
    product_id: string;
    listing_id: string;
    inventory_item_id: string | null;
    current_price_amount: string;
    quantity_cap: number;
    competitor_price_amount: string | null;
    offer_price_amount: string | null;
  }>(
    `SELECT
       CASE
         WHEN listing.status = 'active' THEN 'active-listing-price-update'
         ELSE 'draft-listing-price-update'
       END AS action_type,
       listing.seller_account_id,
       listing.catalog_catalog_item_id,
       listing.product_id,
       listing.listing_id,
       listing.inventory_item_id,
       listing.price_amount::text AS current_price_amount,
       listing.quantity_cap,
       (
         SELECT MIN(other.price_amount)::text
         FROM pricing_market_listing_inputs AS other
         WHERE other.catalog_catalog_item_id = listing.catalog_catalog_item_id
           AND other.product_id = listing.product_id
           AND other.status = 'active'
           AND other.seller_account_id <> listing.seller_account_id
       ) AS competitor_price_amount,
       (
         SELECT MAX(offer.price_amount)::text
         FROM pricing_buyer_offer_inputs AS offer
         WHERE offer.catalog_catalog_item_id = listing.catalog_catalog_item_id
           AND offer.product_id = listing.product_id
           AND offer.status = 'submitted'
       ) AS offer_price_amount
     FROM pricing_market_listing_inputs AS listing
     WHERE listing.seller_account_id = $1
       AND listing.status IN ('active', 'draft')`,
    [accountId],
  );

  const inventoryResult = await db.query<{
    seller_account_id: string;
    catalog_catalog_item_id: string;
    product_id: string;
    inventory_item_id: string;
    available_quantity: number;
    competitor_price_amount: string | null;
    offer_price_amount: string | null;
  }>(
    `SELECT
       item.seller_account_id,
       item.catalog_catalog_item_id,
       item.product_id,
       item.item_id AS inventory_item_id,
       GREATEST(
         item.total_quantity
           - COALESCE(active_holds.held_quantity, 0)
           - COALESCE(active_listings.listed_quantity, 0),
         0
       )::integer AS available_quantity,
       (
         SELECT MIN(other.price_amount)::text
         FROM pricing_market_listing_inputs AS other
         WHERE other.catalog_catalog_item_id = item.catalog_catalog_item_id
           AND other.product_id = item.product_id
           AND other.status = 'active'
           AND other.seller_account_id <> item.seller_account_id
       ) AS competitor_price_amount,
       (
         SELECT MAX(offer.price_amount)::text
         FROM pricing_buyer_offer_inputs AS offer
         WHERE offer.catalog_catalog_item_id = item.catalog_catalog_item_id
           AND offer.product_id = item.product_id
           AND offer.status = 'submitted'
       ) AS offer_price_amount
     FROM pricing_inventory_item_inputs AS item
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM pricing_inventory_hold_inputs
       WHERE status = 'active'
       GROUP BY item_id
     ) AS active_holds ON active_holds.item_id = item.item_id
     LEFT JOIN (
       SELECT inventory_item_id, SUM(quantity_cap)::integer AS listed_quantity
       FROM pricing_market_listing_inputs
       WHERE status IN ('active', 'draft')
         AND inventory_item_id IS NOT NULL
       GROUP BY inventory_item_id
     ) AS active_listings ON active_listings.inventory_item_id = item.item_id
     WHERE item.seller_account_id = $1`,
    [accountId],
  );

  return [
    ...listingResult.rows.map((row) => ({
      actionType: row.action_type,
      sellerAccountId: row.seller_account_id,
      catalogItemId: row.catalog_catalog_item_id,
      productId: row.product_id,
      listingId: row.listing_id,
      inventoryItemId: row.inventory_item_id,
      currentPriceAmount: row.current_price_amount,
      quantityCap: row.quantity_cap,
      competitorPriceAmount: row.competitor_price_amount,
      offerPriceAmount: row.offer_price_amount,
    })),
    ...inventoryResult.rows
      .filter((row) => row.available_quantity > 0)
      .map((row) => ({
        actionType: "draft-listing-create" as const,
        sellerAccountId: row.seller_account_id,
        catalogItemId: row.catalog_catalog_item_id,
        productId: row.product_id,
        listingId: null,
        inventoryItemId: row.inventory_item_id,
        currentPriceAmount: null,
        quantityCap: row.available_quantity,
        competitorPriceAmount: row.competitor_price_amount,
        offerPriceAmount: row.offer_price_amount,
      })),
  ];
}

function isSelectedProposedRecommendation(row: AccountRecommendationListItem) {
  return row.status === "proposed" || row.status === "failed";
}

export type PricingRecommendationServices = Readonly<{
  commandHandler: CommandHandler<PricingRecommendationCommand, PricingRecommendationState, PricingRecommendationEvent>;
  captureMarketSnapshot: (
    params: Readonly<{
      recommendationId: string;
      catalogItemId: string;
      accountId: string;
      marketPriceAmount: number;
      marketCurrency: string;
      observedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ recommendationId: string; version: number }>;
  publishRecommendation: (
    params: Readonly<{
      recommendationId: string;
      accountId: string;
      recommendedListAmount: number;
      reason: string;
      publishedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ recommendationId: string; version: number }>;
  listAccountRecommendations: (
    params: Parameters<typeof listAccountRecommendations>[1],
  ) => ReturnType<typeof listAccountRecommendations>;
  getAccountRecommendation: (
    recommendationId: string,
    accountId: string,
  ) => ReturnType<typeof getAccountRecommendation>;
  refreshRecommendations: (
    params: Readonly<{ accountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ proposedCount: number }>;
  applyRecommendations: (
    params: Readonly<{
      accountId: string;
      recommendationIds: readonly string[];
      marketplaceListings: PricingMarketplaceListingGateway;
    }>,
    context: EventStoreContext,
  ) => Promise<{ appliedCount: number; failedCount: number }>;
  dismissRecommendations: (
    params: Readonly<{ accountId: string; recommendationIds: readonly string[] }>,
    context: EventStoreContext,
  ) => Promise<{ dismissedCount: number }>;
  enqueueRecommendationJob: (
    params: Readonly<{
      action: PricingRecommendationJobAction;
      accountId: string;
      recommendationIds?: readonly string[];
    }>,
    context: EventStoreContext,
  ) => Promise<PricingRecommendationJob>;
  getRecommendationJob: (jobId: string) => Promise<PricingRecommendationJob | null>;
  listRecommendationJobEvents: (
    jobId: string,
    afterSequence?: number,
  ) => Promise<
    readonly DurableJobEvent<
      PricingRecommendationJobPayload,
      PricingRecommendationJobProgress,
      PricingRecommendationJobResult
    >[]
  >;
  processNextRecommendationJob: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    marketplaceListingGatewayForAccount: (accountId: string) => PricingMarketplaceListingGateway;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }) => Promise<number>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createPricingRecommendationRuntime(
  deps: PricingRecommendationRuntimeDeps,
): PricingRecommendationServices {
  const jobStore = createPostgresDurableJobStore<
    PricingRecommendationJobPayload,
    PricingRecommendationJobProgress,
    PricingRecommendationJobResult
  >(deps.db, {
    jobsTable: "pricing_recommendation_jobs",
    eventsTable: "pricing_recommendation_job_events",
  });
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<PricingRecommendationEvent>(),
      initialState: () => initialPricingRecommendationState,
      evolve: evolvePricingRecommendation,
    }),
    evolve: evolvePricingRecommendation,
    decide: decidePricingRecommendation,
  });

  const refreshRecommendations: PricingRecommendationServices["refreshRecommendations"] = async (params, context) => {
    const candidates = await listRefreshCandidates(deps.db, params.accountId);
    const observedAt = new Date().toISOString();
    let proposedCount = 0;

    for (const candidate of candidates) {
      const recommendation = recommendedAmount(candidate);
      const currentPriceAmount = moneyNumber(candidate.currentPriceAmount);
      if (!recommendation) {
        continue;
      }
      if (currentPriceAmount !== null && currentPriceAmount === recommendation.recommendedListAmount) {
        continue;
      }

      const recommendationId = recommendationIdFor(candidate);
      await commandHandler({
        streamId: `pricing.recommendation-${recommendationId}`,
        command: {
          type: "ProposeRecommendation",
          recommendationId,
          catalogItemId: candidate.catalogItemId,
          sellerAccountId: candidate.sellerAccountId,
          actionType: candidate.actionType,
          listingId: candidate.listingId,
          inventoryItemId: candidate.inventoryItemId,
          marketPriceAmount: recommendation.marketPriceAmount,
          marketCurrency: "USD",
          marketSignalType: recommendation.marketSignalType,
          currentPriceAmount,
          recommendedListAmount: recommendation.recommendedListAmount,
          reason: recommendation.reason,
          quantityCap: candidate.quantityCap,
          observedAt,
        },
        context,
      });
      proposedCount += 1;
    }

    return { proposedCount };
  };

  const applyRecommendations: PricingRecommendationServices["applyRecommendations"] = async (params, context) => {
    const rows = await listAccountRecommendationsByIds(deps.db, {
      accountId: params.accountId,
      recommendationIds: params.recommendationIds,
    });
    let appliedCount = 0;
    let failedCount = 0;

    for (const row of rows.filter(isSelectedProposedRecommendation)) {
      try {
        const priceAmount = row.recommended_list_amount;
        if (priceAmount === null) {
          throw new Error("Recommendation is missing a recommended price.");
        }
        const price = moneyString(Number(priceAmount));
        let appliedListingId = row.listing_id;

        if (row.action_type === "active-listing-price-update" || row.action_type === "draft-listing-price-update") {
          if (!row.listing_id) {
            throw new Error("Recommendation is missing a listing target.");
          }
          const quote = await params.marketplaceListings.previewListingTerms({
            priceAmount: price,
          });
          try {
            await params.marketplaceListings.updateListingPrice(row.listing_id, {
              priceAmount: price,
              feeQuoteFingerprint: quote.fee_quote_fingerprint,
            });
          } catch (error) {
            const retryFingerprint = params.marketplaceListings.staleFeeQuoteFingerprint?.(error);
            if (!retryFingerprint) {
              throw error;
            }
            await params.marketplaceListings.updateListingPrice(row.listing_id, {
              priceAmount: price,
              feeQuoteFingerprint: retryFingerprint,
            });
          }
        } else {
          if (!row.inventory_item_id) {
            throw new Error("Recommendation is missing an inventory target.");
          }
          if (!row.quantity_cap) {
            throw new Error("Recommendation is missing a draft quantity cap.");
          }
          const created = await params.marketplaceListings.createListing({
            inventoryItemId: row.inventory_item_id,
            priceAmount: price,
            quantityCap: row.quantity_cap,
          });
          appliedListingId = created.id ?? created.listing_id ?? row.inventory_item_id;
        }

        await commandHandler({
          streamId: `pricing.recommendation-${row.recommendation_id}`,
          command: {
            type: "MarkRecommendationApplied",
            appliedListingId: appliedListingId ?? row.recommendation_id,
            appliedAt: new Date().toISOString(),
          },
          context,
        });
        appliedCount += 1;
      } catch (error) {
        await commandHandler({
          streamId: `pricing.recommendation-${row.recommendation_id}`,
          command: {
            type: "MarkRecommendationFailed",
            errorMessage: error instanceof Error ? error.message : "Recommendation apply failed.",
            failedAt: new Date().toISOString(),
          },
          context,
        });
        failedCount += 1;
      }
    }

    return { appliedCount, failedCount };
  };

  const dismissRecommendations: PricingRecommendationServices["dismissRecommendations"] = async (params, context) => {
    const rows = await listAccountRecommendationsByIds(deps.db, {
      accountId: params.accountId,
      recommendationIds: params.recommendationIds,
    });
    let dismissedCount = 0;

    for (const row of rows.filter(isSelectedProposedRecommendation)) {
      await commandHandler({
        streamId: `pricing.recommendation-${row.recommendation_id}`,
        command: {
          type: "DismissRecommendation",
          dismissedAt: new Date().toISOString(),
        },
        context,
      });
      dismissedCount += 1;
    }

    return { dismissedCount };
  };

  return {
    commandHandler,
    captureMarketSnapshot: async (params, context) => {
      const result = await commandHandler({
        streamId: `pricing.recommendation-${params.recommendationId}`,
        command: {
          type: "RecordMarketPriceSnapshot",
          recommendationId: params.recommendationId,
          catalogItemId: params.catalogItemId,
          sellerAccountId: params.accountId,
          marketPriceAmount: params.marketPriceAmount,
          marketCurrency: params.marketCurrency,
          observedAt: params.observedAt ?? new Date().toISOString(),
        },
        context,
      });

      return { recommendationId: params.recommendationId, version: result.version };
    },
    publishRecommendation: async (params, context) => {
      const current = await getAccountRecommendation(deps.db, params.recommendationId, params.accountId);
      if (!current) {
        throw new Error("Recommendation not found.");
      }

      const result = await commandHandler({
        streamId: `pricing.recommendation-${params.recommendationId}`,
        command: {
          type: "PublishRecommendation",
          recommendedListAmount: params.recommendedListAmount,
          reason: params.reason,
          publishedAt: params.publishedAt ?? new Date().toISOString(),
        },
        context,
      });

      return { recommendationId: params.recommendationId, version: result.version };
    },
    refreshRecommendations: async (params, context) => {
      const candidates = await listRefreshCandidates(deps.db, params.accountId);
      const observedAt = new Date().toISOString();
      let proposedCount = 0;

      for (const candidate of candidates) {
        const recommendation = recommendedAmount(candidate);
        const currentPriceAmount = moneyNumber(candidate.currentPriceAmount);
        if (!recommendation) {
          continue;
        }
        if (currentPriceAmount !== null && currentPriceAmount === recommendation.recommendedListAmount) {
          continue;
        }

        const recommendationId = recommendationIdFor(candidate);
        await commandHandler({
          streamId: `pricing.recommendation-${recommendationId}`,
          command: {
            type: "ProposeRecommendation",
            recommendationId,
            catalogItemId: candidate.catalogItemId,
            sellerAccountId: candidate.sellerAccountId,
            actionType: candidate.actionType,
            listingId: candidate.listingId,
            inventoryItemId: candidate.inventoryItemId,
            marketPriceAmount: recommendation.marketPriceAmount,
            marketCurrency: "USD",
            marketSignalType: recommendation.marketSignalType,
            currentPriceAmount,
            recommendedListAmount: recommendation.recommendedListAmount,
            reason: recommendation.reason,
            quantityCap: candidate.quantityCap,
            observedAt,
          },
          context,
        });
        proposedCount += 1;
      }

      return { proposedCount };
    },
    applyRecommendations: async (params, context) => {
      const rows = await listAccountRecommendationsByIds(deps.db, {
        accountId: params.accountId,
        recommendationIds: params.recommendationIds,
      });
      let appliedCount = 0;
      let failedCount = 0;

      for (const row of rows.filter(isSelectedProposedRecommendation)) {
        try {
          const priceAmount = row.recommended_list_amount;
          if (priceAmount === null) {
            throw new Error("Recommendation is missing a recommended price.");
          }
          const price = moneyString(Number(priceAmount));
          let appliedListingId = row.listing_id;

          if (row.action_type === "active-listing-price-update" || row.action_type === "draft-listing-price-update") {
            if (!row.listing_id) {
              throw new Error("Recommendation is missing a listing target.");
            }
            const quote = await params.marketplaceListings.previewListingTerms({
              priceAmount: price,
            });
            try {
              await params.marketplaceListings.updateListingPrice(row.listing_id, {
                priceAmount: price,
                feeQuoteFingerprint: quote.fee_quote_fingerprint,
              });
            } catch (error) {
              const retryFingerprint = params.marketplaceListings.staleFeeQuoteFingerprint?.(error);
              if (!retryFingerprint) {
                throw error;
              }
              await params.marketplaceListings.updateListingPrice(row.listing_id, {
                priceAmount: price,
                feeQuoteFingerprint: retryFingerprint,
              });
            }
          } else {
            if (!row.inventory_item_id) {
              throw new Error("Recommendation is missing an inventory target.");
            }
            if (!row.quantity_cap) {
              throw new Error("Recommendation is missing a draft quantity cap.");
            }
            const created = await params.marketplaceListings.createListing({
              inventoryItemId: row.inventory_item_id,
              priceAmount: price,
              quantityCap: row.quantity_cap,
            });
            appliedListingId = created.id ?? created.listing_id ?? row.inventory_item_id;
          }

          await commandHandler({
            streamId: `pricing.recommendation-${row.recommendation_id}`,
            command: {
              type: "MarkRecommendationApplied",
              appliedListingId: appliedListingId ?? row.recommendation_id,
              appliedAt: new Date().toISOString(),
            },
            context,
          });
          appliedCount += 1;
        } catch (error) {
          await commandHandler({
            streamId: `pricing.recommendation-${row.recommendation_id}`,
            command: {
              type: "MarkRecommendationFailed",
              errorMessage: error instanceof Error ? error.message : "Recommendation apply failed.",
              failedAt: new Date().toISOString(),
            },
            context,
          });
          failedCount += 1;
        }
      }

      return { appliedCount, failedCount };
    },
    dismissRecommendations: async (params, context) => {
      const rows = await listAccountRecommendationsByIds(deps.db, {
        accountId: params.accountId,
        recommendationIds: params.recommendationIds,
      });
      let dismissedCount = 0;

      for (const row of rows.filter(isSelectedProposedRecommendation)) {
        await commandHandler({
          streamId: `pricing.recommendation-${row.recommendation_id}`,
          command: {
            type: "DismissRecommendation",
            dismissedAt: new Date().toISOString(),
          },
          context,
        });
        dismissedCount += 1;
      }

      return { dismissedCount };
    },
    enqueueRecommendationJob: (params, context) =>
      jobStore.enqueue({
        jobId: createPricingRecommendationJobId(),
        jobKind: params.action,
        payload: {
          action: params.action,
          accountId: params.accountId,
          recommendationIds: params.recommendationIds ?? [],
        },
        progress: pricingJobProgress("queued", 0, params.recommendationIds?.length ?? 0, "Recommendation job queued."),
        eventContext: context,
      }),
    getRecommendationJob: (jobId) => jobStore.get(jobId),
    listRecommendationJobEvents: (jobId, afterSequence = 0) => jobStore.listEvents(jobId, afterSequence),
    processNextRecommendationJob: async (input) => {
      const claimed = await jobStore.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        jobKinds: ["refresh", "apply", "dismiss"],
      });
      if (!claimed) {
        return 0;
      }

      try {
        input.throwIfLeaseLost?.();
        if (input.signal?.aborted) {
          throw new Error("Pricing recommendation job was cancelled.");
        }
        if (!claimed.eventContext) {
          throw new Error("Pricing recommendation job is missing event context.");
        }

        await jobStore.updateProgress({
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          progress: pricingJobProgress(
            "processing",
            0,
            claimed.payload.recommendationIds.length,
            "Processing recommendation job.",
          ),
        });

        const result =
          claimed.payload.action === "refresh"
            ? await (async () => {
                const refreshed = await refreshRecommendations(
                  { accountId: claimed.payload.accountId },
                  claimed.eventContext!,
                );
                return { proposedCount: refreshed.proposedCount };
              })()
            : claimed.payload.action === "apply"
              ? await applyRecommendations(
                  {
                    accountId: claimed.payload.accountId,
                    recommendationIds: claimed.payload.recommendationIds,
                    marketplaceListings: input.marketplaceListingGatewayForAccount(claimed.payload.accountId),
                  },
                  claimed.eventContext,
                )
              : await dismissRecommendations(
                  {
                    accountId: claimed.payload.accountId,
                    recommendationIds: claimed.payload.recommendationIds,
                  },
                  claimed.eventContext,
                );

        await jobStore.complete({
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          progress: pricingJobProgress(
            "completed",
            claimed.payload.recommendationIds.length,
            claimed.payload.recommendationIds.length,
            "Recommendation job completed.",
          ),
          result,
        });
        return 1;
      } catch (error) {
        await jobStore.fail({
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          progress: {
            ...claimed.progress,
            phase: "failed",
            message: error instanceof Error ? error.message : "Pricing recommendation job failed.",
          },
          errorMessage: error instanceof Error ? error.message : "Pricing recommendation job failed.",
        });
        return 1;
      }
    },
    listAccountRecommendations: (params) => listAccountRecommendations(deps.db, params),
    getAccountRecommendation: (recommendationId, accountId) =>
      getAccountRecommendation(deps.db, recommendationId, accountId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "pricing-recommendation-projection",
        handlers: buildPricingRecommendationProjectionHandlers(deps.db),
      }),
    ],
  };
}

function pricingJobProgress(
  phase: PricingRecommendationJobProgress["phase"],
  completed: number,
  total: number,
  message: string | null,
): PricingRecommendationJobProgress {
  return { phase, completed, total, message };
}

function createPricingRecommendationJobId(): string {
  const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return `job_${cryptoLike?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}
