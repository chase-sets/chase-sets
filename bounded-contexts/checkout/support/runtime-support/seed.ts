import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { catalogScenarioItems, catalogSeedIds } from "@chase-sets/catalog-seed";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { marketplaceReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createCartReadinessSnapshot, type CartReadinessLine } from "../../features/cart/domain/readiness";
import type { CheckoutSessionLine } from "../../features/sessions/domain/domain";
import { createCheckoutProductDescriptor, type CheckoutVersionSchema } from "./common";
import { createCheckoutServices, type CheckoutServices } from "./services";
import { checkoutSeedIds } from "../seed-support/ids";

const rawNearMintVersionSelection = [
  {
    dimensionId: catalogSeedIds.dimensions.form.dimensionId,
    optionId: catalogSeedIds.dimensions.form.optionIds.raw,
  },
  {
    dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
    optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
  },
] as const;

const rawExcellentVersionSelection = [
  {
    dimensionId: catalogSeedIds.dimensions.form.dimensionId,
    optionId: catalogSeedIds.dimensions.form.optionIds.raw,
  },
  {
    dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
    optionId: catalogSeedIds.dimensions.condition.optionIds.excellent,
  },
] as const;

const demoCartLines = [
  {
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    itemImageUrl: null,
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    lockedListingId: marketplaceReservedSeedIds.listings.charizardBaseSetNearMint,
    quantity: 1,
  },
  {
    catalogItemId: catalogScenarioItems.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    itemImageUrl: null,
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    lockedListingId: marketplaceReservedSeedIds.listings.pikachuJungleLightlyPlayed,
    quantity: 1,
  },
] as const;

function createSeedContextFor(accountId: AccountId, userId: string) {
  return {
    tenantId: "tnt_identity" as TenantId,
    audit: {
      performedByUserId: userId as UserId,
      forAccountId: accountId,
    },
  };
}

async function hasCartLines(db: PgQueryable, buyerAccountId: AccountId) {
  const result = await db.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM checkout_cart_line_pages WHERE buyer_account_id = $1",
    [buyerAccountId],
  );

  return Number(result.rows[0]?.count ?? 0) > 0;
}

async function hasStartedSession(db: PgQueryable) {
  const result = await db.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM checkout_session_pages WHERE session_id = $1) AS exists",
    [checkoutSeedIds.sessions.startedCart],
  );

  return result.rows[0]?.exists ?? false;
}

async function buildProductId(db: PgQueryable, line: (typeof demoCartLines)[number]) {
  const result = await db.query<{
    product_schema: unknown;
  }>(
    `SELECT product_schema
     FROM checkout_catalog_items
     WHERE catalog_item_id = $1
       AND status = 'active'`,
    [line.catalogItemId],
  );
  const catalogItem = result.rows[0];
  if (!catalogItem) {
    throw new Error(`No active checkout catalog item found for ${line.itemTitle}.`);
  }

  return createCheckoutProductDescriptor({
    catalogItemId: line.catalogItemId,
    productSchema:
      typeof catalogItem.product_schema === "object" && catalogItem.product_schema !== null
        ? (catalogItem.product_schema as CheckoutVersionSchema)
        : null,
    selection: line.selectedOptions,
  }).productId;
}

export async function seedCheckoutDatabase(
  pool: PgTransactionalPool,
  checkout: CheckoutServices = createCheckoutServices(pool),
) {
  const buyerAccountId = identitySeedIds.collector.accountId;
  const buyerContext = createSeedContextFor(buyerAccountId, identitySeedIds.collector.userId);
  const seededSessionLines: CheckoutSessionLine[] = [];
  const seededReadinessLines: CartReadinessLine[] = [];

  if (!(await hasCartLines(checkout.db, buyerAccountId))) {
    console.log("Starting checkout development seed...\n");
    for (const line of demoCartLines) {
      const productId = await buildProductId(checkout.db, line);
      const result = await checkout.cart.addLine(
        {
          accountId: buyerAccountId,
          catalogItemId: line.catalogItemId,
          productId,
          itemTitle: line.itemTitle,
          itemSubtitle: line.itemSubtitle,
          itemImageUrl: line.itemImageUrl ?? null,
          selectedOptions: line.selectedOptions,
          productSummary: line.productSummary,
          quantity: line.quantity,
          fulfillmentMode: "locked-listing",
          lockedListingId: line.lockedListingId,
        },
        buyerContext,
      );
      seededSessionLines.push({
        listingId: line.lockedListingId,
        cartLineId: result.lineId,
        catalogItemId: line.catalogItemId,
        productId,
        itemTitle: line.itemTitle,
        itemSubtitle: line.itemSubtitle,
        selectedOptions: [...line.selectedOptions],
        productSummary: line.productSummary,
        quantity: line.quantity,
        fulfillmentMode: "locked-listing",
        lockedListingId: line.lockedListingId,
        sellerPreferenceId: null,
        availabilityState: "available",
      });
      seededReadinessLines.push({
        line_id: result.lineId,
        catalog_catalog_item_id: line.catalogItemId,
        product_id: productId,
        item_title: line.itemTitle,
        quantity: line.quantity,
        fulfillment_mode: "locked-listing",
        locked_listing_id: line.lockedListingId,
        seller_preference_id: null,
        availability_state: "available",
        seller_options: [],
        updated_at: new Date().toISOString(),
      });
    }
    console.log("  Demo account cart seeded.");
  }

  if (!(await hasStartedSession(checkout.db))) {
    const projectedCartLines = await checkout.cart.listCartLines(buyerAccountId);
    const readinessLines = projectedCartLines.length > 0 ? projectedCartLines : seededReadinessLines;
    const readiness = createCartReadinessSnapshot(readinessLines);
    if (readiness.status !== "ready") {
      throw new Error("Checkout seed requires ready cart fulfillment before starting a session.");
    }

    const checkoutLines =
      projectedCartLines.length > 0
        ? projectedCartLines.map((line) => ({
            listingId: line.locked_listing_id,
            cartLineId: line.line_id,
            catalogItemId: line.catalog_catalog_item_id,
            productId: line.product_id,
            itemTitle: line.item_title,
            itemSubtitle: line.item_subtitle,
            selectedOptions: [...line.selected_options],
            productSummary: line.product_summary,
            quantity: line.quantity,
            fulfillmentMode: line.fulfillment_mode,
            lockedListingId: line.locked_listing_id,
            sellerPreferenceId: line.seller_preference_id,
            availabilityState: line.availability_state,
          }))
        : seededSessionLines;

    await checkout.sessions.commandHandler({
      streamId: `checkout.session-${checkoutSeedIds.sessions.startedCart}`,
      command: {
        type: "StartCheckoutSession",
        sessionId: checkoutSeedIds.sessions.startedCart,
        buyerAccountId,
        sourceType: "cart",
        shippingOption: "standard",
        cartReadinessSnapshot: readiness,
        lines: checkoutLines,
        createdAt: new Date().toISOString(),
      },
      context: buyerContext,
    });
    console.log(`  Started checkout session seeded (${checkoutSeedIds.sessions.startedCart}).`);
  }

  console.log("\nCheckout seed complete!");
}
