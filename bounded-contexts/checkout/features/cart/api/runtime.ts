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
  requireCheckoutCartClaimIdentity,
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
import {
  listCartLines,
  listClaimedCartOwnerKeys,
  listOwnCartLines,
  ownerKeyCanHoldClaims,
  reconcileCheckoutCartClaim,
} from "../read-model/queries";

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
  claimCart: (
    params: Readonly<{
      sourceOwnerKey: string;
      accountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ version: number }>;
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
  listClaimedOwnerKeys: (accountId: string) => ReturnType<typeof listClaimedCartOwnerKeys>;
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

  /**
   * Resolves the stream that actually holds the line the acting owner can see.
   *
   * The union already decides which single row wins a `line_id` held by more
   * than one owner -- the Account's own row first, then the newest claimed row --
   * so reading `buyer_account_id` off that winning row targets exactly the
   * aggregate the reader was looking at. An id the acting owner cannot see falls
   * back to their own stream, where the aggregate refuses with the unchanged
   * missing-line message rather than reaching for someone else's cart.
   *
   * An owner that cannot hold claims resolves to itself by construction, so the
   * anonymous path keeps its existing single round trip instead of paying for a
   * union read whose answer is already known.
   */
  async function resolveLineSourceOwnerKey(actingOwnerKey: string, lineId: CartLineId) {
    if (!ownerKeyCanHoldClaims(actingOwnerKey)) {
      return actingOwnerKey;
    }

    const visible = await listCartLines(deps.db, actingOwnerKey);
    return visible.find((line) => line.line_id === lineId)?.buyer_account_id ?? actingOwnerKey;
  }

  function isMissingCartLine(error: unknown) {
    return error instanceof CheckoutDomainError && error.message === "Cart line not found.";
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

    // Own-key only: a matching line held on a claimed source stream must not
    // turn this add into a SetCartLineQuantity against the Account stream,
    // where that line does not exist.
    const existingLine = (await listOwnCartLines(deps.db, params.accountId)).find(
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
          // The own-key probe above matched a line on this same stream, so the
          // merge acts as its own owner and never routes across a claim.
          actingOwnerKey: params.accountId,
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
        streamId: `checkout.cart-${await resolveLineSourceOwnerKey(params.accountId, params.lineId)}`,
        command: {
          type: "SetCartLineQuantity",
          actingOwnerKey: params.accountId,
          lineId: params.lineId,
          quantity: params.quantity,
        },
        context,
      });

      return { lineId: params.lineId, version: result.version };
    },
    setLineFulfillment: async (params, context) => {
      const result = await commandHandler({
        streamId: `checkout.cart-${await resolveLineSourceOwnerKey(params.accountId, params.lineId)}`,
        command: {
          type: "SetCartLineFulfillment",
          actingOwnerKey: params.accountId,
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
    // Removal is line-id-total across everything the acting owner owns: its own
    // stream plus every stream it has claimed, so a line the reader can see is
    // gone from every source it was ever readable from -- including a duplicate
    // the union deliberately hides.
    //
    // Only the missing-line refusal is absorbed, and only per owner. An
    // ownership refusal from a stream this owner does not own propagates
    // unchanged, so a stale alias row can never be laundered into silent
    // success. Because every owner that lacks the line is a no-op, an
    // interrupted sweep and an outward retry converge on the same end state
    // without a second removal event.
    removeLine: async (params, context) => {
      const ownerKeys = [params.accountId, ...(await listClaimedCartOwnerKeys(deps.db, params.accountId))];
      let version: number | null = null;

      for (const ownerKey of ownerKeys) {
        try {
          const result = await commandHandler({
            streamId: `checkout.cart-${ownerKey}`,
            command: {
              type: "RemoveCartLine",
              actingOwnerKey: params.accountId,
              lineId: params.lineId,
            },
            context,
          });
          version ??= result.version;
        } catch (error) {
          if (!isMissingCartLine(error)) {
            throw error;
          }
        }
      }

      // No owner held the line: nothing was appended, so there is no stream
      // version to report.
      return { lineId: params.lineId, version: version ?? 0 };
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
    // Caller-inert foundation: nothing in this repository invokes claimCart.
    // Wiring a caller requires the claimed-stream mutation authority,
    // the post-claim read/session authority, and atomic
    // retirement of the public cart merge endpoint. Neither the alias below nor
    // possession of a claimed key grants any authority on its own.
    //
    // Ownership is serialized on the claimed SOURCE stream, never on the
    // claimant's Account stream: only the shared source stream's loaded-version
    // OCC can order two Accounts racing for the same cart. The alias table's
    // primary key stops contradictory rows; it is not the serialization
    // primitive.
    claimCart: async (params, context) => {
      const claim = requireCheckoutCartClaimIdentity(params);
      const result = await commandHandler({
        streamId: `checkout.cart-${claim.sourceOwnerKey}`,
        command: {
          type: "ClaimCart",
          sourceOwnerKey: claim.sourceOwnerKey,
          accountId: claim.accountId,
        },
        context,
      });

      // Event first, alias second, with no distributed transaction and no
      // projection wait. This runs after a zero-event steady-state return as
      // well, so a retry after a committed event whose alias never landed
      // repairs the pair without appending a second event -- and an alias
      // failure propagates instead of being reported as a successful claim.
      await reconcileCheckoutCartClaim(deps.db, claim);

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
    listClaimedOwnerKeys: (accountId) => listClaimedCartOwnerKeys(deps.db, accountId),
    projectors: [cartProjector],
  };
}
