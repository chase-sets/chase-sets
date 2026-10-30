import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { module as marketplaceModule } from "../../../index";
import { createMarketplaceOfferRuntime } from "./runtime";
import { createBuyerOfferPolicyRuntime } from "../../offer-policy/api/runtime";
import { createMarketplaceAttempt, hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";
import { offerAttemptResultSchema } from "./attempt-result";
import { readMarketplaceRecoveryHistory } from "../../mutation-recovery/domain/history";
import { createMarketplaceOfferMcpHandlers } from "./mcp";
import { marketplaceOfferCanonicalRequest } from "../../mutation-recovery/domain/contracts";

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Offer attempt DB proof.");
const dbDescribe = url ? describe : describe.skip;
const buyer: EventStoreContext = {
  tenantId: "tnt_marketplace",
  audit: { performedByUserId: "usr_buyer", forAccountId: "acc_buyer" },
};
const seller: EventStoreContext = { ...buyer, audit: { performedByUserId: "usr_seller", forAccountId: "acc_seller" } };
const submission = {
  attemptId: "submit_attempt_identity_0001",
  buyerAccountId: "acc_buyer" as const,
  catalogItemId: "cat_one",
  productId: "cat_one::",
  itemTitle: "Item",
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  shippingDestinationSnapshot: {
    name: "Buyer",
    line1: "1 Main",
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
  },
  priceAmount: "10.00",
  priceCurrencyCode: "USD",
  quantityRequested: 1,
};

dbDescribe("Offer attempt first results on PostgreSQL", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;
  let store: EventStore;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(url!, ["marketplace"], "marketplace_offer_attempts");
    await ensureMultiContextTestDatabases(url!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
    store = createPostgresEventStore({ pool: pools.marketplace });
    await pools.marketplace.query(
      "INSERT INTO marketplace_catalog_items(catalog_item_id,title,status) VALUES ('cat_one','Item','active')",
    );
    await pools.marketplace.query(
      `INSERT INTO marketplace_account_pages (account_id, display_name, status)
       VALUES ('acc_buyer', 'Buyer', 'active'), ('acc_seller', 'Seller', 'active')`,
    );
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function runtime(eventStore = store) {
    return createMarketplaceOfferRuntime({
      eventStore,
      db: pools.marketplace,
      checkpointStore: createPostgresProjectionStore({ db: pools.marketplace }),
      commercialTermsResolver: createNoopCommercialTermsResolver(),
      listingEvidencePolicyEvaluator: {
        evaluate: async () => ({
          schemaVersion: 1,
          policyId: null,
          policyVersion: null,
          policyHash: "compiled",
          matchedRuleIds: [],
          requirements: {
            minimumPhotoCount: 0,
            requiredSlots: [],
            sellerTrustRequirements: [],
            buyerAcknowledgment: "none",
          },
          effectiveInterval: { from: "2026-01-01T00:00:00.000Z", until: null },
          explanationCodes: [],
        }),
      },
    });
  }
  async function seedMatch() {
    const offers = runtime();
    const result = await offers.submitOffer({ ...submission, offerId: "off_one" }, buyer);
    await pools.marketplace
      .query(`INSERT INTO marketplace_offer_pages(offer_id,buyer_account_id,catalog_catalog_item_id,product_id,item_title,price_amount,price_currency_code,last_stream_version,quantity_requested,status)
      VALUES ('off_one','acc_buyer','cat_one','cat_one::','Item',10,'USD',1,1,'submitted')`);
    await pools.marketplace
      .query(`INSERT INTO marketplace_supply_items(item_id,account_id,catalog_catalog_item_id,product_id,storage_location_id,total_quantity)
      VALUES ('inv_one','acc_seller','cat_one','cat_one::','loc_one',10)`);
    await pools.marketplace
      .query(`INSERT INTO marketplace_listing_pages(listing_id,account_id,inventory_item_id,catalog_catalog_item_id,product_id,price_amount,price_currency_code,listing_stream_version,marketplace_sales_fee_unit_amount,seller_net_unit_amount,fee_quote_fingerprint,quantity_cap,status)
      VALUES ('lst_one','acc_seller','inv_one','cat_one','cat_one::',10,'USD',2,0,10,'fixture',10,'active')`);
    await store.appendToStream({
      streamId: "marketplace.listing-lst_one",
      expectedVersion: "no_stream",
      context: seller,
      events: [
        {
          eventType: "marketplace.listing.created",
          payload: {
            listingId: "lst_one",
            accountId: "acc_seller",
            inventoryItemId: "inv_one",
            catalogItemId: "cat_one",
            productId: "cat_one::",
            itemTitle: "Item",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            productMeasureSnapshot: null,
            gradedCard: null,
            storageLocationName: "Warehouse",
            shipFromCode: "CHI",
            shipFromAddress: null,
            priceAmount: "10.00",
            priceCurrencyCode: "USD",
            marketplaceSalesFeeUnitAmount: "0.00",
            sellerNetUnitAmount: "10.00",
            shippingAllowancePercentageBps: 500,
            termsScheduleId: null,
            termsAgreementId: null,
            termsResolvedAt: "2026-01-01T00:00:00.000Z",
            feeQuoteFingerprint: "fixture",
            feeLocks: [],
            quantityCap: 10,
            purchaseLimits: { maxUnitsPerOrder: null, maxUnitsPerDay: null, maxUnitsPerCustomerAccount: null },
            evidenceRequirements: null,
            evidence: [],
          },
        },
        { eventType: "marketplace.listing.published", payload: { listingId: "lst_one" } },
      ],
    });
    return { offers, result };
  }

  it.each(["selected", "match"])(
    "races four streams and replays the first %s acceptance after commit-then-loss with zero appends",
    async (keyKind) => {
      const { offers } = await seedMatch();
      const quote = await offers.previewOfferAcceptanceTerms({
        offerId: "off_one",
        sellerAccountId: "acc_seller",
        listingId: "lst_one",
      });
      const params = {
        offerId: "off_one" as const,
        sellerAccountId: "acc_seller" as const,
        listingId: "lst_one",
        feeQuoteFingerprint: quote.fee_quote_fingerprint,
        sourceActionKey: `sell-confirm:confirmation:line:${keyKind}:off_one`,
      };
      const append = vi.spyOn(store, "appendToStreams");
      const results = await Promise.allSettled([
        offers.acceptOffer(params, seller).then(() => {
          throw new TypeError("response lost after committed acceptance");
        }),
        offers.acceptOffer(params, seller),
      ]);
      const attemptStream = append.mock.calls[0]![0].at(-1)!.streamId;
      expect(results[0]).toMatchObject({
        status: "rejected",
        reason: { message: "response lost after committed acceptance" },
      });
      expect(results[1].status).toBe("fulfilled");
      if (results[1].status !== "fulfilled") throw results[1].reason;
      const first = results[1].value;
      expect(append.mock.calls[0]![0]).toHaveLength(4);
      expect(
        (await store.readStream({ streamId: "marketplace.offer-off_one" })).filter(
          (event) => event.eventType === "marketplace.offer.accepted",
        ),
      ).toHaveLength(1);
      append.mockClear();
      expect(await runtime().acceptOffer(params, seller)).toEqual(first);
      expect(append).not.toHaveBeenCalled();
      for (const changed of [
        { offerId: "off_other" as const },
        { listingId: "lst_other" },
        { acceptanceBatchId: "changed", acceptanceBatchSize: 2 },
        { feeQuoteFingerprint: "changed" },
        { sellerAccountId: "acc_other" as const },
      ]) {
        await expect(
          runtime().acceptOffer(
            { ...params, ...changed },
            changed.sellerAccountId
              ? { ...seller, audit: { ...seller.audit, forAccountId: changed.sellerAccountId } }
              : seller,
          ),
        ).rejects.toMatchObject({ code: "attempt_conflict" });
      }
      expect(append).not.toHaveBeenCalled();
      expect(JSON.stringify(await store.readStream({ streamId: attemptStream }))).not.toContain(params.sourceActionKey);
    },
  );

  it.each(["submit", "counter", "update-price", "decline", "policy"])(
    "replays %s first results after response loss and rejects changed hashes",
    async (kind) => {
      const { offers } = await seedMatch();
      let command: () => Promise<unknown>;
      let changed: () => Promise<unknown>;
      if (kind === "submit" || kind === "counter") {
        if (kind === "counter") {
          const params = {
            ...submission,
            attemptId: "counter_retained_attempt_001",
            counteredOfferId: "off_one",
            offerId: undefined,
          };
          const args = {
            ...params,
            accountId: "acc_buyer",
            requestHash: hashMarketplaceRequest(marketplaceOfferCanonicalRequest("offer.submit", params)),
          };
          const tool = createMarketplaceOfferMcpHandlers(offers).toolHandlers["marketplace.counter-offer"]!;
          const request = {
            actor: {
              sessionId: "ses_buyer",
              tenantId: buyer.tenantId,
              userId: buyer.audit.performedByUserId,
              accountId: buyer.audit.forAccountId,
              membershipId: "mem_buyer",
              roleKey: "owner",
              permissions: ["offers.manage"],
            },
            tool: null as never,
            arguments: args,
            request: new Request("http://localhost/mcp"),
            protocol: { protocolVersion: "2025-06-18", stateless: false, clientInfo: null, clientCapabilities: null },
          };
          command = async () => tool(request);
          changed = async () => tool({ ...request, arguments: { ...args, priceAmount: "11.00" } });
        } else {
          const params = { ...submission, attemptId: `${kind}_retained_attempt_00001` };
          command = () => offers.submitOffer(params, buyer);
          changed = () => offers.submitOffer({ ...params, priceAmount: "11.00" }, buyer);
        }
      } else if (kind === "update-price") {
        const params = {
          attemptId: "price_retained_attempt_00001",
          offerId: "off_one" as const,
          buyerAccountId: "acc_buyer" as const,
          priceAmount: "11.00",
          priceCurrencyCode: "USD",
        };
        command = () => offers.updateOfferPrice(params, buyer);
        changed = () => offers.updateOfferPrice({ ...params, priceAmount: "12.00" }, buyer);
      } else if (kind === "decline") {
        const params = {
          attemptId: "decline_retained_attempt_01",
          offerId: "off_one" as const,
          sellerAccountId: "acc_seller" as const,
        };
        command = () => offers.declineOfferMatch(params, seller);
        changed = () => offers.declineOfferMatch({ ...params, requestHash: "f".repeat(64) }, seller);
      } else {
        const policies = createBuyerOfferPolicyRuntime({ eventStore: store, db: pools.marketplace });
        const params = {
          type: "CreateBuyerOfferPolicy" as const,
          operationId: "create",
          attemptId: "policy_retained_attempt_001",
          expectedVersion: 0,
        };
        command = () => policies.execute("bop_one", params, buyer);
        changed = () => policies.execute("bop_one", { ...params, expectedVersion: 1 }, buyer);
      }
      let first: unknown;
      await expect(
        command().then((result) => {
          first = result;
          throw new TypeError("response lost after committed command");
        }),
      ).rejects.toThrow("response lost");
      const append = vi.spyOn(store, "appendToStreams");
      expect(await command()).toEqual(first);
      expect(append).not.toHaveBeenCalled();
      await expect(changed()).rejects.toMatchObject({ code: "attempt_conflict" });
      expect(append).not.toHaveBeenCalled();
    },
  );

  it.each([501, 10_000, 10_001])("validates the complete PostgreSQL history bound at %i facts", async (count) => {
    await runtime().submitOffer({ ...submission, offerId: "off_bound" }, buyer);
    const streamId = "marketplace.offer-off_bound";
    for (let version = 1; version < count; version += 500) {
      await store.appendToStream({
        streamId,
        expectedVersion: version,
        context: buyer,
        events: Array.from({ length: Math.min(500, count - version) }, () => ({
          eventType: "marketplace.offer.price-updated",
          payload: {
            offerId: "off_bound",
            buyerAccountId: "acc_buyer",
            priceAmount: "10.00",
            priceCurrencyCode: "USD",
          },
        })),
      });
    }
    const append = vi.spyOn(store, "appendToStreams");
    const result = await readMarketplaceRecoveryHistory(store, streamId, 0, (sum) => sum + 1);
    expect(result).toEqual(
      count <= 10_000 ? { complete: true, state: count } : { complete: false, reason: "history-incomplete" },
    );
    if (count > 10_000) {
      await expect(
        runtime().updateOfferPrice(
          {
            offerId: "off_bound",
            buyerAccountId: "acc_buyer",
            attemptId: "history_bound_attempt_001",
            priceAmount: "11.00",
            priceCurrencyCode: "USD",
          },
          buyer,
        ),
      ).rejects.toMatchObject({ code: "history_incomplete" });
    }
    expect(append).not.toHaveBeenCalled();
  });

  it.each(["gap", "malformed", "loop", "poison"])(
    "refuses %s PostgreSQL history with zero command appends",
    async (kind) => {
      await runtime().submitOffer({ ...submission, offerId: "off_bound" }, buyer);
      if (kind === "poison")
        await store.appendToStream({
          streamId: "marketplace.offer-off_bound",
          expectedVersion: 1,
          context: buyer,
          events: [{ eventType: "marketplace.offer.price-updated", payload: { priceAmount: "poison" } }],
        });
      const readStream: EventStore["readStream"] = async (input) => {
        const events = await store.readStream(input);
        if (input.streamId !== "marketplace.offer-off_bound" || kind === "poison") return events;
        return events.map((event) => ({
          ...event,
          streamVersion: kind === "gap" ? event.streamVersion + 1 : kind === "malformed" ? NaN : 0,
        }));
      };
      const append = vi.spyOn(store, "appendToStreams");
      await expect(
        runtime({ ...store, readStream }).updateOfferPrice(
          {
            offerId: "off_bound",
            buyerAccountId: "acc_buyer",
            attemptId: "history_poison_attempt_001",
            priceAmount: "11.00",
            priceCurrencyCode: "USD",
          },
          buyer,
        ),
      ).rejects.toMatchObject({ code: "history_incomplete" });
      expect(append).not.toHaveBeenCalled();
    },
  );

  it("day-after retained committed, conflict, failed-safe and ambiguous states append nothing", async () => {
    const first = await runtime().submitOffer(submission, buyer);
    const attempt = createMarketplaceAttempt(
      store,
      {
        attemptId: "ambiguous_retained_attempt_1",
        mutationKind: "offer.submit",
        accountId: "acc_buyer",
        target: { kind: "product", id: submission.productId },
        request: {},
      },
      offerAttemptResultSchema,
    );
    await store.appendToStream({
      streamId: `marketplace.offer-attempt-v1-${attempt.binding.attemptKeyFingerprint}`,
      expectedVersion: "no_stream",
      context: buyer,
      events: [{ eventType: "poisoned", payload: {} }],
    });
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(tomorrow);
    const append = vi.spyOn(store, "appendToStreams");
    expect(await runtime().submitOffer(submission, buyer)).toEqual(first);
    await expect(runtime().submitOffer({ ...submission, priceAmount: "11.00" }, buyer)).rejects.toMatchObject({
      code: "attempt_conflict",
    });
    await expect(runtime().submitOffer({ ...submission, attemptId: "invalid" }, buyer)).rejects.toMatchObject({
      code: "invalid_attempt",
    });
    await expect(
      runtime().submitOffer({ ...submission, attemptId: "ambiguous_retained_attempt_1" }, buyer),
    ).rejects.toMatchObject({ code: "history_incomplete" });
    expect(append).not.toHaveBeenCalled();
  });
});
