import type { Projector } from "@chase-sets/event-core/projector";
import type {
  PgQueryable,
  PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { catalogSeedIds } from "@chase-sets/catalog/seed-support/ids";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  createCheckoutProductDescriptor,
  type CheckoutVersionSchema,
} from "./common";
import {
  createCheckoutServices,
  type CheckoutServices,
} from "./services";
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
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    quantity: 1,
  },
  {
    catalogItemId: catalogSeedIds.items.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    quantity: 1,
  },
] as const;

function createSeedContextFor(accountId: AccountId, userId: string) {
  return {
    tenantId: "tnt_identity" as never,
    audit: {
      performedByUserId: userId as never,
      forAccountId: accountId,
    },
  };
}

async function drainProjectors(projectors: readonly Projector[]) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
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

async function buildProductId(
  db: PgQueryable,
  line: (typeof demoCartLines)[number],
) {
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
      typeof catalogItem.product_schema === "object" &&
      catalogItem.product_schema !== null
        ? (catalogItem.product_schema as CheckoutVersionSchema)
        : null,
    selection: line.selectedOptions,
  }).productId;
}

export async function seedCheckoutDatabase(
  pool: PgTransactionalPool,
  checkout: CheckoutServices = createCheckoutServices(pool),
) {
  const buyerAccountId = identitySeedIds.buyer.accountId;
  const buyerContext = createSeedContextFor(
    buyerAccountId,
    identitySeedIds.buyer.userId,
  );

  await drainProjectors(checkout.projectors);

  if (!(await hasCartLines(checkout.db, buyerAccountId))) {
    console.log("Starting checkout development seed...\n");
    for (const line of demoCartLines) {
      await checkout.cart.addLine(
        {
          buyerAccountId,
          catalogItemId: line.catalogItemId,
          productId: await buildProductId(checkout.db, line),
          itemTitle: line.itemTitle,
          itemSubtitle: line.itemSubtitle,
          selectedOptions: line.selectedOptions,
          productSummary: line.productSummary,
          quantity: line.quantity,
        },
        buyerContext,
      );
    }
    await drainProjectors(checkout.projectors);
    console.log("  Demo buyer cart seeded.");
  }

  if (!(await hasStartedSession(checkout.db))) {
    await checkout.sessions.createFromCart(
      {
        buyerAccountId,
        shippingOption: "standard",
        sessionIdOverride: checkoutSeedIds.sessions.startedCart,
      },
      buyerContext,
    );
    await drainProjectors(checkout.projectors);
    console.log(`  Started checkout session seeded (${checkoutSeedIds.sessions.startedCart}).`);
  }

  console.log("\nCheckout seed complete!");
}
