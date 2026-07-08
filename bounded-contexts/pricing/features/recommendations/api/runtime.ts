import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createDurableJobExecutionContext,
  createDurableJobProgressCheckpoint,
  createPostgresDurableJobStore,
  isDurableJobHandoffError,
  runDurableJobSideEffect,
  type DurableJobEvent,
  type DurableJobExecutionContext,
  type DurableJobPublicSnapshot,
  type DurableJobRecord,
  toDurableJobPublicSnapshot,
} from "@chase-sets/platform-runtime/durable-job-store";
import {
  createPostgresDurableJobWorkUnitStore,
  isDurableJobWorkUnitTerminalAccepted,
  type DurableJobWorkUnitRecord,
  type DurableJobWorkUnitSummary,
  type DurableJobWorkUnitTerminalOutcome,
} from "@chase-sets/platform-runtime/durable-job-work-units";
import {
  getAccountRecommendation,
  explainAccountPricingSignals,
  listAccountRecommendations,
  listAccountRecommendationsByIds,
  recommendAccountPrice,
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
  previewListingTerms: (
    body: Readonly<{ priceAmount: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<{ fee_quote_fingerprint: string }>;
  updateListingPrice: (
    listingId: string,
    body: Readonly<{ priceAmount: string; feeQuoteFingerprint?: string | null }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<unknown>;
  createListing: (
    body: Readonly<{
      inventoryItemId: string;
      priceAmount: string;
      quantityCap: number;
      listingIdOverride?: string;
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
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

type PricingRecommendationWorkUnitPayload = Readonly<{
  recommendationId: string;
}>;

type PricingRecommendationWorkUnitResult = Readonly<{
  recommendationId: string;
  status: "dismissed" | "skipped" | "failed";
  message: string | null;
}>;

export type PricingRecommendationJob = DurableJobRecord<
  PricingRecommendationJobPayload,
  PricingRecommendationJobProgress,
  PricingRecommendationJobResult
>;

export type PricingRecommendationJobStatus = DurableJobPublicSnapshot<
  PricingRecommendationJobProgress,
  PricingRecommendationJobResult
>;

export type PricingRecommendationCommandSnapshot = Readonly<{
  recommendationId: string;
  accountId: string;
  status: PricingRecommendationState["status"];
  recommendedListAmount: number | null;
  recommendationReason: string | null;
  publishedAt: string | null;
  version: number;
}>;

export function toPricingRecommendationJobStatus(job: PricingRecommendationJob): PricingRecommendationJobStatus {
  return toDurableJobPublicSnapshot(job);
}

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
  ) => Promise<PricingRecommendationCommandSnapshot>;
  listAccountRecommendations: (
    params: Parameters<typeof listAccountRecommendations>[1],
  ) => ReturnType<typeof listAccountRecommendations>;
  getAccountRecommendation: (
    recommendationId: string,
    accountId: string,
  ) => ReturnType<typeof getAccountRecommendation>;
  recommendAccountPrice: (
    params: Parameters<typeof recommendAccountPrice>[1],
  ) => ReturnType<typeof recommendAccountPrice>;
  explainAccountPricingSignals: (
    params: Parameters<typeof explainAccountPricingSignals>[1],
  ) => ReturnType<typeof explainAccountPricingSignals>;
  refreshRecommendations: (
    params: Readonly<{ accountId: string }>,
    context: EventStoreContext,
    jobContext?: DurableJobExecutionContext<PricingRecommendationJobProgress, PricingRecommendationJobResult>,
  ) => Promise<{ proposedCount: number }>;
  applyRecommendations: (
    params: Readonly<{
      accountId: string;
      recommendationIds: readonly string[];
      marketplaceListings: PricingMarketplaceListingGateway;
    }>,
    context: EventStoreContext,
    jobContext?: DurableJobExecutionContext<PricingRecommendationJobProgress, PricingRecommendationJobResult>,
  ) => Promise<{ appliedCount: number; failedCount: number }>;
  dismissRecommendations: (
    params: Readonly<{ accountId: string; recommendationIds: readonly string[] }>,
    context: EventStoreContext,
    jobContext?: DurableJobExecutionContext<PricingRecommendationJobProgress, PricingRecommendationJobResult>,
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
  waitForRecommendationJobEvents: (jobId: string, signal?: AbortSignal) => Promise<void>;
  pruneRecommendationJobRetention: (input?: { completedBefore?: string | Date; limit?: number }) => Promise<number>;
  processNextRecommendationJob: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    workflowMaxActiveClaims?: number;
    jobMaxActiveClaims?: number;
    laneName?: string | null;
    marketplaceListingGatewayForAccount: (accountId: string) => PricingMarketplaceListingGateway;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }) => Promise<number>;
  getRecommendationWorkUnitSummary: (input?: { jobId?: string | null }) => Promise<DurableJobWorkUnitSummary>;
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
  const workUnitStore = createPostgresDurableJobWorkUnitStore<
    PricingRecommendationJobPayload,
    PricingRecommendationJobProgress,
    PricingRecommendationJobResult,
    PricingRecommendationWorkUnitPayload,
    PricingRecommendationWorkUnitResult
  >(
    deps.db,
    {
      jobsTable: "pricing_recommendation_jobs",
      eventsTable: "pricing_recommendation_job_events",
      workUnitsTable: "pricing_recommendation_work_units",
    },
    {
      workflowName: "pricing.recommendations",
    },
  );
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<PricingRecommendationEvent>(),
    initialState: () => initialPricingRecommendationState,
    evolve: evolvePricingRecommendation,
    decide: decidePricingRecommendation,
  });

  const refreshRecommendations: PricingRecommendationServices["refreshRecommendations"] = async (
    params,
    context,
    jobContext,
  ) => {
    const candidates = await listRefreshCandidates(deps.db, params.accountId);
    const progressCheckpoint = jobContext ? createPricingJobProgressCheckpoint(jobContext) : null;
    const observedAt = new Date().toISOString();
    let proposedCount = 0;
    let completed = 0;

    for (const candidate of candidates) {
      jobContext?.throwIfCancelled();
      const recommendation = recommendedAmount(candidate);
      const currentPriceAmount = moneyNumber(candidate.currentPriceAmount);
      if (!recommendation) {
        completed += 1;
        await progressCheckpoint?.checkpoint(
          pricingJobProgress("processing", completed, candidates.length, "Checked recommendation candidate."),
          { proposedCount },
        );
        continue;
      }
      if (currentPriceAmount !== null && currentPriceAmount === recommendation.recommendedListAmount) {
        completed += 1;
        await progressCheckpoint?.checkpoint(
          pricingJobProgress("processing", completed, candidates.length, "Checked recommendation candidate."),
          { proposedCount },
        );
        continue;
      }

      const recommendationId = recommendationIdFor(candidate);
      await runPricingJobSideEffect(jobContext, () =>
        commandHandler({
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
        }),
      );
      proposedCount += 1;
      completed += 1;
      await progressCheckpoint?.checkpoint(
        pricingJobProgress("processing", completed, candidates.length, "Proposed recommendation."),
        { proposedCount },
      );
    }

    return { proposedCount };
  };

  const applyRecommendations: PricingRecommendationServices["applyRecommendations"] = async (
    params,
    context,
    jobContext,
  ) => {
    const rows = await listAccountRecommendationsByIds(deps.db, {
      accountId: params.accountId,
      recommendationIds: params.recommendationIds,
    });
    const selectedRows = rows.filter(isSelectedProposedRecommendation);
    const progressCheckpoint = jobContext ? createPricingJobProgressCheckpoint(jobContext) : null;
    let appliedCount = 0;
    let failedCount = 0;
    let completed = 0;

    for (const row of selectedRows) {
      jobContext?.throwIfCancelled();
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
          const listingId = row.listing_id;
          const quote = await runPricingJobSideEffect(jobContext, (signal) =>
            params.marketplaceListings.previewListingTerms(
              {
                priceAmount: price,
              },
              { signal },
            ),
          );
          try {
            await runPricingJobSideEffect(jobContext, (signal) =>
              params.marketplaceListings.updateListingPrice(
                listingId,
                {
                  priceAmount: price,
                  feeQuoteFingerprint: quote.fee_quote_fingerprint,
                },
                { signal },
              ),
            );
          } catch (error) {
            const retryFingerprint = params.marketplaceListings.staleFeeQuoteFingerprint?.(error);
            if (!retryFingerprint) {
              throw error;
            }
            await runPricingJobSideEffect(jobContext, (signal) =>
              params.marketplaceListings.updateListingPrice(
                listingId,
                {
                  priceAmount: price,
                  feeQuoteFingerprint: retryFingerprint,
                },
                { signal },
              ),
            );
          }
        } else {
          if (!row.inventory_item_id) {
            throw new Error("Recommendation is missing an inventory target.");
          }
          if (!row.quantity_cap) {
            throw new Error("Recommendation is missing a draft quantity cap.");
          }
          const inventoryItemId = row.inventory_item_id;
          const quantityCap = row.quantity_cap;
          const created = await runPricingJobSideEffect(jobContext, (signal) =>
            params.marketplaceListings.createListing(
              {
                inventoryItemId,
                priceAmount: price,
                quantityCap,
                listingIdOverride: listingIdForPricingRecommendation(row.recommendation_id),
              },
              { signal },
            ),
          );
          appliedListingId = created.id ?? created.listing_id ?? row.inventory_item_id;
        }

        await runPricingJobSideEffect(jobContext, () =>
          commandHandler({
            streamId: `pricing.recommendation-${row.recommendation_id}`,
            command: {
              type: "MarkRecommendationApplied",
              appliedListingId: appliedListingId ?? row.recommendation_id,
              appliedAt: new Date().toISOString(),
            },
            context,
          }),
        );
        appliedCount += 1;
      } catch (error) {
        if (isPricingRecommendationJobHandoff(error, jobContext)) {
          throw error;
        }

        await runPricingJobSideEffect(jobContext, () =>
          commandHandler({
            streamId: `pricing.recommendation-${row.recommendation_id}`,
            command: {
              type: "MarkRecommendationFailed",
              errorMessage: error instanceof Error ? error.message : "Recommendation apply failed.",
              failedAt: new Date().toISOString(),
            },
            context,
          }),
        );
        failedCount += 1;
      }
      completed += 1;
      await progressCheckpoint?.checkpoint(
        pricingJobProgress("processing", completed, selectedRows.length, "Applied recommendation."),
        { appliedCount, failedCount },
      );
    }

    return { appliedCount, failedCount };
  };

  const dismissRecommendations: PricingRecommendationServices["dismissRecommendations"] = async (
    params,
    context,
    jobContext,
  ) => {
    const rows = await listAccountRecommendationsByIds(deps.db, {
      accountId: params.accountId,
      recommendationIds: params.recommendationIds,
    });
    const selectedRows = rows.filter(isSelectedProposedRecommendation);
    const progressCheckpoint = jobContext ? createPricingJobProgressCheckpoint(jobContext) : null;
    let dismissedCount = 0;
    let completed = 0;

    for (const row of selectedRows) {
      jobContext?.throwIfCancelled();
      await runPricingJobSideEffect(jobContext, () =>
        commandHandler({
          streamId: `pricing.recommendation-${row.recommendation_id}`,
          command: {
            type: "DismissRecommendation",
            dismissedAt: new Date().toISOString(),
          },
          context,
        }),
      );
      dismissedCount += 1;
      completed += 1;
      await progressCheckpoint?.checkpoint(
        pricingJobProgress("processing", completed, selectedRows.length, "Dismissed recommendation."),
        { dismissedCount },
      );
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

      return pricingRecommendationCommandSnapshot(result.state, result.version);
    },
    refreshRecommendations,
    applyRecommendations,
    dismissRecommendations,
    enqueueRecommendationJob: async (params, context) => {
      const recommendationIds = uniqueRecommendationIds(params.recommendationIds ?? []);
      if ((params.action === "apply" || params.action === "dismiss") && recommendationIds.length === 0) {
        throw new Error("Recommendation job requires at least one recommendation.");
      }
      const job = await jobStore.enqueue({
        jobId: createPricingRecommendationJobId(),
        jobKind: params.action,
        payload: {
          action: params.action,
          accountId: params.accountId,
          recommendationIds,
        },
        progress: pricingJobProgress("queued", 0, recommendationIds.length, "Recommendation job queued."),
        eventContext: context,
      });
      if (params.action === "dismiss") {
        await workUnitStore.enqueue({
          jobId: job.jobId,
          units: recommendationIds.map((recommendationId) => ({
            unitId: recommendationId,
            unitKind: "dismiss",
            payload: { recommendationId },
          })),
        });
      }
      return job;
    },
    getRecommendationJob: (jobId) => jobStore.get(jobId),
    listRecommendationJobEvents: (jobId, afterSequence = 0) => jobStore.listEvents(jobId, afterSequence),
    waitForRecommendationJobEvents: (jobId, signal) => jobStore.waitForEvents({ jobId, signal }),
    pruneRecommendationJobRetention: (input = {}) =>
      jobStore.pruneTerminalJobs({
        completedBefore: input.completedBefore ?? recommendationRetentionCutoff(7),
        limit: input.limit,
      }),
    processNextRecommendationJob: async (input) => {
      const processedDismissUnit = await processNextDismissWorkUnit(input);
      if (processedDismissUnit > 0) {
        return processedDismissUnit;
      }

      const claimed = await jobStore.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        jobKinds: ["refresh", "apply"],
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

        await requirePricingRecommendationJobClaim(
          jobStore.updateProgress({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            claimTtlMs: input.claimTtlMs,
            progress: pricingJobProgress(
              "processing",
              0,
              claimed.payload.recommendationIds.length,
              "Processing recommendation job.",
            ),
          }),
        );
        const jobContext = createDurableJobExecutionContext(jobStore, {
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
          signal: input.signal,
          throwIfLeaseLost: input.throwIfLeaseLost,
          cancelledMessage: "Pricing recommendation job was cancelled.",
          claimLostMessage: "Pricing recommendation job claim was lost before the status update completed.",
        });

        const result =
          claimed.payload.action === "refresh"
            ? await (async () => {
                const refreshed = await refreshRecommendations(
                  { accountId: claimed.payload.accountId },
                  claimed.eventContext!,
                  jobContext,
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
                  jobContext,
                )
              : await dismissRecommendations(
                  {
                    accountId: claimed.payload.accountId,
                    recommendationIds: claimed.payload.recommendationIds,
                  },
                  claimed.eventContext,
                  jobContext,
                );

        await requirePricingRecommendationJobClaim(
          jobStore.complete({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: pricingJobProgress(
              "completed",
              claimed.payload.recommendationIds.length,
              claimed.payload.recommendationIds.length,
              "Recommendation job completed.",
            ),
            result,
          }),
        );
        return 1;
      } catch (error) {
        if (isPricingRecommendationJobHandoff(error, input)) {
          return 0;
        }
        await requirePricingRecommendationJobClaim(
          jobStore.fail({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: {
              ...claimed.progress,
              phase: "failed",
              message: error instanceof Error ? error.message : "Pricing recommendation job failed.",
            },
            errorMessage: error instanceof Error ? error.message : "Pricing recommendation job failed.",
          }),
        );
        return 1;
      }
    },
    listAccountRecommendations: (params) => listAccountRecommendations(deps.db, params),
    getAccountRecommendation: (recommendationId, accountId) =>
      getAccountRecommendation(deps.db, recommendationId, accountId),
    recommendAccountPrice: (params) => recommendAccountPrice(deps.db, params),
    explainAccountPricingSignals: (params) => explainAccountPricingSignals(deps.db, params),
    getRecommendationWorkUnitSummary: (input = {}) => workUnitStore.summarize(input),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "pricing-recommendation-projection",
        handlers: buildPricingRecommendationProjectionHandlers(deps.db),
      }),
    ],
  };

  async function processNextDismissWorkUnit(input: {
    claimOwnerId: string;
    claimTtlMs: number;
    workflowMaxActiveClaims?: number;
    jobMaxActiveClaims?: number;
    laneName?: string | null;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }): Promise<number> {
    const claimResult = await workUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: input.workflowMaxActiveClaims ?? 1,
      jobMaxActiveClaims: input.jobMaxActiveClaims ?? 1,
      jobKinds: ["dismiss"],
      laneName: input.laneName ?? null,
    });
    const claim = claimResult.claim;
    if (!claim) {
      return 0;
    }

    try {
      input.throwIfLeaseLost?.();
      if (input.signal?.aborted) {
        throw new Error("Pricing recommendation job was cancelled.");
      }
      if (!claim.job.eventContext) {
        throw new Error("Pricing recommendation job is missing event context.");
      }
      const result = await dismissRecommendations(
        {
          accountId: claim.job.payload.accountId,
          recommendationIds: [claim.unit.payload.recommendationId],
        },
        claim.job.eventContext,
      );
      const outcome: PricingRecommendationWorkUnitResult = {
        recommendationId: claim.unit.payload.recommendationId,
        status: result.dismissedCount > 0 ? "dismissed" : "skipped",
        message: null,
      };
      await requirePricingRecommendationJobClaim(
        workUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: outcome.status === "dismissed" ? "completed" : "skipped",
          unitResult: outcome,
          parentProgress: claim.job.progress,
          parentResult: claim.job.result,
          resolveParentUpdate: (queryable) => pricingDismissParentUpdateFromWorkUnits(queryable, claim.job),
        }),
      );
      return 1;
    } catch (error) {
      if (isPricingRecommendationJobHandoff(error, input)) {
        await workUnitStore.releaseClaim({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
        });
        return 0;
      }
      await requirePricingRecommendationJobClaim(
        workUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: "failed",
          unitResult: {
            recommendationId: claim.unit.payload.recommendationId,
            status: "failed",
            message: error instanceof Error ? error.message : "Recommendation dismiss failed.",
          },
          errorMessage: error instanceof Error ? error.message : "Recommendation dismiss failed.",
          parentProgress: claim.job.progress,
          parentResult: claim.job.result,
          resolveParentUpdate: (queryable) => pricingDismissParentUpdateFromWorkUnits(queryable, claim.job),
        }),
      );
      return 1;
    }
  }

  async function pricingDismissParentUpdateFromWorkUnits(
    queryable: PgQueryable,
    job: PricingRecommendationJob,
  ): Promise<
    Readonly<{
      parentProgress: PricingRecommendationJobProgress;
      parentResult: PricingRecommendationJobResult;
      completeJob: boolean;
    }>
  > {
    const units = await listPricingRecommendationWorkUnitsForJob(queryable, job.jobId);
    const terminalUnits = units.filter(
      (unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped",
    );
    const outcomes = terminalUnits.flatMap((unit) => (unit.result ? [unit.result] : []));
    const total = Math.max(job.progress.total, units.length, outcomes.length);
    const completeJob = total > 0 && terminalUnits.length >= total;
    const dismissedCount = outcomes.filter((outcome) => outcome.status === "dismissed").length;
    return {
      parentProgress: pricingJobProgress(
        completeJob ? "completed" : "processing",
        terminalUnits.length,
        total,
        completeJob ? "Recommendation job completed." : "Dismissed recommendation.",
      ),
      parentResult: { dismissedCount },
      completeJob,
    };
  }
}

