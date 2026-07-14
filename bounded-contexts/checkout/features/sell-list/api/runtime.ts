import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CommandReceiptMetadata } from "@chase-sets/http/responses";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
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
  getSellPayoutReadiness,
  getCheckoutSellOfferMatch,
  listSellListLines,
  listSellListReadinessLines,
  loadCheckoutGuestSellListOfferReviews,
  loadCheckoutSellListCompositeReview,
  type CheckoutCommercialTermsResolver,
  type CheckoutSellListConfirmationRow,
  type CheckoutSellListLineRow,
  type CheckoutSellPayoutReadinessRow,
} from "../read-model/queries";

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
  sellerAccountId: AccountId;
  lineType: "selected-offer" | "product";
  offerId?: string | null;
  listingId?: string | null;
  buyerAccountId?: string | null;
  buyerDisplayName?: string | null;
  offerPriceAmount?: string | null;
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
}>;

export type CheckoutSellListServices = Readonly<{
  commandHandler: CommandHandler<CheckoutSellListCommand, CheckoutSellListState, CheckoutSellListEvent>;
  addLine: (
    params: AddCheckoutSellListLineInput,
    context: EventStoreContext,
  ) => Promise<{
    lineId: SellListLineId;
    version: number;
    status: "added" | "merged";
    commandReceipt?: CommandReceiptMetadata | null;
  }>;
  removeLine: (
    params: Readonly<{ sellerAccountId: AccountId; lineId: SellListLineId }>,
    context: EventStoreContext,
  ) => Promise<{ lineId: SellListLineId; version: number }>;
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
    }>,
  ) => Promise<SellListReadinessSnapshot>;
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
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<CheckoutSellListEvent>(),
    initialState: () => initialCheckoutSellListState,
    evolve: evolveCheckoutSellList,
    decide: decideCheckoutSellList,
  });
  const sellListProjector = createProjectionHandlerSet({
    projectionName: "checkout.sell-list-projection",
    handlers: buildCheckoutSellListProjectionHandlers(deps.db),
  });

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

  async function normalizeInput(params: AddCheckoutSellListLineInput) {
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

  const addLine: CheckoutSellListServices["addLine"] = async (params, context) => {
    const normalized = await normalizeInput(params);
    const aggregate = await repository.load(sellListStreamId(params.sellerAccountId));
    const existingLineIndex = aggregate.state.lines.findIndex((line) =>
      normalized.lineType === "selected-offer" && normalized.offerId
        ? line.offerId === normalized.offerId
        : line.lineType === "product" &&
          line.productId === normalized.productId &&
          line.fallbackMode === normalized.fallbackMode &&
          (line.minimumListingPriceAmount ?? null) === normalized.minimumListingPriceAmount,
    );
    const existingLine = existingLineIndex >= 0 ? aggregate.state.lines[existingLineIndex] : null;

    if (existingLine) {
      if (existingLine.lineType === "product") {
        const result = await commandHandler({
          streamId: `checkout.sell-list-${params.sellerAccountId}`,
          command: {
            type: "SetSellListLineQuantity",
            lineId: existingLine.lineId,
            quantity: existingLine.quantity + normalized.quantity,
          },
          context,
        });

        return { lineId: existingLine.lineId, version: result.version, status: "merged" };
      }

      const storedEvent = aggregate.storedEvents.find(
        (event) =>
          event.eventType === "checkout.sell-list.line-added" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          (event.payload as { lineId?: unknown }).lineId === existingLine.lineId,
      );
      const commandReceipt = commandReceiptFromStoredEvent(storedEvent);

      return {
        lineId: existingLine.lineId,
        version: aggregate.version,
        status: "merged",
        ...(commandReceipt ? { commandReceipt } : {}),
      };
    }

    const lineId = createId("sll") as SellListLineId;
    const result = await commandHandler({
      streamId: `checkout.sell-list-${params.sellerAccountId}`,
      command: {
        type: "AddSellListLine",
        lineId,
        ...normalized,
      },
      context,
    });

    return { lineId, version: result.version, status: "added" };
  };

  return {
    commandHandler,
    addLine,
    removeLine: async (params, context) => {
      const aggregate = await repository.load(sellListStreamId(params.sellerAccountId));
      if (!aggregate.state.lines.some((line) => line.lineId === params.lineId)) {
        await pruneProjectedSellListLines(params.sellerAccountId, [params.lineId]);
        return { lineId: params.lineId, version: aggregate.version };
      }

      const result = await commandHandler({
        streamId: sellListStreamId(params.sellerAccountId),
        command: {
          type: "RemoveSellListLine",
          lineId: params.lineId,
        },
        context,
      });

      return { lineId: params.lineId, version: result.version };
    },
    confirmSellListCheckout: async (params, context) => {
      const existingConfirmation = await getSellListConfirmation(
        deps.db,
        params.sellerAccountId,
        params.confirmationId,
      );
      if (existingConfirmation) {
        return {
          sellerAccountId: params.sellerAccountId,
          version: 0,
          status: "confirmed",
          confirmation: existingConfirmation,
          completedLineIds: [],
        };
      }

      assertSellerEvidenceReady(params.sellerEvidence);
      const currentLines = await listSellListReadinessLines(deps.db, params.sellerAccountId);
      const readiness = validateSellListReadinessSnapshot(currentLines, {
        snapshotId: params.readinessSnapshotId,
        sourceRevision: params.readinessSourceRevision,
        decisions: params.readinessDecisions,
        sellerEvidence: params.sellerEvidence,
      });
      if (!readiness.valid) {
        throw new CheckoutDomainError("Sell List readiness snapshot is stale.");
      }
      if (readiness.current.sellerReadiness.status !== "ready") {
        throw new CheckoutDomainError(
          "Seller confirmation evidence must be ready before Sell List checkout can confirm.",
        );
      }
      if (readiness.current.status !== "ready" || readiness.current.unresolvedLineIds.length > 0) {
        throw new CheckoutDomainError("Sell List readiness must be resolved before seller checkout starts.");
      }
      if (readiness.current.includedLineIds.length === 0) {
        throw new CheckoutDomainError("Sell List readiness must include at least one checkout line.");
      }
      const readinessLineIds = new Set(readiness.current.includedLineIds);
      const requestedCompletedLineIds =
        params.completedLineIds && params.completedLineIds.length > 0
          ? params.completedLineIds
          : (readiness.current.includedLineIds as readonly SellListLineId[]);
      const completedLineIds = requestedCompletedLineIds.filter((lineId) =>
        readiness.current.includedLineIds.includes(lineId),
      );
      const remainingLineQuantities = (params.remainingLineQuantities ?? []).filter((entry) =>
        readinessLineIds.has(entry.lineId),
      );
      const readinessEvidence = buildReadinessConfirmationEvidence(readiness.current);
      const confirmedAt = new Date().toISOString();
      const confirmation = buildConfirmationRow(params, confirmedAt, readinessEvidence);

      let version = 0;
      try {
        const result = await commandHandler({
          streamId: `checkout.sell-list-${params.sellerAccountId}`,
          command: {
            type: "ConfirmSellListCheckout",
            confirmationId: params.confirmationId,
            confirmedAt,
            completedLineIds,
            remainingLineQuantities,
            readinessEvidence,
            sellerEvidence: params.sellerEvidence,
            handoffSummary: params.handoffSummary,
          },
          context,
        });
        version = result.version;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Sell List checkout is already confirmed.")) {
          throw error;
        }
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
    getConfirmation: (sellerAccountId, confirmationId) =>
      getSellListConfirmation(deps.db, sellerAccountId, confirmationId),
    getPayoutReadiness: (sellerAccountId) => getSellPayoutReadiness(deps.db, sellerAccountId),
    listShipFromAddresses: (sellerAccountId) => listCheckoutShipFromAddresses(deps.db, sellerAccountId),
    getOfferMatch: (sellerAccountId, offerId) => getCheckoutSellOfferMatch(deps.db, sellerAccountId, offerId),
    loadCompositeReview: async (sellerAccountId, options = {}) => {
      const lines = await listSellListLines(deps.db, sellerAccountId);
      return loadCheckoutSellListCompositeReview(deps.db, commercialTermsResolver, {
        sellerAccountId,
        lines,
        includeStandardComparison: options.includeStandardComparison,
      });
    },
    loadGuestOfferReviews: async (ownerId) => {
      const lines = await listSellListLines(deps.db, ownerId);
      return loadCheckoutGuestSellListOfferReviews(commercialTermsResolver, lines);
    },
    mergeSellListIntoAccount: async (params, context) => {
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
    createReadinessSnapshot: async (params) => {
      const lines = await listSellListReadinessLines(deps.db, params.sellerAccountId);
      return createSellListReadinessSnapshot(lines, params.decisions, params.sellerEvidence);
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
