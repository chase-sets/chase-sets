import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
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
  listSellListLines,
  type CheckoutSellListConfirmationRow,
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
    evidence.conditionReview.status !== "accepted" ||
    evidence.risk.status !== "clear" ||
    evidence.provider.status !== "ready" ||
    evidence.freshness.status !== "current"
  ) {
    throw new CheckoutDomainError("Seller confirmation evidence must be ready before Sell List checkout can confirm.");
  }
  if (!evidence.shipFrom.country || !evidence.shipFrom.region || !evidence.shipFrom.postalCode) {
    throw new CheckoutDomainError("Seller confirmation evidence must include ship-from serviceability facts.");
  }
  if (!evidence.payout.readinessStatus) {
    throw new CheckoutDomainError("Seller confirmation evidence must include payout readiness facts.");
  }
  if (!evidence.conditionReview.acceptedAt) {
    throw new CheckoutDomainError("Seller confirmation evidence must include condition review acceptance.");
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

export type AddCheckoutSellListLineInput = Readonly<{
  sellerAccountId: AccountId;
  lineType: "selected-offer" | "product";
  offerId?: string | null;
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
}>;

export type CheckoutSellListServices = Readonly<{
  commandHandler: CommandHandler<CheckoutSellListCommand, CheckoutSellListState, CheckoutSellListEvent>;
  addLine: (
    params: AddCheckoutSellListLineInput,
    context: EventStoreContext,
  ) => Promise<{ lineId: SellListLineId; version: number; status: "added" | "merged" }>;
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
  ) => Promise<{ mergedLineCount: number }>;
  createReadinessSnapshot: (
    params: Readonly<{
      sellerAccountId: string;
      decisions?: SellListReadinessDecisionInput | null;
    }>,
  ) => Promise<SellListReadinessSnapshot>;
  listLines: (sellerAccountId: string) => ReturnType<typeof listSellListLines>;
  getLatestConfirmation: (sellerAccountId: string) => ReturnType<typeof getLatestSellListConfirmation>;
  getConfirmation: (sellerAccountId: string, confirmationId: string) => ReturnType<typeof getSellListConfirmation>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createCheckoutSellListRuntime(deps: CheckoutSellListRuntimeDeps): CheckoutSellListServices {
  const { commandHandler } = createAggregateCommandHandler({
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

  const addLine: CheckoutSellListServices["addLine"] = async (params, context) => {
    const normalized = await normalizeInput(params);
    const existingLine = (await listSellListLines(deps.db, params.sellerAccountId)).find((line) =>
      normalized.lineType === "selected-offer" && normalized.offerId
        ? line.offer_id === normalized.offerId
        : line.line_type === "product" &&
          line.product_id === normalized.productId &&
          line.fallback_mode === normalized.fallbackMode &&
          (line.minimum_listing_price_amount ?? null) === normalized.minimumListingPriceAmount,
    );

    if (existingLine) {
      if (existingLine.line_type === "product") {
        const result = await commandHandler({
          streamId: `checkout.sell-list-${params.sellerAccountId}`,
          command: {
            type: "SetSellListLineQuantity",
            lineId: existingLine.line_id as SellListLineId,
            quantity: existingLine.quantity + normalized.quantity,
          },
          context,
        });

        return { lineId: existingLine.line_id as SellListLineId, version: result.version, status: "merged" };
      }

      return { lineId: existingLine.line_id as SellListLineId, version: 0, status: "merged" };
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
      const result = await commandHandler({
        streamId: `checkout.sell-list-${params.sellerAccountId}`,
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
      const currentLines = await listSellListLines(deps.db, params.sellerAccountId);
      const readiness = validateSellListReadinessSnapshot(currentLines, {
        snapshotId: params.readinessSnapshotId,
        sourceRevision: params.readinessSourceRevision,
        decisions: params.readinessDecisions,
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
    mergeSellListIntoAccount: async (params, context) => {
      const sourceLines = await listSellListLines(deps.db, params.sourceOwnerId);
      const existingTargetLineIds = new Set(
        (await listSellListLines(deps.db, params.targetAccountId)).map((line) => line.line_id),
      );
      for (const line of sourceLines) {
        if (existingTargetLineIds.has(line.line_id)) {
          continue;
        }

        try {
          await commandHandler({
            streamId: `checkout.sell-list-${params.targetAccountId}`,
            command: {
              type: "AddSellListLine",
              sellerAccountId: params.targetAccountId,
              lineId: line.line_id as SellListLineId,
              lineType: line.line_type,
              offerId: line.offer_id,
              buyerAccountId: line.buyer_account_id,
              buyerDisplayName: line.buyer_display_name,
              offerPriceAmount: line.offer_price_amount,
              catalogItemId: line.catalog_catalog_item_id,
              productId: line.product_id,
              itemTitle: line.item_title,
              itemSubtitle: line.item_subtitle,
              selectedOptions: line.selected_options,
              productSummary: line.product_summary,
              quantity: line.quantity,
              fallbackMode: line.fallback_mode,
              minimumListingPriceAmount: line.minimum_listing_price_amount,
            },
            context,
          });
        } catch (error) {
          if (!isIdempotentMergeReplay(error)) {
            throw error;
          }
        }
      }

      if (sourceLines.length > 0) {
        for (const line of sourceLines) {
          try {
            await commandHandler({
              streamId: `checkout.sell-list-${params.sourceOwnerId}`,
              command: {
                type: "RemoveSellListLine",
                lineId: line.line_id as SellListLineId,
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

      return { mergedLineCount: sourceLines.length };
    },
    createReadinessSnapshot: async (params) => {
      const lines = await listSellListLines(deps.db, params.sellerAccountId);
      return createSellListReadinessSnapshot(lines, params.decisions);
    },
    listLines: (sellerAccountId) => listSellListLines(deps.db, sellerAccountId),
    projectors: [sellListProjector],
  };
}