function pricingJobProgress(
  phase: PricingRecommendationJobProgress["phase"],
  completed: number,
  total: number,
  message: string | null,
): PricingRecommendationJobProgress {
  return { phase, completed, total, message };
}

async function runPricingJobSideEffect<T>(
  jobContext: DurableJobExecutionContext<PricingRecommendationJobProgress, PricingRecommendationJobResult> | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return runDurableJobSideEffect(jobContext, work, {
    renewIntervalMs: 5_000,
    claimLostMessage: "Pricing recommendation job claim was lost while applying a side effect.",
  });
}

function createPricingJobProgressCheckpoint(
  jobContext: DurableJobExecutionContext<PricingRecommendationJobProgress, PricingRecommendationJobResult>,
) {
  return createDurableJobProgressCheckpoint(jobContext, {
    minIntervalMs: 1_000,
    minCompletedDelta: 10,
    minRenewIntervalMs: 5_000,
    completed: (progress) => progress.completed,
    isTerminal: (progress) => progress.phase === "completed" || progress.phase === "failed",
  });
}

function pricingRecommendationCommandSnapshot(
  state: PricingRecommendationState,
  version: number,
): PricingRecommendationCommandSnapshot {
  if (!state.recommendationId || !state.sellerAccountId) {
    throw new Error("Recommendation command did not produce a publishable snapshot.");
  }

  return {
    recommendationId: state.recommendationId,
    accountId: state.sellerAccountId,
    status: state.status,
    recommendedListAmount: state.recommendedListAmount,
    recommendationReason: state.recommendationReason,
    publishedAt: state.publishedAt,
    version,
  };
}

