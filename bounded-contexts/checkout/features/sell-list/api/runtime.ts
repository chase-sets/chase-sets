import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
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
} from "../domain/domain";
import { buildCheckoutSellListProjectionHandlers } from "../read-model/projection";
import {
  getSellListExecution,
  getSellListReceiptByExecutionId,
  getLatestSellListReceipt,
  listSellListLines,
  type CheckoutSellListExecutionRow,
} from "../read-model/queries";

function isIdempotentMergeReplay(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("Sell list line has already been added.") ||
      error.message.includes("Sell list must contain at least one line.") ||
      error.message.includes("Sell list has not been initialized."))
  );
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
  checkoutSellList: (
    params: Readonly<{
      sellerAccountId: AccountId;
      executionId: string;
      completedLineIds?: readonly SellListLineId[] | null;
      remainingLineQuantities?: readonly { lineId: SellListLineId; quantity: number }[] | null;
      executionSummary?: Readonly<{
        acceptedOfferCount: number;
        createdListingCount: number;
        skippedLineCount: number;
        skippedReasons: readonly string[];
        lineOutcomes?: readonly {
          lineId: SellListLineId;
          itemTitle: string;
          status: "completed" | "partial" | "skipped";
          action: "accepted-offer" | "accepted-smart-match" | "created-listing" | "mixed" | "kept-in-sell-list";
          quantity: number;
          remainingQuantity: number;
          detail: string;
        }[];
      }> | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{
    sellerAccountId: AccountId;
    version: number;
    status: "reviewed";
    completedLineIds: readonly SellListLineId[];
  }>;
  startSellListExecution: (
    params: Readonly<{
      sellerAccountId: AccountId;
      executionId: string;
      executionPlan: unknown;
    }>,
  ) => Promise<CheckoutSellListExecutionRow>;
  recordSellListExecutionProgress: (
    params: Readonly<{
      sellerAccountId: AccountId;
      executionId: string;
      completedActionKey: string;
    }>,
  ) => Promise<CheckoutSellListExecutionRow>;
  mergeSellListIntoAccount: (
    params: Readonly<{
      sourceOwnerId: string;
      targetAccountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ mergedLineCount: number }>;
  listLines: (sellerAccountId: string) => ReturnType<typeof listSellListLines>;
  getLatestReceipt: (sellerAccountId: string) => ReturnType<typeof getLatestSellListReceipt>;
  getReceiptByExecutionId: (
    sellerAccountId: string,
    executionId: string,
  ) => ReturnType<typeof getSellListReceiptByExecutionId>;
  getExecution: (sellerAccountId: string, executionId: string) => ReturnType<typeof getSellListExecution>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createCheckoutSellListRuntime(deps: CheckoutSellListRuntimeDeps): CheckoutSellListServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<CheckoutSellListEvent>(),
      initialState: () => initialCheckoutSellListState,
      evolve: evolveCheckoutSellList,
    }),
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
    checkoutSellList: async (params, context) => {
      const result = await commandHandler({
        streamId: `checkout.sell-list-${params.sellerAccountId}`,
        command: {
          type: "CheckoutSellList",
          executionId: params.executionId,
          checkedOutAt: new Date().toISOString(),
          completedLineIds: params.completedLineIds ?? null,
          remainingLineQuantities: params.remainingLineQuantities ?? null,
          executionSummary: params.executionSummary ?? null,
        },
        context,
      });

      await deps.db.query(
        `UPDATE checkout_sell_list_execution_pages
         SET status = 'finalized',
             execution_summary = $3::jsonb,
             finalized_at = now(),
             updated_at = now()
         WHERE seller_account_id = $1
           AND execution_id = $2`,
        [params.sellerAccountId, params.executionId, JSON.stringify(params.executionSummary ?? {})],
      );

      return {
        sellerAccountId: params.sellerAccountId,
        version: result.version,
        status: "reviewed",
        completedLineIds: params.completedLineIds ?? [],
      };
    },
    startSellListExecution: async (params) => {
      const existingReceipt = await getSellListReceiptByExecutionId(
        deps.db,
        params.sellerAccountId,
        params.executionId,
      );
      if (existingReceipt) {
        return {
          seller_account_id: params.sellerAccountId,
          execution_id: params.executionId,
          status: "finalized",
          execution_plan: {},
          execution_progress: { completedActionKeys: [] },
          execution_summary: existingReceipt.execution_summary,
          created_at: existingReceipt.checked_out_at,
          updated_at: existingReceipt.checked_out_at,
          finalized_at: existingReceipt.checked_out_at,
        };
      }

      await deps.db.query(
        `INSERT INTO checkout_sell_list_execution_pages (
           seller_account_id,
           execution_id,
           status,
           execution_plan,
           created_at,
           updated_at
         )
         VALUES ($1, $2, 'pending', $3::jsonb, now(), now())
         ON CONFLICT (seller_account_id, execution_id) DO NOTHING`,
        [params.sellerAccountId, params.executionId, JSON.stringify(params.executionPlan ?? {})],
      );

      const execution = await getSellListExecution(deps.db, params.sellerAccountId, params.executionId);
      if (!execution) {
        throw new CheckoutDomainError("Sell List execution could not be started.");
      }

      return execution;
    },
    recordSellListExecutionProgress: async (params) => {
      const existing = await getSellListExecution(deps.db, params.sellerAccountId, params.executionId);
      if (!existing) {
        throw new CheckoutDomainError("Sell List execution could not be found.");
      }

      const progress =
        typeof existing.execution_progress === "object" && existing.execution_progress !== null
          ? (existing.execution_progress as { completedActionKeys?: unknown })
          : {};
      const completedActionKeys = Array.isArray(progress.completedActionKeys)
        ? progress.completedActionKeys.map(String).filter(Boolean)
        : [];
      const nextCompletedActionKeys = [...new Set([...completedActionKeys, params.completedActionKey])];

      await deps.db.query(
        `UPDATE checkout_sell_list_execution_pages
         SET execution_progress = $3::jsonb,
             updated_at = now()
         WHERE seller_account_id = $1
           AND execution_id = $2`,
        [params.sellerAccountId, params.executionId, JSON.stringify({ completedActionKeys: nextCompletedActionKeys })],
      );

      const updated = await getSellListExecution(deps.db, params.sellerAccountId, params.executionId);
      if (!updated) {
        throw new CheckoutDomainError("Sell List execution progress could not be recorded.");
      }

      return updated;
    },
    getLatestReceipt: (sellerAccountId) => getLatestSellListReceipt(deps.db, sellerAccountId),
    getReceiptByExecutionId: (sellerAccountId, executionId) =>
      getSellListReceiptByExecutionId(deps.db, sellerAccountId, executionId),
    getExecution: (sellerAccountId, executionId) => getSellListExecution(deps.db, sellerAccountId, executionId),
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
        try {
          await commandHandler({
            streamId: `checkout.sell-list-${params.sourceOwnerId}`,
            command: {
              type: "CheckoutSellList",
              executionId: createId("sle"),
              checkedOutAt: new Date().toISOString(),
            },
            context,
          });
        } catch (error) {
          if (!isIdempotentMergeReplay(error)) {
            throw error;
          }
        }
      }

      return { mergedLineCount: sourceLines.length };
    },
    listLines: (sellerAccountId) => listSellListLines(deps.db, sellerAccountId),
    projectors: [sellListProjector],
  };
}
