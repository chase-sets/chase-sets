import type { SellListReviewSelections, SellListReviewReadiness } from "./review-plan-contracts";
import { buildSellListReviewPlan, readinessDecisionsFromReviewPlan } from "./review-plan";
import { createSellListReviewPlans, staleSellListReview } from "./review-plan-store";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CommandReceiptMetadata } from "@chase-sets/http/responses";
import { computeCheckoutCommandAttemptRequestHash } from "../../command-attempts/api/contracts";
import { createCheckoutSellListAttemptExecutor } from "../../command-attempts/api/sell-list-attempt";
import type { CheckoutCommandAttemptResult } from "../../command-attempts/api/contracts";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutSellerCheckoutOwners } from "../../../api";
import type { SellerCheckoutChoices } from "../domain/owner-reads";
import { createSellListHandoffPreparations, type SellListHandoffPreparation } from "./handoff-preparation";
import {
  readSellerCheckoutOwners,
  sellerCheckoutEstimate,
  sellerCheckoutEvidence,
  sellerCheckoutOwner,
  realTimestamp,
} from "../read-model/seller-checkout-owner-reads";
import {
  listCheckoutShipFromAddresses,
  type CheckoutShipFromAddressRow,
} from "../../cart/integrations/identity/identity-queries";
import type { SellListLineId } from "../../../support/runtime-support/common";
import {
  CheckoutDomainError,
  createCheckoutProductDescriptor,
  type CheckoutVersionSchema,
} from "../../../support/runtime-support/common";
import {
  decideCheckoutSellList,
  evolveCheckoutSellList,
  initialCheckoutSellListState,
  type CheckoutSellListLine,
  type CheckoutSellListCommand,
  type CheckoutSellListEvent,
  type CheckoutSellListState,
  type SellListConfirmationSummary,
  type SellListSellerConfirmationEvidence,
} from "../domain/domain";
import {
  createSellListReadinessSnapshot,
  validateSellListReadinessSnapshot,
  type SellListReadinessDecisionInput,
  type SellListReadinessSnapshot,
} from "../domain/readiness";
import { buildCheckoutSellListProjectionHandlers } from "../read-model/projection";
import {
  getLatestSellListConfirmation,
  getSellListConfirmation,
  getCheckoutListingEvidenceCoverage,
  getSellPayoutReadiness,
  getCheckoutSellOfferMatch,
  listSellListLines,
  listSellListReadinessLines,
  loadCheckoutGuestSellListOfferReviews,
  loadCheckoutSellListCompositeReview,
  type CheckoutCommercialTermsResolver,
  type CheckoutOfferAcceptanceTermsSource,
  type CheckoutSellListConfirmationRow,
  type CheckoutSellListLineRow,
  type CheckoutSellPayoutReadinessRow,
} from "../read-model/queries";

function ownedLineFromProjection(line: CheckoutSellListLineRow): CheckoutSellListLine {
  return {
    lineId: line.line_id as SellListLineId,
    sellerAccountId: line.seller_account_id as AccountId,
    lineType: line.line_type,
    offerId: line.offer_id,
    listingId: line.listing_id,
    buyerAccountId: line.buyer_account_id,
    buyerDisplayName: line.buyer_display_name,
    offerPriceAmount: line.offer_price_amount,
    offerPriceCurrencyCode: line.offer_price_currency_code ?? null,
    offerStreamVersion: line.offer_stream_version ?? null,
    listingPriceAmount: line.listing_price_amount ?? null,
    listingPriceCurrencyCode: line.listing_price_currency_code ?? null,
    listingStreamVersion: line.listing_stream_version ?? null,
    catalogItemId: line.catalog_catalog_item_id,
    productId: line.product_id,
    itemTitle: line.item_title,
    itemSubtitle: line.item_subtitle,
    selectedOptions: line.selected_options,
    productSummary: line.product_summary,
    quantity: line.quantity,
    fallbackMode: line.fallback_mode,
    minimumListingPriceAmount: line.minimum_listing_price_amount,
  };
}

function isIdempotentMergeReplay(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("Sell list line has already been added.") ||
      error.message.includes("Sell list line not found.") ||
      error.message.includes("Sell list has not been initialized."))
  );
}

function buildReadinessConfirmationEvidence(snapshot: SellListReadinessSnapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    sourceRevision: snapshot.sourceRevision,
    includedLineIds: snapshot.includedLineIds,
    lineOutcomes: snapshot.lineOutcomes
      .filter((outcome) => snapshot.includedLineIds.includes(outcome.lineId))
      .map((outcome) => ({ lineId: outcome.lineId, action: outcome.action })),
  };
}