function listingIdForPricingRecommendation(recommendationId: string): string {
  return `lst_pricing_${recommendationId.replace(/[^A-Za-z0-9_]+/g, "_")}`;
}

function createPricingRecommendationJobId(): string {
  const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return `job_${cryptoLike?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

async function listPricingRecommendationWorkUnitsForJob(
  queryable: PgQueryable,
  jobId: string,
): Promise<
  readonly DurableJobWorkUnitRecord<PricingRecommendationWorkUnitPayload, PricingRecommendationWorkUnitResult>[]
> {
  const result = await queryable.query<{
    unit_id: string;
    unit_kind: string;
    state: "queued" | "running" | "completed" | "failed" | "skipped";
    payload: unknown;
    result: unknown;
    error_message: string | null;
    claim_owner_id: string | null;
    claim_token: string | null;
    claimed_until: Date | string | null;
    attempt_count: number | string;
    created_at: Date | string;
    updated_at: Date | string;
    completed_at: Date | string | null;
  }>(
    `SELECT unit_id,
            unit_kind,
            state,
            payload,
            result,
            error_message,
            claim_owner_id,
            claim_token,
            claimed_until,
            attempt_count,
            created_at,
            updated_at,
            completed_at
     FROM pricing_recommendation_work_units
     WHERE job_id = $1
     ORDER BY created_at ASC, unit_id ASC`,
    [jobId],
  );
  return result.rows.map((row) => ({
    jobId,
    unitId: row.unit_id,
    unitKind: row.unit_kind,
    state: row.state,
    payload: readJsonValue(row.payload),
    result: row.result == null ? null : readJsonValue(row.result),
    errorMessage: row.error_message,
    claimOwnerId: row.claim_owner_id,
    claimToken: row.claim_token,
    claimedUntil: row.claimed_until == null ? null : formatTimestamp(row.claimed_until),
    attemptCount: Number(row.attempt_count),
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at),
    completedAt: row.completed_at == null ? null : formatTimestamp(row.completed_at),
  }));
}

function uniqueRecommendationIds(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function readJsonValue<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function recommendationRetentionCutoff(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

async function requirePricingRecommendationJobClaim(
  succeeded: Promise<boolean | DurableJobWorkUnitTerminalOutcome> | boolean | DurableJobWorkUnitTerminalOutcome,
) {
  const outcome = await succeeded;
  if (!isDurableJobWorkUnitTerminalAccepted(outcome)) {
    throw new Error("Pricing recommendation job claim was lost before the status update completed.");
  }
}

function isPricingRecommendationJobHandoff(error: unknown, input?: { signal?: AbortSignal }) {
  return isDurableJobHandoffError(error, input);
}
