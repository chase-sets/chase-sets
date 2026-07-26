import type { BcSeedAggregateStateReport } from "@chase-sets/bounded-context-module";
import { loadSeedStreamEvents } from "@chase-sets/bounded-context-runtime";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { catalogScenarioItems, catalogSeedIds } from "@chase-sets/catalog-seed";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { marketplaceReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createCartReadinessSnapshot, type CartReadinessLine } from "../../features/cart/domain/readiness";
import {
  evolveCheckoutCart,
  initialCheckoutCartState,
  type CheckoutCartEvent,
} from "../../features/cart/domain/domain";
import {
  evolveCheckoutSession,
  initialCheckoutSessionState,
  type CheckoutSessionEvent,
  type CheckoutSessionLine,
} from "../../features/sessions/domain/domain";
import { createCheckoutProductDescriptor, type CheckoutVersionSchema } from "./common";
import type { CartLineId } from "./common";
import { createCheckoutServices, type CheckoutServices } from "./services";
import { checkoutSeedIds } from "../seed-support/ids";

const CHECKOUT_SEED_AT = "2026-03-20T12:00:00.000Z";

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
    cartLineId: checkoutSeedIds.cartLines.demoCharizardBaseSetNearMint,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    itemImageUrl: null,
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    lockedListingId: marketplaceReservedSeedIds.listings.charizardBaseSetNearMint,
    sellerAccountId: identitySeedIds.demo.accountId,
    sellerDisplayName: "Chase Sets",
    priceAmount: "399.99",
    availableQuantity: 2,
    quantity: 1,
  },
  {
    cartLineId: checkoutSeedIds.cartLines.demoPikachuJungleExcellent,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    itemImageUrl: null,
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    lockedListingId: marketplaceReservedSeedIds.listings.pikachuJungleLightlyPlayed,
    sellerAccountId: identitySeedIds.demo.accountId,
    sellerDisplayName: "Chase Sets",
    priceAmount: "21.50",
    availableQuantity: 3,
    quantity: 1,
  },
] as const;

function demoSellerOptionFor(lockedListingId: string | null): CartReadinessLine["seller_options"][number] | null {
  const line = demoCartLines.find((demoLine) => demoLine.lockedListingId === lockedListingId);
  if (!line) {
    return null;
  }

  return {
    listing_id: line.lockedListingId,
    seller_account_id: line.sellerAccountId,
    seller_display_name: line.sellerDisplayName,
    price_amount: line.priceAmount,
    available_quantity: line.availableQuantity,
    product_summary: line.productSummary,
    product_measure_snapshot: {
      catalogItemId: line.catalogItemId,
      productId: `${line.catalogItemId}::seed-readiness-fallback`,
      selectedOptions: [...line.selectedOptions],
      measureVersion: "checkout-seed-demo-raw-card-v1",
      unitLengthInches: 3.5,
      unitWidthInches: 2.5,
      unitHeightInches: 0.02,
      unitWeightOunces: 0.08,
      physicalFlags: ["raw-card"],
      stackBehavior: "stackable-thickness",
      source: "profile",
      confidence: "measured",
    },
  };
}

function createSeedContextFor(accountId: AccountId, userId: string) {
  return {
    tenantId: "tnt_identity" as TenantId,
    audit: {
      performedByUserId: userId as UserId,
      forAccountId: accountId,
    },
  };
}

const CHECKOUT_BOOTSTRAP_LABEL = "Checkout seed bootstrap";

const checkoutCartStreamId = (accountId: AccountId) => `checkout.cart-${accountId}`;
const checkoutSessionStreamId = (sessionId: string) => `checkout.session-${sessionId}`;

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