function assertSellerEvidenceReady(evidence: SellListSellerConfirmationEvidence) {
  if (
    evidence.shipFrom.status !== "ready" ||
    evidence.payout.status !== "ready" ||
    evidence.label.status !== "ready" ||
    evidence.risk.status !== "clear" ||
    evidence.provider.status !== "ready" ||
    evidence.freshness.status !== "current"
  ) {
    throw new CheckoutDomainError("Seller confirmation evidence must be ready before Sell List checkout can confirm.");
  }
  if (!evidence.shipFrom.country || !evidence.shipFrom.region || !evidence.shipFrom.postalCode) {
    throw new CheckoutDomainError("Seller confirmation evidence must include ship-from serviceability facts.");
  }
  if (evidence.payout.readinessStatus !== "ready") {
    throw new CheckoutDomainError("Seller confirmation evidence must include payout readiness facts.");
  }
}

function buildConfirmationRow(
  params: Parameters<CheckoutSellListServices["confirmSellListCheckout"]>[0],
  confirmedAt: string,
  readinessEvidence: ReturnType<typeof buildReadinessConfirmationEvidence>,
): CheckoutSellListConfirmationRow {
  return {
    seller_account_id: params.sellerAccountId,
    confirmation_id: params.confirmationId,
    confirmed_at: confirmedAt,
    readiness_evidence: readinessEvidence,
    seller_evidence: params.sellerEvidence,
    handoff_summary: params.handoffSummary,
  };
}

function commandReceiptFromStoredEvent(
  storedEvent: Readonly<{ globalPosition: string; eventId: string }> | null | undefined,
): CommandReceiptMetadata | null {
  return storedEvent
    ? {
        mode: "eventual",
        commitPosition: storedEvent.globalPosition,
        commitEventIds: [storedEvent.eventId],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: storedEvent.globalPosition,
            eventIds: [storedEvent.eventId],
          },
        ],
      }
    : null;
}

export type AddCheckoutSellListLineInput = Readonly<{
  attemptId: string;
  requestHash: string;
  sellerAccountId: AccountId;
  lineType: "selected-offer" | "product";
  offerId?: string | null;
  listingId?: string | null;
  buyerAccountId?: string | null;
  buyerDisplayName?: string | null;
  offerPriceAmount?: string | null;
  offerPriceCurrencyCode?: string | null;
  offerStreamVersion?: number | null;
  listingPriceAmount?: string | null;
  listingPriceCurrencyCode?: string | null;
  listingStreamVersion?: number | null;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  quantity: number;
  fallbackMode?: "none" | "create-listing";
  minimumListingPriceAmount?: string | null;
}>;

export type CheckoutSellListRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  commercialTermsResolver?: CheckoutCommercialTermsResolver;
  offerAcceptanceTermsSource?: CheckoutOfferAcceptanceTermsSource;
  sellerCheckoutOwners?: CheckoutSellerCheckoutOwners;
}>;

