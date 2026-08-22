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
import type { CartLineId } from "../../../support/runtime-support/common";
import {
  CheckoutDomainError,
  createCheckoutProductDescriptor,
  type CheckoutVersionSchema,
} from "../../../support/runtime-support/common";
import {
  decideCheckoutCart,
  evolveCheckoutCart,
  initialCheckoutCartState,
  type CheckoutCartCommand,
  type CheckoutCartEvent,
  type CheckoutSelectedListingSnapshotInput,
  type CheckoutCartState,
} from "../domain/domain";
import {
  createCartReadinessSnapshot,
  type CartReadinessDecisionInput,
  type CartReadinessSnapshot,
} from "../domain/readiness";
import { buildCheckoutCartProjectionHandlers } from "../read-model/projection";
import { listCartLines } from "../read-model/queries";

function isIdempotentMergeReplay(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("Cart line has already been added.") ||
      error.message.includes("Cart must contain at least one line."))
  );
}

export type CheckoutCartRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type CheckoutCartServices = Readonly<{
  commandHandler: CommandHandler<CheckoutCartCommand, CheckoutCartState, CheckoutCartEvent>;
  addLine: (
    params: Readonly<{
      accountId: AccountId;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      itemSubtitle: string | null;
      itemImageUrl: string | null;
      itemImageSrcSet?: string | null;
      itemImageLoadingUrl?: string | null;
      itemImageLoadingAlt?: string | null;
      itemImageLoadingSrcSet?: string | null;
      selectedOptions: readonly { dimensionId: string; optionId: string }[];
      productSummary: string | null;
      quantity: number;
      fulfillmentMode?: "optimize" | "locked-listing";
      lockedListingId?: string | null;
      sellerPreferenceId?: string | null;
      selectedListingSnapshot?: CheckoutSelectedListingSnapshotInput | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ lineId: CartLineId; version: number; status: "added" | "merged" }>;
  addLines: (
    params: Readonly<{
      accountId: AccountId;
      lines: readonly {
        catalogItemId: string;
        productId: string;
        itemTitle: string;
        itemSubtitle: string | null;
        itemImageUrl: string | null;
        itemImageSrcSet?: string | null;
        itemImageLoadingUrl?: string | null;
        itemImageLoadingAlt?: string | null;
        itemImageLoadingSrcSet?: string | null;
        selectedOptions: readonly { dimensionId: string; optionId: string }[];
        productSummary: string | null;
        quantity: number;
        fulfillmentMode?: "optimize" | "locked-listing";
        lockedListingId?: string | null;
        sellerPreferenceId?: string | null;
        selectedListingSnapshot?: CheckoutSelectedListingSnapshotInput | null;
      }[];
    }>,
    context: EventStoreContext,
  ) => Promise<{
    requestedLineCount: number;
    addedLineCount: number;
    mergedLineCount: number;
    failedLineCount: number;
    lines: Array<{
      index: number;
      lineId: CartLineId | null;
      status: "added" | "merged" | "failed";
      message: string | null;
    }>;
  }>;
  setLineQuantity: (
    params: Readonly<{
      accountId: AccountId;
      lineId: CartLineId;
      quantity: number;
    }>,
    context: EventStoreContext,
  ) => Promise<{ lineId: CartLineId; version: number }>;
  setLineFulfillment: (
    params: Readonly<{
      accountId: AccountId;
      lineId: CartLineId;
      fulfillmentMode: "optimize" | "locked-listing";
      lockedListingId?: string | null;
      sellerPreferenceId?: string | null;
      selectedListingSnapshot?: CheckoutSelectedListingSnapshotInput | null;
      availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
    }>,
    context: EventStoreContext,
  ) => Promise<{ lineId: CartLineId; version: number }>;
  removeLine: (
    params: Readonly<{
      accountId: AccountId;
      lineId: CartLineId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ lineId: CartLineId; version: number }>;
  checkout: (accountId: AccountId, context: EventStoreContext) => Promise<{ version: number }>;
  mergeCartIntoAccount: (
    params: Readonly<{
      sourceOwnerId: string;
      targetAccountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ mergedLineCount: number }>;
  createReadinessSnapshot: (
    params: Readonly<{
      accountId: string;
      presentedAnonymousCartId?: string | null;
      decisions?: CartReadinessDecisionInput | null;
    }>,
  ) => Promise<CartReadinessSnapshot>;
  listCartLines: (accountId: string, presentedAnonymousCartId?: string | null) => ReturnType<typeof listCartLines>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createCheckoutCartRuntime(deps: CheckoutCartRuntimeDeps): CheckoutCartServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<CheckoutCartEvent>(),
    initialState: () => initialCheckoutCartState,
    evolve: evolveCheckoutCart,
    decide: decideCheckoutCart,
  });
  const cartProjector = createProjectionHandlerSet({
    projectionName: "checkout.cart-projection",
    inlineApply: true,
    handlers: buildCheckoutCartProjectionHandlers(deps.db),
  });

  async function getCatalogItemSnapshot(catalogItemId: string) {
    const result = await deps.db.query<{
      catalog_item_id: string;
      language_code: string;
      status: string;
      product_schema: unknown;
    }>(
      `SELECT catalog_item_id, language_code, status, product_schema
       FROM checkout_catalog_items
       WHERE catalog_item_id = $1`,
      [catalogItemId],
    );

    return result.rows[0] ?? null;
  }

  const addLine: CheckoutCartServices["addLine"] = async (params, context) => {
    const catalogItem = await getCatalogItemSnapshot(params.catalogItemId);
    if (!catalogItem) {
      throw new CheckoutDomainError("Catalog item not found.");
    }

    if (catalogItem.status !== "active") {
      throw new CheckoutDomainError("Cart lines may only reference active catalog items.");
    }

    const catalogVersion = createCheckoutProductDescriptor({
      catalogItemId: params.catalogItemId,
      productSchema:
        typeof catalogItem.product_schema === "object" && catalogItem.product_schema !== null
          ? (catalogItem.product_schema as CheckoutVersionSchema)
          : null,
      selection: params.selectedOptions,
    });

    if (params.productId.trim() !== catalogVersion.productId) {
      throw new CheckoutDomainError("Cart line product id does not match the selected options.");
    }

    const fulfillmentMode =
      params.fulfillmentMode === "locked-listing" || params.lockedListingId?.trim() ? "locked-listing" : "optimize";
    const lockedListingId = params.lockedListingId?.trim() || null;
    const sellerPreferenceId = params.sellerPreferenceId?.trim() || null;

    const existingLine = (await listCartLines(deps.db, params.accountId)).find(
      (line) =>
        line.catalog_catalog_item_id === params.catalogItemId &&
        line.product_id === catalogVersion.productId &&
        line.fulfillment_mode === fulfillmentMode &&
        (line.locked_listing_id ?? null) === lockedListingId &&
        (line.seller_preference_id ?? null) === sellerPreferenceId,
    );

    if (existingLine) {
      const result = await commandHandler({
        streamId: `checkout.cart-${params.accountId}`,
        command: {
          type: "SetCartLineQuantity",
          lineId: existingLine.line_id as CartLineId,
          quantity: existingLine.quantity + params.quantity,
        },
        context,
      });

      return { lineId: existingLine.line_id as CartLineId, version: result.version, status: "merged" };
    }

    const lineId = createId("cli") as CartLineId;
    const result = await commandHandler({
      streamId: `checkout.cart-${params.accountId}`,
      command: {
        type: "AddCartLine",
        buyerAccountId: params.accountId,
        lineId,
        catalogItemId: params.catalogItemId,
        productId: catalogVersion.productId,
        itemLanguageCode: catalogItem.language_code,
        itemTitle: params.itemTitle,
        itemSubtitle: params.itemSubtitle,
        itemImageUrl: params.itemImageUrl,
        itemImageSrcSet: params.itemImageSrcSet,
        itemImageLoadingUrl: params.itemImageLoadingUrl,
        itemImageLoadingAlt: params.itemImageLoadingAlt,
        itemImageLoadingSrcSet: params.itemImageLoadingSrcSet,
        selectedOptions: catalogVersion.selection,
        productSummary: params.productSummary,
        quantity: params.quantity,
        fulfillmentMode,
        lockedListingId,
        sellerPreferenceId,
        selectedListingSnapshot: params.selectedListingSnapshot,
        availabilityState: "available",
      },
      context,
    });

    return { lineId, version: result.version, status: "added" };
  };

  return {
    commandHandler,
    addLine,
    addLines: async (params, context) => {
      if (params.lines.length > 250) {
        throw new CheckoutDomainError("Bulk cart adds are limited to 250 products.");
      }

      const lines: Array<{
        index: number;
        lineId: CartLineId | null;
        status: "added" | "merged" | "failed";
        message: string | null;
      }> = [];
      let addedLineCount = 0;
      let mergedLineCount = 0;

      for (const [index, line] of params.lines.entries()) {
        try {
          const result = await addLine(
            {
              accountId: params.accountId,
              ...line,
            },
            context,
          );
          if (result.status === "merged") {
            mergedLineCount++;
          } else {
            addedLineCount++;
          }
          lines.push({
            index,
            lineId: result.lineId,
            status: result.status,
            message: null,
          });
        } catch (error) {
          lines.push({
            index,
            lineId: null,
            status: "failed",
            message: error instanceof Error ? error.message : "Cart line could not be added.",
          });
        }
      }

      return {
        requestedLineCount: params.lines.length,
        addedLineCount,
        mergedLineCount,
        failedLineCount: lines.filter((line) => line.status === "failed").length,
        lines,
      };
    },
    setLineQuantity: async (params, context) => {
      const result = await commandHandler({
        streamId: `checkout.cart-${params.accountId}`,
        command: {
          type: "SetCartLineQuantity",
          lineId: params.lineId,
          quantity: params.quantity,
        },
        context,
      });

      return { lineId: params.lineId, version: result.version };
    },
    setLineFulfillment: async (params, context) => {
      const result = await commandHandler({
        streamId: `checkout.cart-${params.accountId}`,
        command: {
          type: "SetCartLineFulfillment",
          lineId: params.lineId,
          fulfillmentMode: params.fulfillmentMode,
          lockedListingId: params.lockedListingId,
          sellerPreferenceId: params.sellerPreferenceId,
          selectedListingSnapshot: params.selectedListingSnapshot,
          availabilityState: params.availabilityState,
        },
        context,
      });

      return { lineId: params.lineId, version: result.version };
    },
    removeLine: async (params, context) => {
      const result = await commandHandler({
        streamId: `checkout.cart-${params.accountId}`,
        command: {
          type: "RemoveCartLine",
          lineId: params.lineId,
        },
        context,
      });

      return { lineId: params.lineId, version: result.version };
    },
    checkout: async (accountId, context) => {
      const result = await commandHandler({
        streamId: `checkout.cart-${accountId}`,
        command: {
          type: "CheckoutCart",
          checkedOutAt: new Date().toISOString(),
        },
        context,
      });

      return { version: result.version };
    },
    mergeCartIntoAccount: async (params, context) => {
      const sourceLines = await listCartLines(deps.db, params.sourceOwnerId);
      const existingTargetLineIds = new Set(
        (await listCartLines(deps.db, params.targetAccountId)).map((line) => line.line_id),
      );
      for (const line of sourceLines) {
        if (existingTargetLineIds.has(line.line_id)) {
          continue;
        }

        try {
          await commandHandler({
            streamId: `checkout.cart-${params.targetAccountId}`,
            command: {
              type: "AddCartLine",
              buyerAccountId: params.targetAccountId,
              lineId: line.line_id as CartLineId,
              catalogItemId: line.catalog_catalog_item_id,
              productId: line.product_id,
              itemLanguageCode: line.item_language_code,
              itemTitle: line.item_title,
              itemSubtitle: line.item_subtitle,
              itemImageUrl: line.item_image_url,
              itemImageSrcSet: line.item_image_srcset,
              itemImageLoadingUrl: line.item_image_loading_url,
              itemImageLoadingAlt: line.item_image_loading_alt,
              itemImageLoadingSrcSet: line.item_image_loading_srcset,
              selectedOptions: line.selected_options,
              productSummary: line.product_summary,
              quantity: line.quantity,
              fulfillmentMode: line.fulfillment_mode,
              lockedListingId: line.locked_listing_id,
              sellerPreferenceId: line.seller_preference_id,
              selectedListingSnapshot: line.selected_listing_id
                ? {
                    listingId: line.selected_listing_id,
                    sellerAccountId: line.selected_listing_seller_account_id,
                    sellerDisplayName: line.selected_listing_seller_display_name,
                    sellerSlug: line.selected_listing_seller_slug,
                    priceAmount: line.selected_listing_price_amount,
                    source: line.selected_listing_snapshot_source,
                  }
                : null,
              availabilityState: line.availability_state,
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
            streamId: `checkout.cart-${params.sourceOwnerId}`,
            command: {
              type: "CheckoutCart",
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
    createReadinessSnapshot: async (params) => {
      const lines = await listCartLines(deps.db, params.accountId, params.presentedAnonymousCartId);
      return createCartReadinessSnapshot(
        lines,
        params.decisions,
        params.presentedAnonymousCartId
          ? {
              accountId: params.accountId,
              presentedAnonymousCartId: params.presentedAnonymousCartId,
            }
          : undefined,
      );
    },
    listCartLines: (accountId, presentedAnonymousCartId) => listCartLines(deps.db, accountId, presentedAnonymousCartId),
    projectors: [cartProjector],
  };
}
