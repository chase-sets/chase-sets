import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { module as orderingModule } from "../../index";
import {
  context,
  productMeasureForCandidate,
  shipFromAddress,
  shippingAddress,
  type SupplyCandidate,
} from "../../features/orders/api/runtime-test-harness";
import {
  defaultShippingRates,
  shippingRatesPolicy,
  type ShippingRates,
} from "../../features/orders/domain/shipping-rates";
import type { OrderingServices } from "./services";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["ordering"] as const;

const sellerAccountId = "acc_seller";

// 4.3 ounces plus 2 ounces of parcel packaging bills as a 7 ounce standard parcel: 499 + 3 x 32 cents
// under the compiled rates, 600 + 4 x 50 cents under the saved revision.
const sealedBox: SupplyCandidate = {
  listingId: "lst_sealed_box",
  sellerAccountId,
  inventoryItemId: "inv_sealed_box",
  catalogItemId: "cat_sealed_box",
  productId: "cat_sealed_box::",
  itemTitle: "Sealed box",
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  storageLocationName: null,
  shipFromCode: "CHI",
  priceAmount: "20.00",
  availableQuantity: 10,
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const savedRates: ShippingRates = {
  letterAmount: "2.00",
  standardParcelAmount: "6.00",
  expeditedParcelAmount: "8.50",
  priorityParcelAmount: "11.00",
  parcelIncludedOunces: 3,
  parcelAdditionalOunceAmount: "0.50",
};

describeDb("ordering Shipping Rates Policy db", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let databaseUrls: Readonly<Record<(typeof contextNames)[number], string>>;
  let services: OrderingServices;

  beforeAll(async () => {
    databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "ordering_shipping_rates_policy");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.ordering.query(orderingModule.schemaSql);
    await seedSealedBoxSupply();
    // A fresh composition per test: the policy runtime's cache lives in the services.
    services = orderingModule.createServices(pools.ordering, {
      inventoryCleanupAuthority: { kind: "not-mounted" },
    });
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function seedSealedBoxSupply() {
    await pools.ordering.query(
      `INSERT INTO ordering_account_pages (account_id, display_name, status)
       VALUES ($1, $1, 'active')
       ON CONFLICT (account_id) DO UPDATE SET status = 'active'`,
      [sellerAccountId],
    );
    await pools.ordering.query(
      `INSERT INTO ordering_inventory_item_inputs
       (item_id, seller_account_id, catalog_catalog_item_id, product_id, total_quantity, updated_at, last_stream_version)
       VALUES ($1, $2, $3, $4, 10, now(), 1)`,
      [sealedBox.inventoryItemId, sealedBox.sellerAccountId, sealedBox.catalogItemId, sealedBox.productId],
    );
    await pools.ordering.query(
      `INSERT INTO ordering_market_listing_inputs
       (listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id, item_title,
        ship_from_code, ship_from_address, product_measure_snapshot, price_amount, price_currency_code,
        listing_stream_version, marketplace_sales_fee_unit_amount, seller_net_unit_amount, terms_resolved_at,
        quantity_cap, max_units_per_day, max_units_per_customer_account, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'Sealed box', 'CHI', $6::jsonb, $7::jsonb, 20, 'USD', 1, 1, 19, now(), 10, 2, 2, 'active', now())`,
      [
        sealedBox.listingId,
        sealedBox.sellerAccountId,
        sealedBox.inventoryItemId,
        sealedBox.catalogItemId,
        sealedBox.productId,
        JSON.stringify(shipFromAddress),
        JSON.stringify({
          ...productMeasureForCandidate(sealedBox),
          measureVersion: "test-sealed-box-v1",
          unitLengthInches: 7,
          unitWidthInches: 5,
          unitHeightInches: 2,
          unitWeightOunces: 4.3,
          physicalFlags: ["rigid"],
          stackBehavior: "stackable-height",
        }),
      ],
    );
  }

  function checkout(checkoutSessionId: string) {
    return {
      buyerAccountId: context.audit.forAccountId,
      checkoutSessionId,
      sourceType: "cart-checkout" as const,
      shippingOption: "standard" as const,
      shippingAddress,
      lines: [
        {
          listingId: sealedBox.listingId,
          cartLineId: `cli_${checkoutSessionId}`,
          catalogItemId: sealedBox.catalogItemId,
          productId: sealedBox.productId,
          itemTitle: sealedBox.itemTitle,
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
        },
      ],
    };
  }

  /** Previews, then confirms that preview, as a buyer does; returns the preview totals and the order as recorded. */
  async function previewAndCreateOrder(checkoutSessionId: string) {
    const preview = await services.orders.previewCheckoutFulfillment(checkout(checkoutSessionId));
    const created = await services.orders.createOrdersFromCheckout(
      { ...checkout(checkoutSessionId), fulfillmentPreviewRevision: preview.revision },
      context,
    );
    expect(created.orderIds).toHaveLength(1);
    return { previewTotals: preview.totals, orderId: created.orderIds[0]! };
  }

  async function recordedOrder(orderId: string) {
    const events = await createPostgresEventStore({ pool: pools.ordering }).readStream({
      streamId: `ordering.order-${orderId}`,
    });
    return events.find((event) => event.eventType === "ordering.order.created")?.payload;
  }

  /** Saves a revision through the composed policy runtime and applies Ordering's own policy projection to it. */
  async function saveShippingRates(value: ShippingRates) {
    const { documentId } = await services.policies.createPolicyDocument(
      shippingRatesPolicy,
      {
        status: "active",
        value,
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: context.audit.performedByUserId,
      },
      context,
    );
    const handlers = services.projectors.find(
      (projector) => projector.projectionName === "platform-policy-document-projection",
    )?.handlers;
    if (!handlers) throw new Error("Ordering does not mount the policy document projection.");
    const eventStore = createPostgresEventStore({ pool: pools.ordering });
    for (const event of await eventStore.readStream({ streamId: `platform-policy.document-${documentId}` })) {
      await handlers[event.eventType]?.(toTransportEvent(event));
    }
    return documentId;
  }

  async function savedDocumentCount() {
    const result = await pools.ordering.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM platform_policy_documents WHERE policy_key = $1",
      [shippingRatesPolicy.policyKey],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  it("charges and records the compiled rates while no Shipping Rates document exists", async () => {
    expect(await savedDocumentCount()).toBe(0);
    expect(await services.policies.resolvePolicy(shippingRatesPolicy)).toMatchObject({
      source: "fallback",
      documentId: null,
      value: defaultShippingRates,
    });

    const { previewTotals, orderId } = await previewAndCreateOrder("chk_no_document");

    expect(previewTotals).toMatchObject({ shippingAmount: "5.15", totalAmount: "25.15" });
    expect(await recordedOrder(orderId)).toMatchObject({
      shippingBaseAmount: "5.95",
      shippingChargeAmount: "5.15",
      totalAmount: "25.15",
      commercialTermsSnapshot: { shippingRates: defaultShippingRates },
    });
  });

  it("charges a saved revision on the next plan and leaves the earlier order at the rates it recorded", async () => {
    const earlier = await previewAndCreateOrder("chk_before_revision");
    const earlierRecord = await recordedOrder(earlier.orderId);
    expect(earlierRecord).toMatchObject({
      shippingBaseAmount: "5.95",
      shippingChargeAmount: "5.15",
      totalAmount: "25.15",
      commercialTermsSnapshot: { shippingRates: defaultShippingRates },
    });

    const documentId = await saveShippingRates(savedRates);

    expect(await savedDocumentCount()).toBe(1);
    expect(await services.policies.resolvePolicy(shippingRatesPolicy)).toMatchObject({
      source: "policy",
      documentId,
      value: savedRates,
    });

    const later = await previewAndCreateOrder("chk_after_revision");

    expect(later.previewTotals).toMatchObject({ shippingAmount: "7.20", totalAmount: "27.20" });
    expect(await recordedOrder(later.orderId)).toMatchObject({
      shippingBaseAmount: "8.00",
      shippingChargeAmount: "7.20",
      totalAmount: "27.20",
      commercialTermsSnapshot: { shippingRates: savedRates },
    });
    expect(await recordedOrder(earlier.orderId)).toEqual(earlierRecord);
  });
});