function seedReadinessLineFor(
  line: (typeof demoCartLines)[number],
  lineId: string,
  productId: string,
): CartReadinessLine {
  const sellerOption = demoSellerOptionFor(line.lockedListingId);
  if (!sellerOption) {
    throw new Error(`No checkout seed seller option found for ${line.itemTitle}.`);
  }

  return {
    line_id: lineId,
    catalog_catalog_item_id: line.catalogItemId,
    product_id: productId,
    item_title: line.itemTitle,
    quantity: line.quantity,
    fulfillment_mode: "locked-listing",
    locked_listing_id: line.lockedListingId,
    seller_preference_id: null,
    availability_state: "available",
    seller_options: [sellerOption],
    updated_at: CHECKOUT_SEED_AT,
  };
}

function seedSessionLineFor(
  line: (typeof demoCartLines)[number],
  lineId: string,
  productId: string,
): CheckoutSessionLine {
  return {
    listingId: line.lockedListingId,
    cartLineId: lineId,
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
  };
}

/**
 * Reconciles the demo buyer's cart from the authoritative `checkout.cart-*`
 * stream, one line at a time.
 *
 * `checkout_cart_line_pages` is UNLOGGED, so PostgreSQL truncates it on crash
 * recovery while the logged cart stream survives. The projection-sourced guard
 * this replaced answered a single all-or-nothing question ("does this buyer
 * have any cart line?") for a set-shaped decision; a cart holding one of its
 * two seeded lines was therefore either duplicated or left half-seeded. Each
 * reserved line is now decided on whether that line id is on the stream.
 */
async function reconcileSeedCartLines(
  checkout: CheckoutServices,
  buyerAccountId: AccountId,
  buyerContext: ReturnType<typeof createSeedContextFor>,
  apply: boolean,
): Promise<readonly SeedCartLineState[]> {
  const committed = await loadSeedStreamEvents<CheckoutCartEvent>(checkout.db, checkoutCartStreamId(buyerAccountId));
  const cart = committed.reduce(evolveCheckoutCart, initialCheckoutCartState);
  const states: SeedCartLineState[] = [];

  for (const line of demoCartLines) {
    const lineId = line.cartLineId;
    const existing = cart.lines.find((cartLine) => String(cartLine.lineId) === lineId);

    if (existing) {
      // Retained metadata must still describe the line the seed asked for.
      if (existing.lockedListingId !== line.lockedListingId || existing.catalogItemId !== line.catalogItemId) {
        throw new Error(
          `${CHECKOUT_BOOTSTRAP_LABEL} Cart Line '${lineId}' expected listing '${line.lockedListingId}' and ` +
            `catalog item '${line.catalogItemId}', but found listing '${existing.lockedListingId ?? "null"}' and ` +
            `catalog item '${existing.catalogItemId}'. Stream '${checkoutCartStreamId(buyerAccountId)}'.`,
        );
      }
      states.push({ line, lineId, productId: existing.productId, kind: "active", eventCount: committed.length });
      continue;
    }

    if (!apply) {
      states.push({ line, lineId, productId: null, kind: "absent", eventCount: committed.length });
      continue;
    }

    const productId = await buildProductId(checkout.db, line);
    await checkout.cart.commandHandler({
      streamId: checkoutCartStreamId(buyerAccountId),
      command: {
        type: "AddCartLine",
        buyerAccountId,
        lineId: lineId as CartLineId,
        catalogItemId: line.catalogItemId,
        productId,
        itemTitle: line.itemTitle,
        itemSubtitle: line.itemSubtitle,
        itemImageUrl: line.itemImageUrl ?? null,
        selectedOptions: [...line.selectedOptions],
        productSummary: line.productSummary,
        quantity: line.quantity,
        fulfillmentMode: "locked-listing",
        lockedListingId: line.lockedListingId,
      },
      context: buyerContext,
    });
    states.push({ line, lineId, productId, kind: "absent", eventCount: committed.length });
  }

  return states;
}

type SeedCartLineState = Readonly<{
  line: (typeof demoCartLines)[number];
  lineId: string;
  productId: string | null;
  kind: "absent" | "active";
  eventCount: number;
}>;

