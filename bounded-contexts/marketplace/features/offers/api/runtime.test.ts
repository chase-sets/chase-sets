import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { AppendToStreamsResult, EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { createMarketplaceOfferRuntime } from "./runtime";
import { MarketplaceOfferAbuseControlError } from "../domain/offer-abuse-policy";
import { Hono } from "hono";
import type { MarketplaceApiEnv } from "../../../api";
import { createAccountSubmittedOfferRoutes } from "./route";
import { createMarketplaceOfferMcpHandlers } from "./mcp";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";

const acceptedOfferMatch = {
  offer_id: "off_1",
  buyer_account_id: "acc_buyer",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::",
  item_title: "Charizard",
  item_subtitle: null,
  selected_options: [],
  product_summary: null,
  shipping_destination_snapshot: {
    name: "Buyer",
    line1: "1 Main",
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
  },
  price_amount: "350.00",
  price_currency_code: "USD",
  last_stream_version: 2,
  quantity_requested: 1,
  status: "submitted",
  accepted_seller_account_id: null,
  accepted_at: null,
  created_at: "2026-03-31T00:00:00.000Z",
  updated_at: "2026-03-31T00:00:00.000Z",
  listing_id: "lst_1",
  listing_price_amount: "375.00",
  listing_price_currency_code: "USD",
  listing_stream_version: 3,
  listing_quantity_cap: 1,
  listing_visible_quantity: 1,
  offer_price_gap_amount: "25.00",
  offer_to_listing_price_bps: 9333,
  buyer_display_name: "Collector Account",
  seller_available_quantity: 1,
  seller_listing_availability_status: "available",
};

const noEvidenceRequirementsEvaluation = {
  policyId: "pol_evidence",
  policyVersion: 1,
  policyHash: "sha256:policy",
  matchedRuleIds: [],
  requirements: {
    minimumPhotoCount: 0,
    requiredSlots: [],
    sellerTrustRequirements: [],
    buyerAcknowledgment: "none",
  },
  effectiveInterval: { from: "2026-07-01T00:00:00.000Z", until: null },
  explanationCodes: [],
} as const;

async function seedActiveListing(eventStore: EventStore, context: AppendToStreamInput["context"]) {
  await eventStore.appendToStream({
    streamId: "marketplace.listing-lst_1",
    expectedVersion: 0,
    context,
    events: [
      {
        eventType: "marketplace.listing.created",
        payload: {
          listingId: "lst_1",
          accountId: "acc_seller",
          inventoryItemId: "inv_1",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::",
          itemLanguageCode: "en",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          productMeasureSnapshot: null,
          gradedCard: null,
          storageLocationName: "Warehouse",
          shipFromCode: "CHI",
          shipFromAddress: null,
          priceAmount: "375.00",
          priceCurrencyCode: "USD",
          marketplaceSalesFeeUnitAmount: "18.75",
          sellerNetUnitAmount: "356.25",
          shippingAllowancePercentageBps: 500,
          termsScheduleId: "sch_standard",
          termsAgreementId: null,
          termsResolvedAt: "2026-03-31T00:00:00.000Z",
          feeQuoteFingerprint: "listing-fee",
          feeLocks: [],
          quantityCap: 1,
          purchaseLimits: {
            maxUnitsPerOrder: null,
            maxUnitsPerDay: null,
            maxUnitsPerCustomerAccount: null,
          },
          evidenceRequirements: null,
          evidence: [],
        },
      },
      { eventType: "marketplace.listing.published", payload: {} },
    ],
  });
}

describe("marketplace offer runtime", () => {
  it.each(["commit", "failure", "conflict-recovery"] as const)(
    "records returned unmanaged acceptance events only for a successful %s",
    async (outcome) => {
      const memory = createInMemoryEventStore().eventStore;
      const append = vi.fn(async (inputs: readonly AppendToStreamInput[]) => {
        if (outcome === "failure") throw new Error("injected append failure");
        const results = await memory.appendToStreams!(inputs);
        if (outcome === "conflict-recovery")
          throw Object.assign(new Error("concurrent duplicate committed"), { code: "concurrency_conflict" });
        return results;
      });
      const services = createMarketplaceOfferRuntime({
        eventStore: { ...memory, appendToStreams: append },
        db: { query: vi.fn(async () => ({ rows: [acceptedOfferMatch] })) },
        checkpointStore: {} as never,
        commercialTermsResolver: {
          resolveListingTerms: async ({ amount }: { amount: string }) => ({
            accountType: "personal",
            basisAmount: amount,
            marketplaceSalesFeeUnitAmount: "17.50",
            sellerNetUnitAmount: "332.50",
            shippingAllowancePercentageBps: 500,
            scheduleId: "sch_standard",
            agreementId: null,
            resolvedAt: "2026-03-31T00:00:00.000Z",
          }),
        } as never,
        listingEvidencePolicyEvaluator: { evaluate: async () => noEvidenceRequirementsEvaluation },
      });
      const context = {
        tenantId: "tnt_marketplace" as never,
        audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
      };
      await seedActiveListing(memory, context);
      await services.commandHandler({
        streamId: "marketplace.offer-off_1",
        command: {
          type: "SubmitOffer",
          offerId: "off_1",
          buyerAccountId: "acc_buyer",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
          priceAmount: "350.00",
          priceCurrencyCode: "USD",
          quantityRequested: 1,
        },
        context,
      } as never);
      await runWithEventCommitMetadata(async () => {
        await services.updateOfferPrice(
          {
            offerId: "off_1" as never,
            buyerAccountId: "acc_buyer" as never,
            priceAmount: "351.00",
            priceCurrencyCode: "USD",
          },
          context,
        );
        expect(getEventCommitMetadata().committedEvents).toEqual(
          (await memory.readStream({ streamId: "marketplace.offer-off_1" })).slice(-1),
        );
      });
      const params = {
        offerId: "off_1" as never,
        sellerAccountId: "acc_seller" as never,
        listingId: "lst_1",
        feeQuoteFingerprint: "351.00|17.50|332.50|500|sch_standard|",
      };
      await runWithEventCommitMetadata(async () => {
        const action = services.acceptOffer(params, context);
        if (outcome === "failure") await expect(action).rejects.toThrow("injected append failure");
        else expect(await action).toMatchObject({ offerId: "off_1", listingId: "lst_1", version: 3 });
        if (outcome === "commit") {
          const results: readonly AppendToStreamsResult[] = await append.mock.results.at(-1)!.value;
          const returned = results.flatMap((batch) => batch.storedEvents);
          expect(returned.map((event) => event.eventType)).toEqual([
            "marketplace.offer.accepted",
            "marketplace.listing.evidence-requirements-refreshed",
            "marketplace.listing.offer-commitment-recorded",
            "marketplace.seller-listing-availability.commitment-checked",
          ]);
          const eventIds = returned.map((event) => String(event.eventId));
          const maxGlobalPosition = String(returned.at(-1)!.globalPosition);
          expect(getEventCommitMetadata()).toEqual({
            committedEvents: returned,
            eventIds,
            maxGlobalPosition,
            sources: [{ sourceContextName: "marketplace", eventIds, maxGlobalPosition }],
          });
        } else expect(getEventCommitMetadata().eventIds).toEqual([]);
      });
      if (outcome !== "failure")
        await runWithEventCommitMetadata(async () => {
          expect(await services.acceptOffer(params, context)).toMatchObject({ version: 3 });
          expect(getEventCommitMetadata().eventIds).toEqual([]);
        });
    },
  );

  function createSubmitOfferServices(db: { query: ReturnType<typeof vi.fn> }) {
    const { eventStore } = createInMemoryEventStore();
    return createMarketplaceOfferRuntime({
      db: db as never,
      eventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: {} as never,
    });
  }

  function activeCatalogItem() {
    return {
      catalog_item_id: "cat_charizard",
      title: "Charizard",
      subtitle: null,
      status: "active",
      product_schema: null,
    };
  }

  function activeListingGuard(overrides: Record<string, unknown> = {}) {
    return {
      listing_id: "lst_1",
      seller_account_id: "acc_seller",
      listing_price_amount: "100.00",
      listing_price_currency_code: "USD",
      listing_stream_version: 3,
      buyer_listing_daily_offer_count: "0",
      muted_at: null,
      lowball_cooldown_until: null,
      last_lowball_declined_amount: null,
      ...overrides,
    };
  }

  async function submitOfferWithDb(db: { query: ReturnType<typeof vi.fn> }, priceAmount = "80.00") {
    return createSubmitOfferServices(db).submitOffer(
      {
        buyerAccountId: "acc_buyer" as never,
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
        priceAmount,
        priceCurrencyCode: "USD",
        quantityRequested: 1,
      },
      {
        tenantId: "tnt_marketplace" as never,
        audit: {
          performedByUserId: "usr_buyer" as never,
          forAccountId: "acc_buyer" as never,
        },
      },
    );
  }

  it("enforces buyer daily submission caps before submitting an offer", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [activeCatalogItem()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "25" }] })
        .mockResolvedValueOnce({ rows: [activeListingGuard()] }),
    };

    await expect(submitOfferWithDb(db)).rejects.toMatchObject({
      code: "offer_daily_submission_cap_reached",
    } satisfies Partial<MarketplaceOfferAbuseControlError>);
  });

  it.each(["HTTP", "MCP"])("retains the daily cap through the real %s submission boundary", async (surface) => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [activeCatalogItem()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "25" }] }),
    };
    const services = createSubmitOfferServices(db);
    const actor = {
      sessionId: "ses_cap",
      tenantId: "tnt_marketplace",
      userId: "usr_cap",
      accountId: "acc_buyer",
      membershipId: "mbr_cap",
      roleKey: "owner",
      permissions: ["offers.manage"],
    };
    const body = {
      accountId: actor.accountId,
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::",
      itemTitle: "Charizard",
      selectedOptions: [],
      shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
      priceAmount: "1.00",
      priceCurrencyCode: "USD",
      quantityRequested: 1,
    };
    if (surface === "HTTP") {
      const app = new Hono<MarketplaceApiEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", actor);
        c.set("context", {
          tenantId: "tnt_marketplace" as never,
          audit: { performedByUserId: "usr_cap" as never, forAccountId: "acc_buyer" as never },
        });
        await next();
      });
      app.route("/account", createAccountSubmittedOfferRoutes(services));
      const response = await app.request("/account/offers/submitted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "offer_daily_submission_cap_reached" } });
    } else {
      const handler = createMarketplaceOfferMcpHandlers(services).toolHandlers["marketplace.submit-offer"]!;
      await expect(
        handler({
          actor,
          arguments: body,
          tool: null as never,
          request: new Request("http://marketplace.test/mcp"),
          protocol: { protocolVersion: "2025-06-18", stateless: false, clientInfo: null, clientCapabilities: null },
        }),
      ).rejects.toMatchObject({ code: "offer_daily_submission_cap_reached" });
    }
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it("submits $1 demand against $10, $14 and $20 asks without querying Listing controls", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [activeCatalogItem()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({
          rows: ["10.00", "14.00", "20.00"].map((listing_price_amount, index) =>
            activeListingGuard({ listing_price_amount, seller_account_id: `acc_seller_${index}` }),
          ),
        }),
    };
    await expect(submitOfferWithDb(db, "1.00")).resolves.toMatchObject({ offerId: expect.any(String) });
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query.mock.calls[2]?.[0]).toContain("COUNT(*)");
  });

  it("admits the fourth same-Product Offer after two declines, even at a lower price", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [activeCatalogItem()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "3" }] })
        .mockResolvedValueOnce({
          rows: [
            activeListingGuard({
              buyer_listing_daily_offer_count: "3",
              lowball_cooldown_until: "2099-01-01T00:00:00.000Z",
              last_lowball_declined_amount: "2.00",
            }),
          ],
        }),
    };
    await expect(submitOfferWithDb(db, "1.00")).resolves.toMatchObject({ offerId: expect.any(String) });
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it("records a private seller Decline for an Offer Match", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({ rows: [acceptedOfferMatch] })),
    };
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: {} as never,
    });
    const context = {
      tenantId: "tnt_marketplace" as never,
      audit: {
        performedByUserId: "usr_seller" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await expect(
      services.declineOfferMatch(
        {
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
        },
        context,
      ),
    ).resolves.toEqual({ offerId: "off_1", version: 1 });
  });

  it("keeps offer acceptance gated by matching active supply", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            offer_id: "off_1",
            buyer_account_id: "acc_buyer",
            catalog_catalog_item_id: "cat_charizard",
            product_id: "cat_charizard::",
            item_title: "Charizard",
            item_subtitle: null,
            selected_options: [],
            product_summary: null,
            shipping_destination_snapshot: {},
            price_amount: "350.00",
            quantity_requested: 1,
            status: "submitted",
            accepted_seller_account_id: null,
            accepted_at: null,
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
            listing_id: "lst_1",
            listing_price_amount: "375.00",
            listing_quantity_cap: 1,
            listing_visible_quantity: 0,
            offer_price_gap_amount: "25.00",
            offer_to_listing_price_bps: 9333,
            buyer_display_name: "Collector Account",
            seller_available_quantity: 0,
            seller_listing_availability_status: "available",
          },
        ],
      })),
    };
    const commercialTermsResolver = vi.fn(async () => {
      throw new Error("Terms should not be quoted when supply is missing.");
    });
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: commercialTermsResolver as never,
    });
    const context = {
      tenantId: "tnt_marketplace" as never,
      audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
    };
    await seedActiveListing(eventStore, context);
    await services.commandHandler({
      streamId: "marketplace.offer-off_1",
      command: {
        type: "SubmitOffer",
        offerId: "off_1" as never,
        buyerAccountId: "acc_buyer" as never,
        catalogItemId: "cat_charizard" as never,
        productId: "cat_charizard::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
        priceAmount: "350.00",
        priceCurrencyCode: "USD",
        quantityRequested: 1,
      },
      context,
    });

    await expect(
      services.acceptOffer(
        {
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
          listingId: "lst_1",
          feeQuoteFingerprint: "quote",
        },
        context,
      ),
    ).rejects.toThrow("Seller does not have enough active supply to accept this offer.");
    expect(commercialTermsResolver).not.toHaveBeenCalled();
  });

  it("rejects same-account offer acceptance before quoting terms", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({ rows: [{ ...acceptedOfferMatch, buyer_account_id: "acc_same" }] })),
    };
    const resolveListingTerms = vi.fn(async () => {
      throw new Error("Terms should not be quoted for self-dealing.");
    });
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: { resolveListingTerms } as never,
    });

    await services.commandHandler({
      streamId: "marketplace.offer-off_1",
      command: {
        type: "SubmitOffer",
        offerId: "off_1",
        buyerAccountId: "acc_same",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
        priceAmount: "350.00",
        priceCurrencyCode: "USD",
        quantityRequested: 1,
      },
      context: {
        tenantId: "tnt_marketplace" as never,
        audit: {
          performedByUserId: "usr_same" as never,
          forAccountId: "acc_same" as never,
        },
      },
    } as never);

    await expect(
      services.acceptOffer(
        {
          offerId: "off_1" as never,
          sellerAccountId: "acc_same" as never,
          listingId: "lst_1",
          feeQuoteFingerprint: "quote",
        },
        {} as never,
      ),
    ).rejects.toThrow("Accounts cannot accept their own offers.");
    expect(resolveListingTerms).not.toHaveBeenCalled();
  });

  it("rejects an exact Listing whose evidence does not satisfy the acceptance policy", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = { query: vi.fn(async () => ({ rows: [acceptedOfferMatch] })) };
    const resolveListingTerms = vi.fn(async () => {
      throw new Error("Terms should not be quoted for incomplete Listing Evidence.");
    });
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: { resolveListingTerms } as never,
      listingEvidencePolicyEvaluator: {
        evaluate: vi.fn(async () => ({
          ...noEvidenceRequirementsEvaluation,
          matchedRuleIds: ["minimum-evidence"],
          requirements: { ...noEvidenceRequirementsEvaluation.requirements, minimumPhotoCount: 1 },
        })),
      },
    });
    const context = {
      tenantId: "tnt_marketplace" as never,
      audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
    };
    await seedActiveListing(eventStore, context);
    await services.commandHandler({
      streamId: "marketplace.offer-off_1",
      command: {
        type: "SubmitOffer",
        offerId: "off_1" as never,
        buyerAccountId: "acc_buyer" as never,
        catalogItemId: "cat_charizard" as never,
        productId: "cat_charizard::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
        priceAmount: "350.00",
        priceCurrencyCode: "USD",
        quantityRequested: 1,
      },
      context,
    });

    await expect(
      services.acceptOffer(
        {
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
          listingId: "lst_1",
          feeQuoteFingerprint: "quote",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "listing_evidence_incomplete" });
    expect(resolveListingTerms).not.toHaveBeenCalled();
  });

  it("rejects offer submission when the buyer has an active listing for the product", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              catalog_item_id: "cat_charizard",
              title: "Charizard",
              subtitle: null,
              status: "active",
              product_schema: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ account_id: "acc_same" }] }),
    };
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore: {
        appendToStream: vi.fn(async () => []),
        readStream: vi.fn(async () => []),
        readAll: vi.fn(async () => []),
      } satisfies EventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: {} as never,
    });

    await expect(
      services.submitOffer(
        {
          buyerAccountId: "acc_same" as never,
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
          priceAmount: "350.00",
          priceCurrencyCode: "USD",
          quantityRequested: 1,
        },
        {} as never,
      ),
    ).rejects.toThrow("Accounts cannot offer on their own listings.");
  });

  it("treats repeated acceptance by the same seller as an idempotent retry", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({ rows: [acceptedOfferMatch] })),
    };
    const resolveListingTerms = vi.fn(async () => ({
      accountType: "personal",
      basisAmount: "350.00",
      marketplaceSalesFeeUnitAmount: "17.50",
      sellerNetUnitAmount: "332.50",
      shippingAllowancePercentageBps: 500,
      scheduleId: "sch_standard",
      agreementId: null,
      resolvedAt: "2026-03-31T00:00:00.000Z",
    }));
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: { resolveListingTerms } as never,
      listingEvidencePolicyEvaluator: {
        evaluate: vi.fn(async () => noEvidenceRequirementsEvaluation),
      },
    });
    const context = {
      tenantId: "tnt_marketplace" as never,
      audit: {
        performedByUserId: "usr_seller" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await seedActiveListing(eventStore, context);

    await services.commandHandler({
      streamId: "marketplace.offer-off_1",
      command: {
        type: "SubmitOffer",
        offerId: "off_1",
        buyerAccountId: "acc_buyer",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
        priceAmount: "350.00",
        priceCurrencyCode: "USD",
        quantityRequested: 1,
      },
      context,
    } as never);

    const first = await services.acceptOffer(
      {
        offerId: "off_1" as never,
        sellerAccountId: "acc_seller" as never,
        listingId: "lst_1",
        feeQuoteFingerprint: "350.00|17.50|332.50|500|sch_standard|",
      },
      context,
    );
    const listingEvents = await eventStore.readStream({ streamId: "marketplace.listing-lst_1" });
    expect(listingEvents.slice(-2).map((event) => event.eventType)).toEqual([
      "marketplace.listing.evidence-requirements-refreshed",
      "marketplace.listing.offer-commitment-recorded",
    ]);
    const offerEvents = await eventStore.readStream({ streamId: "marketplace.offer-off_1" });
    expect(offerEvents.at(-1)).toMatchObject({
      eventType: "marketplace.offer.accepted",
      payload: {
        listingId: "lst_1",
        inventoryItemId: "inv_1",
        listingVersion: 3,
        listingEvidencePolicyHash: "sha256:policy",
        listingEvidenceSnapshot: { snapshotHash: first.listingEvidenceSnapshot.snapshotHash },
      },
    });
    vi.mocked(db.query).mockResolvedValue({ rows: [] });
    const retry = await services.acceptOffer(
      {
        offerId: "off_1" as never,
        sellerAccountId: "acc_seller" as never,
        listingId: "lst_1",
        feeQuoteFingerprint: "350.00|17.50|332.50|500|sch_standard|",
      },
      context,
    );

    expect(first).toMatchObject({ offerId: "off_1", listingId: "lst_1", inventoryItemId: "inv_1", version: 2 });
    expect(retry).toEqual(first);
    expect(first.listingEvidenceSnapshot.snapshotHash).toMatch(/^sha256:/);
    await expect(
      services.acceptOffer(
        {
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
          listingId: "lst_other",
          feeQuoteFingerprint: "350.00|17.50|332.50|500|sch_standard|",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "offer_already_accepted" });
    expect(resolveListingTerms).toHaveBeenCalledTimes(1);
  });

  it("blocks offer acceptance when the resolved evidence coverage is incomplete", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({ rows: [acceptedOfferMatch] })),
    };
    const resolveListingTerms = vi.fn();
    const listingEvidencePolicyEvaluator = {
      evaluate: vi.fn(async () => ({
        ...noEvidenceRequirementsEvaluation,
        matchedRuleIds: ["minimum-evidence"],
        requirements: { ...noEvidenceRequirementsEvaluation.requirements, minimumPhotoCount: 1 },
      })),
    };
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: { resolveListingTerms } as never,
      listingEvidencePolicyEvaluator,
    });
    const context = {
      tenantId: "tnt_marketplace" as never,
      audit: {
        performedByUserId: "usr_seller" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await seedActiveListing(eventStore, context);
    await services.commandHandler({
      streamId: "marketplace.offer-off_1",
      command: {
        type: "SubmitOffer",
        offerId: "off_1",
        buyerAccountId: "acc_buyer",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
        priceAmount: "350.00",
        priceCurrencyCode: "USD",
        quantityRequested: 1,
      },
      context,
    } as never);

    await expect(
      services.acceptOffer(
        {
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
          listingId: "lst_1",
          feeQuoteFingerprint: "unused",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "listing_evidence_incomplete" });
    expect(listingEvidencePolicyEvaluator.evaluate).toHaveBeenCalledOnce();
    expect(resolveListingTerms).not.toHaveBeenCalled();
  });
});
