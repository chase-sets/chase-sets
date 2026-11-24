import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import {
  context,
  createSupplyDb,
  productMeasureForCandidate,
  shippingAddress,
  type SupplyCandidate,
} from "../features/orders/api/runtime-test-harness";
import { shippingRatesPolicy, type ShippingRates } from "../features/orders/domain/shipping-rates";
import { createOrderingServices } from "../support/runtime-support/services";

// Hoisted by Vitest; hands the composed Ordering services an in-memory event store.
const composition = vi.hoisted(() => ({ eventStore: undefined as EventStore | undefined }));
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
  createPostgresEventStore: () => composition.eventStore,
}));

const policyKey = "ordering.shipping-rates";

// A 7 ounce standard parcel is 600 + 4 x 50 cents under these rates; the compiled default makes it 499 + 3 x 32.
const savedRates: ShippingRates = {
  letterAmount: "2.00",
  standardParcelAmount: "6.00",
  expeditedParcelAmount: "8.50",
  priorityParcelAmount: "11.00",
  parcelIncludedOunces: 3,
  parcelAdditionalOunceAmount: "0.50",
};

const listing: SupplyCandidate = {
  listingId: "lst_1",
  sellerAccountId: "acc_seller",
  inventoryItemId: "inv_1",
  catalogItemId: "cat_1",
  productId: "cat_1::",
  itemTitle: "Charizard",
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  storageLocationName: "North shelf",
  shipFromCode: "CHI",
  priceAmount: "20.00",
  availableQuantity: 1,
  updatedAt: "2026-03-31T00:00:00.000Z",
};

// 4.3 ounces plus 2 ounces of parcel packaging bills as a 7 ounce parcel.
const sealedBox: SupplyCandidate = {
  ...listing,
  productMeasureSnapshot: {
    ...productMeasureForCandidate(listing),
    measureVersion: "test-sealed-box-v1",
    unitLengthInches: 7,
    unitWidthInches: 5,
    unitHeightInches: 2,
    unitWeightOunces: 4.3,
    physicalFlags: ["rigid"],
    stackBehavior: "stackable-height",
  },
};

/** Ordering's database with one sealed box in supply, one saved Shipping Rates document and no Postage Policy. */
function orderingDatabase() {
  const supply = createSupplyDb(() => [sealedBox]);
  const query = vi.fn(
    async (sql: string, params?: readonly unknown[]): Promise<{ rows: readonly unknown[]; rowCount?: number }> => {
      if (sql.includes("FROM platform_policy_documents")) {
        const rows = params?.includes(policyKey)
          ? [
              {
                document_id: "pol_shipping_rates",
                policy_key: policyKey,
                context_name: "ordering",
                schema_summary: shippingRatesPolicy.schemaSummary,
                status: "active",
                value: savedRates,
                effective_from: "2026-07-01T00:00:00.000Z",
                effective_until: null,
                created_at: "2026-07-01T00:00:00.000Z",
                updated_at: "2026-07-01T00:00:00.000Z",
              },
            ]
          : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("FROM ordering_postage_policy_pages")) {
        return { rows: [], rowCount: 0 };
      }
      return supply.query(sql, params);
    },
  );
  return { connect: async () => ({ query, release: () => {} }), query };
}

describe("Ordering services", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The order runtime requires a Shipping Rates resolver, so no host can leave it out. One that
  // resolved anywhere but this policy runtime would type-check and charge the compiled default,
  // whatever an operator saves through the Policy Console.
  it("plan and create orders at the Shipping Rates read from the Ordering database through their own policy runtime", async () => {
    // The policy cache ages by the wall clock; a frozen clock keeps both operations inside one read.
    vi.useFakeTimers({ toFake: ["Date"] });
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    composition.eventStore = eventStore;
    const db = orderingDatabase();
    const { orders, policies, projectors } = createOrderingServices(db as never, {
      inventoryCleanupAuthority: { kind: "not-mounted" },
    });
    // The policy console writes through, and the projection invalidates, this one policy runtime.
    const resolvePolicy = vi.spyOn(policies, "resolvePolicy");
    const checkoutParams = {
      buyerAccountId: context.audit.forAccountId,
      checkoutSessionId: "chk_shipping_rates_wiring",
      sourceType: "cart-checkout" as const,
      shippingOption: "standard" as const,
      shippingAddress,
      lines: [
        {
          listingId: null,
          cartLineId: "cli_1",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
        },
      ],
    };

    const preview = await orders.previewCheckoutFulfillment(checkoutParams);

    expect(preview.totals).toMatchObject({ shippingAmount: "7.20", totalAmount: "27.20" });
    expect(resolvePolicy.mock.calls).toEqual([[shippingRatesPolicy]]);

    const created = await orders.createOrdersFromCheckout(
      { ...checkoutParams, fulfillmentPreviewRevision: preview.revision },
      context,
    );

    expect(created.orderIds).toHaveLength(1);
    expect(readAllEvents().filter((event) => event.eventType === "ordering.order.created")).toMatchObject([
      {
        payload: {
          shippingBaseAmount: "8.00",
          shippingChargeAmount: "7.20",
          totalAmount: "27.20",
          commercialTermsSnapshot: { shippingRates: savedRates },
        },
      },
    ]);
    // One resolution per operation, both served from the one read this process made.
    expect(resolvePolicy.mock.calls).toEqual([[shippingRatesPolicy], [shippingRatesPolicy]]);
    expect(
      db.query.mock.calls.filter(
        ([sql, params]) => sql.includes("FROM platform_policy_documents") && params?.includes(policyKey),
      ),
    ).toHaveLength(1);
    expect(projectors.map((projector) => projector.projectionName)).toContain("platform-policy-document-projection");
    expect(projectors).toEqual(expect.arrayContaining([...policies.projectors]));
  });

  // Without the name, a Policy Console write's commit receipt names a source no Ordering subscription answers to.
  it("write a Shipping Rates revision under the Ordering commit source", async () => {
    const { eventStore } = createInMemoryEventStore();
    composition.eventStore = eventStore;
    // An Ordering database holding no policy document yet.
    const query = async () => ({ rows: [], rowCount: 0 });
    const { policies } = createOrderingServices(
      { connect: async () => ({ query, release: () => {} }), query } as never,
      {
        inventoryCleanupAuthority: { kind: "not-mounted" },
      },
    );

    const sources = await runWithEventCommitMetadata(async () => {
      await policies.createPolicyDocument(
        shippingRatesPolicy,
        {
          status: "active",
          value: savedRates,
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          effectiveUntil: null,
          actorUserId: context.audit.performedByUserId,
        },
        context,
      );
      return getEventCommitMetadata().sources.map((source) => source.sourceContextName);
    });

    expect(sources).toEqual(["ordering"]);
  });
});