async function loadSeedSessionState(
  checkout: CheckoutServices,
): Promise<Readonly<{ kind: "absent" | "active"; eventCount: number }>> {
  const committed = await loadSeedStreamEvents<CheckoutSessionEvent>(
    checkout.db,
    checkoutSessionStreamId(checkoutSeedIds.sessions.startedCart),
  );
  const session = committed.reduce(evolveCheckoutSession, initialCheckoutSessionState);
  return { kind: session.sessionId === null ? "absent" : "active", eventCount: committed.length };
}

/**
 * Reports the Checkout seed's base aggregate state from the authoritative
 * `checkout.*` streams: one report per reserved cart line plus the started
 * checkout session.
 */
export async function inspectCheckoutSeedState(
  pool: PgTransactionalPool,
): Promise<readonly BcSeedAggregateStateReport[]> {
  const checkout = createCheckoutServices(pool);
  const buyerAccountId = identitySeedIds.collector.accountId;
  const buyerContext = createSeedContextFor(buyerAccountId, identitySeedIds.collector.userId);
  const cartLines = await reconcileSeedCartLines(checkout, buyerAccountId, buyerContext, false);
  const session = await loadSeedSessionState(checkout);

  return [
    ...cartLines.map((state) => ({
      contextName: "checkout",
      aggregateName: "Cart Line",
      id: state.lineId,
      key: state.line.lockedListingId,
      streamId: checkoutCartStreamId(buyerAccountId),
      kind: state.kind,
      status: state.kind === "active" ? "in-cart" : null,
      eventCount: state.eventCount,
    })),
    {
      contextName: "checkout",
      aggregateName: "Checkout Session",
      id: checkoutSeedIds.sessions.startedCart,
      key: "started-cart",
      streamId: checkoutSessionStreamId(checkoutSeedIds.sessions.startedCart),
      kind: session.kind,
      status: session.kind === "active" ? "started" : null,
      eventCount: session.eventCount,
    },
  ];
}

export async function seedCheckoutDatabase(
  pool: PgTransactionalPool,
  checkout: CheckoutServices = createCheckoutServices(pool),
) {
  const buyerAccountId = identitySeedIds.collector.accountId;
  const buyerContext = createSeedContextFor(buyerAccountId, identitySeedIds.collector.userId);

  console.log("Starting checkout development seed...\n");
  const cartLines = await reconcileSeedCartLines(checkout, buyerAccountId, buyerContext, true);
  console.log("  Demo account cart reconciled.");

  const session = await loadSeedSessionState(checkout);
  if (session.kind === "absent") {
    const resolvedLines = cartLines.filter(
      (state): state is SeedCartLineState & Readonly<{ productId: string }> => state.productId !== null,
    );
    if (resolvedLines.length !== demoCartLines.length) {
      throw new Error("Checkout seed could not resolve every seeded cart line before starting a session.");
    }

    const readiness = createCartReadinessSnapshot(
      resolvedLines.map((state) => seedReadinessLineFor(state.line, state.lineId, state.productId)),
    );
    if (readiness.status !== "ready") {
      throw new Error("Checkout seed requires ready cart fulfillment before starting a session.");
    }

    await checkout.sessions.commandHandler({
      streamId: checkoutSessionStreamId(checkoutSeedIds.sessions.startedCart),
      command: {
        type: "StartCheckoutSession",
        sessionId: checkoutSeedIds.sessions.startedCart,
        buyerAccountId,
        sourceType: "cart",
        shippingOption: "standard",
        cartReadinessSnapshot: readiness,
        lines: resolvedLines.map((state) => seedSessionLineFor(state.line, state.lineId, state.productId)),
        createdAt: CHECKOUT_SEED_AT,
      },
      context: buyerContext,
    });
    console.log(`  Started checkout session seeded (${checkoutSeedIds.sessions.startedCart}).`);
  }

  console.log("\nCheckout seed complete!");
}
