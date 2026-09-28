import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { module as marketplaceModule } from "../../../index";
import {
  decideMarketplaceOffer,
  initialMarketplaceOfferState,
  type MarketplaceOfferEvent,
} from "../../offers/domain/domain";
import { createBuyerOfferPolicyRuntime } from "../api/runtime";
import { context, terms } from "./fixtures";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("option-bearing Offer policy Preview on Postgres", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["marketplace"], "offer_policy_options");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("previews a submitted Offer after jsonb persists its two selected options", async () => {
    const pool = pools.marketplace;
    const store = createPostgresEventStore({ pool });
    const selectedOptions = [
      { dimensionId: "dim_form", optionId: "opt_regular" },
      { dimensionId: "dim_condition", optionId: "opt_excellent" },
    ];
    const submitted = decideMarketplaceOffer(initialMarketplaceOfferState, {
      type: "SubmitOffer",
      offerId: "off_one" as never,
      buyerAccountId: "acc_buyer" as never,
      catalogItemId: "cat_one" as never,
      productId: "cat_one::" as never,
      itemTitle: "Item",
      itemSubtitle: null,
      selectedOptions,
      productSummary: null,
      shippingDestinationSnapshot: {
        name: "Buyer",
        line1: "1 Main",
        line2: null,
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      quantityRequested: 2,
    });
    await store.appendToStream({
      streamId: "marketplace.offer-off_one",
      expectedVersion: 0,
      events: submitted.map(createPassthroughDomainEventCodec<MarketplaceOfferEvent>().encode),
      context,
    });
    const persisted = await store.readStream({ streamId: "marketplace.offer-off_one" });
    expect(Object.keys((persisted[0]?.payload.selectedOptions as Record<string, string>[])[0]!)).toEqual([
      "optionId",
      "dimensionId",
    ]);
    expect(persisted[0]?.payload.selectedOptions).toEqual([
      { optionId: "opt_regular", dimensionId: "dim_form" },
      { optionId: "opt_excellent", dimensionId: "dim_condition" },
    ]);
    const runtime = createBuyerOfferPolicyRuntime({
      eventStore: store,
      db: pool,
      enforcement: { assertInstalled() {} },
      managedOfferPricing: {
        evaluateTargets: async (requests) =>
          requests.map(() => ({
            status: "held" as const,
            reason: "market-price-unavailable",
            evidence: { marketPrice: null },
          })),
      },
    });
    await runtime.execute(
      "bop_one",
      { type: "CreateBuyerOfferPolicy", expectedVersion: 0, operationId: "create" },
      context,
    );
    const preview = await runtime.execute(
      "bop_one",
      {
        type: "PreviewBuyerOfferPolicy",
        expectedVersion: 1,
        operationId: "preview",
        terms: { ...terms, offers: [{ ...terms.offers[0]!, selectedOptions }] },
      },
      context,
    );
    expect(preview.preview?.terms.offers[0]?.selectedOptions).toEqual(selectedOptions);
    expect(preview.preview?.outcomes?.[0]?.result.status).toBe("held");
  });
});