export type CheckoutSellListServices = Readonly<{
  executeSellListAttempt: ReturnType<typeof createCheckoutSellListAttemptExecutor>["executeSellListAttempt"];
  lookupSellListAttempt: ReturnType<typeof createCheckoutSellListAttemptExecutor>["lookupSellListAttempt"];
  commandHandler: CommandHandler<CheckoutSellListCommand, CheckoutSellListState, CheckoutSellListEvent>;
  addLine: (
    params: AddCheckoutSellListLineInput & { newLineLimit?: number },
    context: EventStoreContext,
  ) => Promise<{
    lineId: SellListLineId;
    version: number;
    status: "added" | "merged";
    attempt: CheckoutCommandAttemptResult;
    commandReceipt?: CommandReceiptMetadata | null;
  }>;
  removeLine: (
    params: Readonly<{ sellerAccountId: AccountId; lineId: SellListLineId; attemptId: string; requestHash: string }>,
    context: EventStoreContext,
  ) => Promise<{ lineId: SellListLineId; version: number; attempt: CheckoutCommandAttemptResult }>;
  confirmSellListCheckout: (
    params: Readonly<{
      sellerAccountId: AccountId;
      confirmationId: string;
      completedLineIds?: readonly SellListLineId[] | null;
      remainingLineQuantities?: readonly { lineId: SellListLineId; quantity: number }[] | null;
      readinessSnapshotId: string;
      readinessSourceRevision: string;
      readinessDecisions?: SellListReadinessDecisionInput | null;
      sellerEvidence: SellListSellerConfirmationEvidence;
      shipFrom?: SellerCheckoutChoices["shipFrom"];
      label?: SellerCheckoutChoices["label"];
      handoffSummary: Readonly<{
        acceptedOfferCount: number;
        publishedListingCount: number;
        skippedLineCount: number;
        skippedReasons: readonly string[];
        lineOutcomes?: readonly {
          lineId: SellListLineId;
          itemTitle: string;
          status: "completed" | "partial" | "skipped";
          action: "accepted-offer" | "accepted-smart-match" | "published-listing" | "mixed" | "kept-in-sell-list";
          quantity: number;
          remainingQuantity: number;
          detail: string;
          references?: Readonly<{
            offerIds?: readonly string[];
            listingId?: string | null;
          }>;
        }[];
        sideEffects: SellListConfirmationSummary["sideEffects"];
      }>;
    }>,
    context: EventStoreContext,
  ) => Promise<{
    sellerAccountId: AccountId;
    version: number;
    status: "confirmed";
    confirmation: CheckoutSellListConfirmationRow;
    completedLineIds: readonly SellListLineId[];
  }>;
  mergeSellListIntoAccount: (
    params: Readonly<{
      sourceOwnerId: string;
      targetAccountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ mergedLineCount: number; commandReceipt?: CommandReceiptMetadata | null }>;
  createReadinessSnapshot: (
    params: Readonly<{
      sellerAccountId: string;
      decisions?: SellListReadinessDecisionInput | null;
      sellerEvidence?: SellListSellerConfirmationEvidence | null;
      shipFrom?: SellerCheckoutChoices["shipFrom"];
      label?: SellerCheckoutChoices["label"];
      confirmationId?: string;
      entryReadinessSnapshotId?: string;
      entryReadinessSourceRevision?: string;
    }>,
    context?: EventStoreContext,
  ) => Promise<SellListReadinessSnapshot>;
  createReviewReadiness: (
    params: Readonly<{ sellerAccountId: string; selections: SellListReviewSelections }>,
    context: EventStoreContext,
  ) => Promise<SellListReviewReadiness>;
  getReviewReadiness: (
    params: Readonly<{ sellerAccountId: string; snapshotId: string; sourceRevision: string; confirmationId?: string }>,
  ) => Promise<SellListReviewReadiness>;
  listLines: (sellerAccountId: string) => ReturnType<typeof listSellListLines>;
  getLatestConfirmation: (sellerAccountId: string) => ReturnType<typeof getLatestSellListConfirmation>;
  getConfirmation: (sellerAccountId: string, confirmationId: string) => ReturnType<typeof getSellListConfirmation>;
  getPayoutReadiness: (sellerAccountId: string) => Promise<CheckoutSellPayoutReadinessRow>;
  listShipFromAddresses: (sellerAccountId: string) => Promise<readonly CheckoutShipFromAddressRow[]>;
  getOfferMatch: (sellerAccountId: string, offerId: string) => ReturnType<typeof getCheckoutSellOfferMatch>;
  loadCompositeReview: (
    sellerAccountId: string,
    options?: Readonly<{ includeStandardComparison?: boolean }>,
  ) => ReturnType<typeof loadCheckoutSellListCompositeReview>;
  loadGuestOfferReviews: (
    ownerId: string,
  ) => Promise<Awaited<ReturnType<typeof loadCheckoutGuestSellListOfferReviews>>>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createCheckoutSellListRuntime(deps: CheckoutSellListRuntimeDeps): CheckoutSellListServices {
  const commercialTermsResolver = deps.commercialTermsResolver ?? createNoopCheckoutCommercialTermsResolver();
  const codec = createPassthroughDomainEventCodec<CheckoutSellListEvent>();
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec,
    initialState: () => initialCheckoutSellListState,
    evolve: evolveCheckoutSellList,
    decide: decideCheckoutSellList,
  });
  const sellListProjector = createProjectionHandlerSet({
    projectionName: "checkout.sell-list-projection",
    handlers: buildCheckoutSellListProjectionHandlers(deps.db),
  });
  const preparations = createSellListHandoffPreparations(deps.eventStore);
  const reviewPlans = createSellListReviewPlans(deps.eventStore);

  async function assessSeller(
    params: Readonly<{ sellerAccountId: string; decisions?: SellListReadinessDecisionInput | null }> &
      SellerCheckoutChoices,
    moment: "readiness" | "pre-confirm",
    confirmationId: string | null = null,
    preparation?: SellListHandoffPreparation | null,
  ) {
    const lines = await listSellListReadinessLines(deps.db, params.sellerAccountId);
    const lineSnapshot = createSellListReadinessSnapshot(lines, params.decisions);
    const reads = await readSellerCheckoutOwners({
      ownerId: params.sellerAccountId,
      choices: params,
      ports: deps.sellerCheckoutOwners,
      addresses: () => listCheckoutShipFromAddresses(deps.db, params.sellerAccountId),
    });
    const [payout, review] = await Promise.all([
      getSellPayoutReadiness(deps.db, params.sellerAccountId).catch(() => null),
      preparation
        ? Promise.resolve(preparation.review)
        : deps.commercialTermsResolver
          ? loadCheckoutSellListCompositeReview(deps.db, deps.commercialTermsResolver, {
              sellerAccountId: params.sellerAccountId,
              lines,
              offerAcceptanceTermsSource: deps.offerAcceptanceTermsSource,
            }).catch(() => null)
          : Promise.resolve(null),
    ]);
    const currentReview =
      preparation && review
        ? {
            ...review,
            productOfferReviews: await Promise.all(
              review.productOfferReviews.map(async (item) => ({
                ...item,
                offers: await Promise.all(
                  item.offers.map(async (target) => ({
                    ...target,
                    evidence: await getCheckoutListingEvidenceCoverage(deps.db, target.offer.listing_id),
                  })),
                ),
              })),
            ),
          }
        : review;
    const estimate = preparation?.estimate ?? sellerCheckoutEstimate(lines, currentReview, lineSnapshot);
    const ownerReads = {
      moment,
      confirmationId,
      owner: reads.owner,
      risk: reads.risk,
      origin: reads.origin,
      fulfillment: reads.fulfillment,
      estimate,
      lineRevision: lineSnapshot.sourceRevision,
      lineTimestamps: lines.map((line) => line.updated_at),
    };
    const sellerEvidence = {
      ...sellerCheckoutEvidence({ reads, payout, estimate, lines, review: currentReview, lineSnapshot }),
      ownerReads,
    };
    const snapshot = { ...createSellListReadinessSnapshot(lines, params.decisions, sellerEvidence), ownerReads };
    return { lines, sellerEvidence, snapshot, review: currentReview, estimate };
  }

  async function getCatalogItemSnapshot(catalogItemId: string) {
    const result = await deps.db.query<{
      catalog_item_id: string;
      status: string;
      product_schema: unknown;
    }>(
      `SELECT catalog_item_id, status, product_schema
       FROM checkout_catalog_items
       WHERE catalog_item_id = $1`,
      [catalogItemId],
    );

    return result.rows[0] ?? null;
  }

  async function normalizeInput(params: Omit<AddCheckoutSellListLineInput, "attemptId" | "requestHash">) {
    const catalogItem = await getCatalogItemSnapshot(params.catalogItemId);
    if (!catalogItem) {
      throw new CheckoutDomainError("Catalog item not found.");
    }

    if (catalogItem.status !== "active") {
      throw new CheckoutDomainError("Sell list lines may only reference active catalog items.");
    }

    const product = createCheckoutProductDescriptor({
      catalogItemId: params.catalogItemId,
      productSchema:
        typeof catalogItem.product_schema === "object" && catalogItem.product_schema !== null
          ? (catalogItem.product_schema as CheckoutVersionSchema)
          : null,
      selection: params.selectedOptions,
    });

    if (params.productId.trim() !== product.productId) {
      throw new CheckoutDomainError("Sell list product id does not match the selected options.");
    }

    return {
      ...params,
      offerId: params.offerId ?? null,
      listingId: params.listingId ?? null,
      buyerAccountId: params.buyerAccountId ?? null,
      buyerDisplayName: params.buyerDisplayName ?? null,
      offerPriceAmount: params.offerPriceAmount ?? null,
      offerPriceCurrencyCode: params.offerPriceCurrencyCode ?? null,
      offerStreamVersion: params.offerStreamVersion ?? null,
      listingPriceAmount: params.listingPriceAmount ?? null,
      listingPriceCurrencyCode: params.listingPriceCurrencyCode ?? null,
      listingStreamVersion: params.listingStreamVersion ?? null,
      productId: product.productId,
      selectedOptions: product.selection,
      itemSubtitle: params.itemSubtitle ?? null,
      productSummary: params.productSummary ?? null,
      fallbackMode: params.fallbackMode ?? "none",
      minimumListingPriceAmount: params.minimumListingPriceAmount ?? null,
    };
  }

  function sellListStreamId(sellerAccountId: string) {
    return `checkout.sell-list-${sellerAccountId}`;
  }

  async function listAggregateSellListLines(sellerAccountId: string): Promise<readonly CheckoutSellListLine[]> {
    const aggregate = await repository.load(sellListStreamId(sellerAccountId));
    return aggregate.state.lines;
  }

  async function pruneProjectedSellListLines(sellerAccountId: string, lineIds: readonly string[]) {
    if (lineIds.length === 0) {
      return;
    }

    await deps.db.query(
      `DELETE FROM checkout_sell_list_line_pages
       WHERE seller_account_id = $1
         AND line_id = ANY($2::text[])`,
      [sellerAccountId, [...lineIds]],
    );
  }

  const attempts = createCheckoutSellListAttemptExecutor({
    eventStore: deps.eventStore,
    load: (id) => repository.load(id),
    normalize: normalizeInput,
  });
  async function readConfirmation(sellerAccountId: string, confirmationId: string, requestHash?: string) {
    const aggregate = await repository.load(sellListStreamId(sellerAccountId));
    const events = aggregate.storedEvents.filter(
      (event) =>
        event.eventType === "checkout.sell-list.checkout-confirmed" &&
        (event.payload as { confirmationId?: unknown }).confirmationId === confirmationId,
    );
    if (!events.length) return null;
    const event = events[0]!;
    const data = event.payload as Extract<
      CheckoutSellListEvent,
      { type: "checkout.sell-list.checkout-confirmed" }
    >["data"];
    const { resultHash, ...retainedResult } = data;
    if (
      data.requestHash &&
      (resultHash !== (await computeCheckoutCommandAttemptRequestHash(retainedResult)) ||
        !/^[a-f0-9]{64}$/.test(data.requestHash))
    )
      throw new CheckoutDomainError("Sell List confirmation history is incomplete.", "checkout_confirmation_changed");
    if (
      events.length !== 1 ||
      data.sellerAccountId !== sellerAccountId ||
      !Array.isArray(data.completedLineIds) ||
      !Array.isArray(data.remainingLineQuantities) ||
      !data.readinessEvidence ||
      !data.sellerEvidence ||
      !data.handoffSummary ||
      !aggregate.state.confirmationIds.includes(confirmationId) ||
      (requestHash !== undefined && data.requestHash !== requestHash)
    ) {
      throw new CheckoutDomainError("Sell List confirmation changed.", "checkout_confirmation_changed");
    }
    try {
      const before = aggregate.storedEvents
        .filter((stored) => stored.streamVersion < event.streamVersion)
        .reduce((state, stored) => evolveCheckoutSellList(state, codec.decode(stored)), initialCheckoutSellListState);
      if (before.sellerAccountId !== sellerAccountId) throw new Error("Foreign seller history.");
      const decided = decideCheckoutSellList(before, { ...data, type: "ConfirmSellListCheckout" });
      if (
        (await computeCheckoutCommandAttemptRequestHash(decided[0]!.data)) !==
        (await computeCheckoutCommandAttemptRequestHash(data))
      )
        throw new Error("Invalid confirmation state.");
      assertSellerEvidenceReady(data.sellerEvidence);
      if (!realTimestamp(data.confirmedAt)) throw new Error("Invalid confirmation time.");
    } catch {
      throw new CheckoutDomainError("Sell List confirmation history is incomplete.", "checkout_confirmation_changed");
    }
    return {
      sellerAccountId: sellerAccountId as AccountId,
      version: event.streamVersion,
      status: "confirmed" as const,
      confirmation: {
        seller_account_id: sellerAccountId,
        confirmation_id: confirmationId,
        confirmed_at: data.confirmedAt,
        readiness_evidence: data.readinessEvidence,
        seller_evidence: data.sellerEvidence,
        handoff_summary: data.handoffSummary,
      },
      completedLineIds: data.completedLineIds,
    };
  }
  function attemptLineResult(attempt: CheckoutCommandAttemptResult) {
    if (attempt.ownerStatus !== "committed" || attempt.vector?.[0]?.outcome !== "succeeded") {
      throw new CheckoutDomainError(
        attempt.vector?.[0]?.message ?? "Sell List attempt could not be applied.",
        attempt.ownerStatus === "conflict" ? "checkout_attempt_conflict" : "checkout_attempt_unresolved",
      );
    }
    return attempt.vector[0];
  }
  const addLine: CheckoutSellListServices["addLine"] = async (params, context) => {
    const { attemptId, requestHash, newLineLimit, ...line } = params;
    const attempt = await attempts.executeSellListAttempt(
      {
        ownerKey: params.sellerAccountId,
        attemptId,
        requestHash,
        kind: "sell-list-line",
        target: "sell-list",
        commands: [{ type: "add", line }],
        newLineLimit,
      },
      context,
    );
    const result = attemptLineResult(attempt);
    return {
      lineId: result.lineId as SellListLineId,
      version: result.version,
      status: result.status as "added" | "merged",
      attempt,
      commandReceipt: commandReceiptFromStoredEvent(
        attempt.commitReceipt
          ? { eventId: attempt.commitReceipt.eventId, globalPosition: attempt.commitReceipt.globalPosition }
          : null,
      ),
    };
  };

  return {
    ...attempts,
    commandHandler,
    addLine,
    removeLine: async (params, context) => {
      const prior = await attempts.lookupSellListAttempt({
        ownerKey: params.sellerAccountId,
        attemptId: params.attemptId,
        requestHash: params.requestHash,
        kind: "sell-list-line",
        target: params.lineId,
      });
      const missing =
        prior.ownerStatus === "not-observed" &&
        !(await repository.load(sellListStreamId(params.sellerAccountId))).state.lines.some(
          (line) => line.lineId === params.lineId,
        );
      const attempt = await attempts.executeSellListAttempt(
        {
          ownerKey: params.sellerAccountId,
          attemptId: params.attemptId,
          requestHash: params.requestHash,
          kind: "sell-list-line",
          target: params.lineId,
          commands: [{ type: "remove", lineId: params.lineId }],
        },
        context,
      );
      const result = attemptLineResult(attempt);
      if (missing) await pruneProjectedSellListLines(params.sellerAccountId, [params.lineId]);
      return { lineId: params.lineId, version: result.version, attempt };
    },
    confirmSellListCheckout: async (params, context) => {
      const requestHash = await computeCheckoutCommandAttemptRequestHash(params);
      const existingConfirmation = await readConfirmation(params.sellerAccountId, params.confirmationId, requestHash);
      if (existingConfirmation) return existingConfirmation;
      const aggregate = await repository.load(sellListStreamId(params.sellerAccountId));
      const preparation = await preparations.read(params.sellerAccountId, params.confirmationId);
      if (
        preparation &&
        (preparation.sellListVersion !== aggregate.version ||
          preparation.decisionsHash !==
            (await computeCheckoutCommandAttemptRequestHash(params.readinessDecisions ?? {})))
      )
        throw new CheckoutDomainError("Sell List confirmation changed.", "checkout_confirmation_changed");

      const assessed = await assessSeller(
        {
          sellerAccountId: params.sellerAccountId,
          decisions: params.readinessDecisions,
          shipFrom: params.shipFrom,
          label: params.label,
        },
        "pre-confirm",
        params.confirmationId,
        preparation,
      );
      params = { ...params, sellerEvidence: assessed.sellerEvidence };
      const currentLines = assessed.lines;
      const readiness = validateSellListReadinessSnapshot(currentLines, {
        snapshotId: params.readinessSnapshotId,
        sourceRevision: params.readinessSourceRevision,
        decisions: params.readinessDecisions,
        sellerEvidence: params.sellerEvidence,
      });
      if (!readiness.valid) {
        throw new CheckoutDomainError("Sell List readiness snapshot is stale.");
      }
      if (readiness.current.status !== "ready" || readiness.current.unresolvedLineIds.length > 0) {
        throw new CheckoutDomainError("Sell List readiness must be resolved before seller checkout starts.");
      }
      if (readiness.current.includedLineIds.length === 0) {
        throw new CheckoutDomainError("Sell List readiness must include at least one checkout line.");
      }
      assertSellerEvidenceReady(params.sellerEvidence);
      const readinessLineIds = new Set(readiness.current.includedLineIds);
      const requestedCompletedLineIds =
        params.completedLineIds && params.completedLineIds.length > 0
          ? params.completedLineIds
          : (readiness.current.includedLineIds as readonly SellListLineId[]);
      const completedLineIds = [...new Set(requestedCompletedLineIds)].filter((lineId) =>
        readiness.current.includedLineIds.includes(lineId),
      );
      const remainingLineQuantities = (params.remainingLineQuantities ?? []).filter((entry) =>
        readinessLineIds.has(entry.lineId),
      );
      const readinessEvidence = buildReadinessConfirmationEvidence(readiness.current);
      const confirmedAt = new Date().toISOString();
      const confirmation = buildConfirmationRow(params, confirmedAt, readinessEvidence);
      const resultHash = await computeCheckoutCommandAttemptRequestHash({
        sellerAccountId: params.sellerAccountId,
        confirmationId: params.confirmationId,
        confirmedAt,
        completedLineIds,
        remainingLineQuantities,
        readinessEvidence,
        sellerEvidence: params.sellerEvidence,
        handoffSummary: params.handoffSummary,
        requestHash,
      });

      let version = 0;
      try {
        const result = await commandHandler({
          streamId: `checkout.sell-list-${params.sellerAccountId}`,
          command: {
            type: "ConfirmSellListCheckout",
            requestHash,
            resultHash,
            confirmationId: params.confirmationId,
            confirmedAt,
            completedLineIds,
            remainingLineQuantities,
            readinessEvidence,
            sellerEvidence: params.sellerEvidence,
            handoffSummary: params.handoffSummary,
          },
          context,
          expectedVersion: aggregate.version || "no_stream",
        });
        version = result.version;
      } catch (error) {
        const winner = await readConfirmation(params.sellerAccountId, params.confirmationId, requestHash);
        if (winner) return winner;
        throw error;
      }

      return {
        sellerAccountId: params.sellerAccountId,
        version,
        status: "confirmed",
        confirmation,
        completedLineIds,
      };
    },
    getLatestConfirmation: (sellerAccountId) => getLatestSellListConfirmation(deps.db, sellerAccountId),
    getConfirmation: async (sellerAccountId, confirmationId) =>
      (await readConfirmation(sellerAccountId, confirmationId))?.confirmation ?? null,
    getPayoutReadiness: (sellerAccountId) => getSellPayoutReadiness(deps.db, sellerAccountId),
    listShipFromAddresses: (sellerAccountId) => listCheckoutShipFromAddresses(deps.db, sellerAccountId),
    getOfferMatch: (sellerAccountId, offerId) => getCheckoutSellOfferMatch(deps.db, sellerAccountId, offerId),
    loadCompositeReview: async (sellerAccountId, options = {}) => {
      const lines = await listSellListLines(deps.db, sellerAccountId);
      return loadCheckoutSellListCompositeReview(deps.db, commercialTermsResolver, {
        sellerAccountId,
        lines,
        includeStandardComparison: options.includeStandardComparison,
        offerAcceptanceTermsSource: deps.offerAcceptanceTermsSource,
      });
    },
    loadGuestOfferReviews: async (ownerId) => {
      const lines = await listSellListLines(deps.db, ownerId);
      return loadCheckoutGuestSellListOfferReviews(commercialTermsResolver, lines);
    },
    mergeSellListIntoAccount: async (params, context) => {
      const owner = sellerCheckoutOwner(params.sourceOwnerId);
      if (owner?.kind !== "anonymous" || !deps.sellerCheckoutOwners) {
        throw new CheckoutDomainError("Anonymous seller checkout authority cannot be invalidated.");
      }
      const invalidated = await deps.sellerCheckoutOwners.invalidateAnonymousOwner(
        { owner, targetAccountId: params.targetAccountId },
        context,
      );
      if (
        !invalidated ||
        !Number.isSafeInteger(invalidated.revision) ||
        invalidated.revision < 1 ||
        !realTimestamp(invalidated.recordedAt)
      ) {
        throw new CheckoutDomainError("Anonymous seller checkout authority cannot be invalidated.");
      }
      const sourceLines = await listAggregateSellListLines(params.sourceOwnerId);
      let targetAggregate = await repository.load(sellListStreamId(params.targetAccountId));
      const existingTargetLineIds = new Set(targetAggregate.state.lines.map((line) => line.lineId));
      for (const line of sourceLines) {
        if (existingTargetLineIds.has(line.lineId)) {
          continue;
        }

        try {
          await commandHandler({
            streamId: `checkout.sell-list-${params.targetAccountId}`,
            command: {
              type: "AddSellListLine",
              sellerAccountId: params.targetAccountId,
              lineId: line.lineId,
              lineType: line.lineType,
              offerId: line.offerId,
              listingId: line.listingId,
              buyerAccountId: line.buyerAccountId,
              buyerDisplayName: line.buyerDisplayName,
              offerPriceAmount: line.offerPriceAmount,
              offerPriceCurrencyCode: line.offerPriceCurrencyCode,
              offerStreamVersion: line.offerStreamVersion,
              listingPriceAmount: line.listingPriceAmount,
              listingPriceCurrencyCode: line.listingPriceCurrencyCode,
              listingStreamVersion: line.listingStreamVersion,
              catalogItemId: line.catalogItemId,
              productId: line.productId,
              itemTitle: line.itemTitle,
              itemSubtitle: line.itemSubtitle,
              selectedOptions: line.selectedOptions,
              productSummary: line.productSummary,
              quantity: line.quantity,
              fallbackMode: line.fallbackMode,
              minimumListingPriceAmount: line.minimumListingPriceAmount,
            },
            context,
          });
        } catch (error) {
          if (!isIdempotentMergeReplay(error)) {
            throw error;
          }
        }
        existingTargetLineIds.add(line.lineId);
      }

      let commandReceipt: CommandReceiptMetadata | null = null;
      if (sourceLines.length > 0) {
        targetAggregate = await repository.load(sellListStreamId(params.targetAccountId));
        const sourceLineIds = new Set(sourceLines.map((line) => line.lineId));
        const storedEvent = targetAggregate.storedEvents.find(
          (event) =>
            event.eventType === "checkout.sell-list.line-added" &&
            typeof event.payload === "object" &&
            event.payload !== null &&
            sourceLineIds.has((event.payload as { lineId?: unknown }).lineId as SellListLineId),
        );
        commandReceipt = commandReceiptFromStoredEvent(storedEvent);
      }

      if (sourceLines.length > 0) {
        for (const line of sourceLines) {
          try {
            await commandHandler({
              streamId: `checkout.sell-list-${params.sourceOwnerId}`,
              command: {
                type: "RemoveSellListLine",
                lineId: line.lineId,
              },
              context,
            });
          } catch (error) {
            if (!isIdempotentMergeReplay(error)) {
              throw error;
            }
          }
        }
      }

      return {
        mergedLineCount: sourceLines.length,
        ...(commandReceipt ? { commandReceipt } : {}),
      };
    },
    createReviewReadiness: async (params, context) => {
      const lines = await listSellListReadinessLines(deps.db, params.sellerAccountId);
      const reviewPlan = await buildSellListReviewPlan(
        (offerId) => getCheckoutSellOfferMatch(deps.db, params.sellerAccountId, offerId),
        lines,
        params.selections,
      );
      const decisions = readinessDecisionsFromReviewPlan(reviewPlan);
      const assessed = await assessSeller({ sellerAccountId: params.sellerAccountId, decisions }, "readiness");
      if (createSellListReadinessSnapshot(lines, decisions).sourceRevision !== assessed.snapshot.sourceRevision)
        throw staleSellListReview();
      const snapshotId = "slrp_" + await computeCheckoutCommandAttemptRequestHash({
        sellerAccountId: params.sellerAccountId, readiness: assessed.snapshot, reviewPlan,
      });
      const stored = await reviewPlans.save({
        sellerAccountId: params.sellerAccountId,
        assessedSnapshotId: assessed.snapshot.snapshotId,
        readiness: { ...assessed.snapshot, snapshotId },
        reviewPlan,
        decisions,
      }, context);
      return { readiness: stored.readiness, reviewPlan: stored.reviewPlan, decisions: stored.decisions };
    },
    getReviewReadiness: async (params) => {
      const stored = await reviewPlans.read(params.sellerAccountId, params.snapshotId);
      if (stored.readiness.sourceRevision !== params.sourceRevision) throw staleSellListReview();
      const preparation = params.confirmationId
        ? await preparations.read(params.sellerAccountId, params.confirmationId) : null;
      if (preparation) {
        const aggregate = await repository.load(sellListStreamId(params.sellerAccountId));
        if (preparation.sellListVersion !== aggregate.version ||
          preparation.entry.snapshotId !== params.snapshotId ||
          preparation.entry.sourceRevision !== params.sourceRevision ||
          await computeCheckoutCommandAttemptRequestHash(preparation.reviewPlan) !==
            await computeCheckoutCommandAttemptRequestHash(stored.reviewPlan)) throw staleSellListReview();
      } else {
        const assessed = await assessSeller({ sellerAccountId: params.sellerAccountId, decisions: stored.decisions }, "readiness");
        if (assessed.snapshot.snapshotId !== stored.assessedSnapshotId ||
          assessed.snapshot.sourceRevision !== params.sourceRevision) throw staleSellListReview();
      }
      return { readiness: stored.readiness, reviewPlan: stored.reviewPlan, decisions: stored.decisions };
    },
    createReadinessSnapshot: async (params, context) => {
      if (params.confirmationId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(params.confirmationId))
        throw new CheckoutDomainError("A bounded Sell List confirmation id is required.");
      const preparation = params.confirmationId
        ? await preparations.read(params.sellerAccountId, params.confirmationId)
        : null;
      const storedReview = params.entryReadinessSnapshotId
        ? await reviewPlans.read(params.sellerAccountId, params.entryReadinessSnapshotId) : null;
      if (storedReview) {
        if (storedReview.readiness.sourceRevision !== params.entryReadinessSourceRevision) throw staleSellListReview();
        params = { ...params, decisions: storedReview.decisions };
      }
      const decisionsHash = await computeCheckoutCommandAttemptRequestHash(params.decisions ?? {});
      const requestHash = await computeCheckoutCommandAttemptRequestHash({
        decisions: params.decisions ?? {},
        shipFrom: params.shipFrom,
        label: params.label,
        entryReadinessSnapshotId: params.entryReadinessSnapshotId,
        entryReadinessSourceRevision: params.entryReadinessSourceRevision,
      });
      const aggregate = params.confirmationId ? await repository.load(sellListStreamId(params.sellerAccountId)) : null;
      if (
        preparation &&
        (preparation.sellListVersion !== aggregate?.version || preparation.decisionsHash !== decisionsHash)
      )
        throw new CheckoutDomainError("Sell List confirmation changed.", "checkout_confirmation_changed");
      if (preparation && !params.entryReadinessSnapshotId) return preparation.entry;
      const assessed = await assessSeller(params, "readiness", params.confirmationId ?? null, preparation);
      if (preparation) {
        if (
          preparation.requestHash !== requestHash ||
          preparation.readiness.snapshotId !== assessed.snapshot.snapshotId
        )
          throw new CheckoutDomainError("Sell List confirmation changed.", "checkout_confirmation_changed");
        return preparation.readiness;
      }
      if (params.confirmationId && params.entryReadinessSnapshotId) {
        const byId = (left: CheckoutSellListLine, right: CheckoutSellListLine) =>
          left.lineId.localeCompare(right.lineId);
        if (
          (await computeCheckoutCommandAttemptRequestHash([...aggregate!.state.lines].sort(byId))) !==
          (await computeCheckoutCommandAttemptRequestHash(assessed.lines.map(ownedLineFromProjection).sort(byId)))
        )
          throw new CheckoutDomainError("Sell List confirmation changed.", "checkout_confirmation_changed");
        const currentEntry = (
          await assessSeller({ sellerAccountId: params.sellerAccountId, decisions: params.decisions }, "readiness")
        ).snapshot;
        if (!storedReview || currentEntry.snapshotId !== storedReview.assessedSnapshotId) throw staleSellListReview();
        if (
          !context ||
          assessed.snapshot.status !== "ready" ||
          assessed.snapshot.sellerReadiness.status !== "ready" ||
          !assessed.review
        )
          throw new CheckoutDomainError("Sell List readiness must be resolved before handoff.");
        return (
          await preparations.save(
            {
              sellerAccountId: params.sellerAccountId,
              confirmationId: params.confirmationId,
              sellListVersion: aggregate!.version,
              requestHash,
              decisionsHash,
              entry: storedReview!.readiness,
              reviewPlan: storedReview!.reviewPlan,
              readiness: assessed.snapshot,
              review: assessed.review,
              estimate: assessed.estimate,
            },
            context,
          )
        ).readiness;
      }
      return assessed.snapshot;
    },
    listLines: (sellerAccountId) => listSellListLines(deps.db, sellerAccountId),
    projectors: [sellListProjector],
  };
}

function createNoopCheckoutCommercialTermsResolver(): CheckoutCommercialTermsResolver {
  const quote = (amount: string) => ({
    accountType: "personal" as const,
    basisAmount: amount,
    marketplaceSalesFeeUnitAmount: "0.00",
    sellerNetUnitAmount: amount,
    shippingAllowancePercentageBps: 0,
    scheduleId: "terms_noop",
    agreementId: null,
    scheduleLabel: "No-op terms",
    scheduleUpdatedAt: new Date(0).toISOString(),
    resolvedAt: new Date(0).toISOString(),
  });

  return {
    resolveListingTerms: async ({ amount }) => quote(amount),
    resolvePublicStandardListingTerms: async ({ amount }) => ({
      ...quote(amount),
      scheduleId: "terms_noop",
    }),
  };
}
