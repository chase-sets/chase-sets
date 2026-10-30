import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { AppendToStreamsResult, EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { createMarketplaceOfferRuntime } from "./runtime";
import { MarketplaceOfferLifecycleClosedError, type MarketplaceOfferLifecycleAdmission } from "./lifecycle-admission";
import { MarketplaceOfferAbuseControlError } from "../domain/offer-abuse-policy";
import { Hono } from "hono";
import type { MarketplaceApiEnv } from "../../../api";
import { createAccountSubmittedOfferRoutes } from "./route";
import { createMarketplaceOfferMcpHandlers } from "./mcp";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import { getMutationResultCommandReceipt } from "@chase-sets/http/responses";
import { hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";
import { createMarketplaceMutationLookup } from "../../mutation-recovery/api/lookup";
import { marketplaceOfferCanonicalRequest } from "../../mutation-recovery/domain/contracts";

const acceptedOfferMatch = {
  offer_id: "off_1",
  buyer_account_id: "acc_buyer",
  account_status: "active",
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
  it("refuses Offer acceptance for channel-only drafts even when projections claim active supply, with zero events", async () => {
    const context = {
      tenantId: "tnt_marketplace" as never,
      audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
    };
    const legacy = createInMemoryEventStore().eventStore;
    await seedActiveListing(legacy, context);
    const original = (await legacy.readStream({ streamId: "marketplace.listing-lst_1" }))[0]!.payload;
    const { eventStore } = createInMemoryEventStore();
    await eventStore.appendToStream({
      streamId: "marketplace.listing-lst_1",
      expectedVersion: 0,
      context,
      events: [
        {
          eventType: "marketplace.listing.created",
          payload: {
            ...original,
            schemaVersion: 2,
            publicationScope: "channel-only",
            nativeVisibility: "disabled",
            nativeFeeState: "not-enrolled",
            marketplaceSalesFeeUnitAmount: null,
            sellerNetUnitAmount: null,
            shippingAllowancePercentageBps: 0,
            termsScheduleId: null,
            termsAgreementId: null,
            termsResolvedAt: null,
            feeQuoteFingerprint: null,
            shipFromAddress: {
              name: "Seller",
              company: null,
              line1: "1 Main",
              line2: null,
              city: "Austin",
              state: "TX",
              postalCode: "78701",
              country: "US",
              phone: null,
              email: null,
            },
          },
        },
      ],
    });
    const resolveListingTerms = vi.fn(() => {
      throw new Error("Channel-only must not quote Terms");
    });
    const services = createMarketplaceOfferRuntime({
      eventStore,
      db: { query: vi.fn(async () => ({ rows: [acceptedOfferMatch] })) },
      checkpointStore: {} as never,
      commercialTermsResolver: { resolveListingTerms } as never,
    });
    await services.commandHandler({
      streamId: "marketplace.offer-off_1",
      context,
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
    });
    const before = await eventStore.readAll();
    await expect(
      services.acceptOffer(
        {
          sourceActionKey: "channel_only_accept_identity",
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
          listingId: "lst_1",
          feeQuoteFingerprint: "quote",
        },
        context,
      ),
    ).rejects.toThrow("eligible");
    expect(await eventStore.readAll()).toEqual(before);
    expect(resolveListingTerms).not.toHaveBeenCalled();
  });

  it.each(["commit", "failure", "conflict-recovery"] as const)(
    "records returned unmanaged acceptance events only for a successful %s",
    async (outcome) => {
      const memory = createInMemoryEventStore().eventStore;
      const append = vi.fn(async (inputs: readonly AppendToStreamInput[]) => {
        const acceptance = inputs.some((input) =>
          input.events.some((event) => event.eventType === "marketplace.offer.accepted"),
        );
        if (outcome === "failure" && acceptance) throw new Error("injected append failure");
        const results = await memory.appendToStreams!(inputs);
        if (outcome === "conflict-recovery" && acceptance)
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
            attemptId: "test_attempt_6241_identity",
            offerId: "off_1" as never,
            buyerAccountId: "acc_buyer" as never,
            priceAmount: "351.00",
            priceCurrencyCode: "USD",
          },
          { ...context, audit: { ...context.audit, forAccountId: "acc_buyer" as never } },
        );
        expect(getEventCommitMetadata().committedEvents.map((event) => event.eventType)).toEqual([
          "marketplace.offer.price-updated",
          "marketplace.mutation-attempt.completed",
        ]);
      });
      const params = {
        sourceActionKey: "test_accept_6722_identity",
        offerId: "off_1" as never,
        sellerAccountId: "acc_seller" as never,
        listingId: "lst_1",
        feeQuoteFingerprint: "351.00|17.50|332.50|500|sch_standard|",
      };
      await runWithEventCommitMetadata(async () => {
        const action = services.acceptOffer(params, {
          ...context,
          audit: { ...context.audit, forAccountId: params.sellerAccountId },
        });
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
            "marketplace.mutation-attempt.completed",
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
          expect(
            await services.acceptOffer(params, {
              ...context,
              audit: { ...context.audit, forAccountId: params.sellerAccountId },
            }),
          ).toMatchObject({ version: 3 });
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
        attemptId: "test_attempt_9545_identity",
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
      attemptId: "daily_cap_attempt_identity",
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
    const { accountId: _accountId, attemptId: _attemptId, ...request } = body;
    const mcpBody = {
      ...body,
      requestHash: hashMarketplaceRequest({
        ...request,
        itemSubtitle: null,
        productSummary: null,
        shippingDestinationSnapshot: {
          ...body.shippingDestinationSnapshot,
          company: null,
          line2: null,
          phone: null,
          email: null,
        },
      }),
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
          arguments: mcpBody,
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
        { attemptId: "test_attempt_15292_identity", offerId: "off_1" as never, sellerAccountId: "acc_seller" as never },
        { ...context, audit: { ...context.audit, forAccountId: "acc_seller" as never } },
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
            account_status: "active",
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
          sourceActionKey: "test_accept_18026_identity",
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
          listingId: "lst_1",
          feeQuoteFingerprint: "quote",
        },
        { ...context, audit: { ...context.audit, forAccountId: "acc_seller" as never } },
      ),
    ).rejects.toThrow("Seller does not have enough active supply to accept this offer.");
    expect(commercialTermsResolver).not.toHaveBeenCalled();
  });

  it("rejects a suspended buyer before managed pricing or allowance work", async () => {
    const { eventStore } = createInMemoryEventStore();
    await eventStore.appendToStream({
      streamId: "marketplace.offer-off_suspended",
      expectedVersion: 0,
      context: {
        tenantId: "tnt_marketplace" as never,
        audit: { performedByUserId: "usr_buyer" as never, forAccountId: "acc_buyer" as never },
      },
      events: [
        {
          eventType: "marketplace.offer.submitted",
          payload: {
            offerId: "off_suspended",
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
        },
      ],
    });
    const evaluateTargets = vi.fn(async () => []);
    const services = createMarketplaceOfferRuntime({
      eventStore,
      db: { query: vi.fn(async () => ({ rows: [{ account_status: "suspended" }] })) },
      checkpointStore: {} as never,
      managedOfferPricing: { evaluateTargets },
      commercialTermsResolver: {} as never,
    });
    const before = await eventStore.readAll();
    await expect(
      services.acceptOffer(
        {
          sourceActionKey: "suspended_buyer_accept_identity",
          offerId: "off_suspended" as never,
          sellerAccountId: "acc_seller" as never,
          listingId: "lst_1",
          feeQuoteFingerprint: "x",
        },
        {
          tenantId: "tnt_marketplace",
          audit: { performedByUserId: "usr_seller", forAccountId: "acc_seller" },
        } as never,
      ),
    ).rejects.toMatchObject({ code: "offer_not_open" });
    expect(evaluateTargets).not.toHaveBeenCalled();
    expect(await eventStore.readAll()).toEqual(before);
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
          sourceActionKey: "test_accept_19806_identity",
          offerId: "off_1" as never,
          sellerAccountId: "acc_same" as never,
          listingId: "lst_1",
          feeQuoteFingerprint: "quote",
        },
        { tenantId: "tnt_marketplace", audit: { performedByUserId: "usr_same", forAccountId: "acc_same" } } as never,
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
          sourceActionKey: "test_accept_21910_identity",
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
          listingId: "lst_1",
          feeQuoteFingerprint: "quote",
        },
        { ...context, audit: { ...context.audit, forAccountId: "acc_seller" as never } },
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
          attemptId: "test_attempt_23135_identity",
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
        { tenantId: "tnt_marketplace", audit: { performedByUserId: "usr_same", forAccountId: "acc_same" } } as never,
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
        sourceActionKey: "test_accept_25508_identity",
        offerId: "off_1" as never,
        sellerAccountId: "acc_seller" as never,
        listingId: "lst_1",
        feeQuoteFingerprint: "350.00|17.50|332.50|500|sch_standard|",
      },
      { ...context, audit: { ...context.audit, forAccountId: "acc_seller" as never } },
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
        sourceActionKey: "test_accept_26589_identity",
        offerId: "off_1" as never,
        sellerAccountId: "acc_seller" as never,
        listingId: "lst_1",
        feeQuoteFingerprint: "350.00|17.50|332.50|500|sch_standard|",
      },
      { ...context, audit: { ...context.audit, forAccountId: "acc_seller" as never } },
    );

    expect(first).toMatchObject({ offerId: "off_1", listingId: "lst_1", inventoryItemId: "inv_1", version: 2 });
    expect(retry).toEqual(first);
    expect(first.listingEvidenceSnapshot.snapshotHash).toMatch(/^sha256:/);
    await expect(
      services.acceptOffer(
        {
          sourceActionKey: "test_accept_27079_identity",
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
          listingId: "lst_other",
          feeQuoteFingerprint: "350.00|17.50|332.50|500|sch_standard|",
        },
        { ...context, audit: { ...context.audit, forAccountId: "acc_seller" as never } },
      ),
    ).rejects.toMatchObject({ code: "offer_already_accepted" });
    expect(resolveListingTerms).toHaveBeenCalledTimes(1);
  });

  it("replays a committed acceptance after its buyer becomes inactive without re-deciding it, behind key, hash and actor fences", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = { query: vi.fn(async () => ({ rows: [acceptedOfferMatch] })) };
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
      listingEvidencePolicyEvaluator: { evaluate: vi.fn(async () => noEvidenceRequirementsEvaluation) },
    });
    const seller = {
      tenantId: "tnt_marketplace" as never,
      audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
    };
    await seedActiveListing(eventStore, seller);
    for (const offerId of ["off_1", "off_2"])
      await services.commandHandler({
        streamId: `marketplace.offer-${offerId}`,
        command: {
          type: "SubmitOffer",
          offerId,
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
        context: seller,
      } as never);
    const params = {
      sourceActionKey: "inactive_buyer_replay_identity",
      offerId: "off_1" as never,
      sellerAccountId: "acc_seller" as never,
      listingId: "lst_1",
      feeQuoteFingerprint: "350.00|17.50|332.50|500|sch_standard|",
    };
    const first = await services.acceptOffer(params, seller);
    expect(getMutationResultCommandReceipt(first)?.commitEventIds).toHaveLength(1);
    db.query.mockClear();
    db.query.mockResolvedValue({ rows: [{ ...acceptedOfferMatch, account_status: "suspended" }] });
    const committed = await eventStore.readAll();

    const replay = await services.acceptOffer(params, seller);
    expect(replay).toEqual(first);
    expect(getMutationResultCommandReceipt(replay)).toEqual(getMutationResultCommandReceipt(first));
    for (const [changed, context] of [
      [{ feeQuoteFingerprint: "changed" }, seller],
      [{ sellerAccountId: "acc_other" as never }, { ...seller, audit: { ...seller.audit, forAccountId: "acc_other" } }],
    ] as const)
      await expect(services.acceptOffer({ ...params, ...changed }, context as never)).rejects.toMatchObject({
        code: "attempt_conflict",
      });
    await expect(services.acceptOffer({ ...params, sourceActionKey: "" }, seller)).rejects.toMatchObject({
      code: "invalid_attempt",
    });
    expect(db.query).not.toHaveBeenCalled();
    await expect(
      services.acceptOffer(
        { ...params, sourceActionKey: "inactive_buyer_fresh_identity", offerId: "off_2" as never },
        seller,
      ),
    ).rejects.toMatchObject({ code: "offer_not_open" });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(await eventStore.readAll()).toEqual(committed);
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
          sourceActionKey: "test_accept_29146_identity",
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
          listingId: "lst_1",
          feeQuoteFingerprint: "unused",
        },
        { ...context, audit: { ...context.audit, forAccountId: "acc_seller" as never } },
      ),
    ).rejects.toMatchObject({ code: "listing_evidence_incomplete" });
    expect(listingEvidencePolicyEvaluator.evaluate).toHaveBeenCalledOnce();
    expect(resolveListingTerms).not.toHaveBeenCalled();
  });
});

describe("marketplace offer lifecycle runtime", () => {
  const buyerContext = {
    tenantId: "tnt_marketplace" as never,
    audit: { performedByUserId: "usr_buyer" as never, forAccountId: "acc_buyer" as never },
  };
  const fingerprint = "350.00|17.50|332.50|500|sch_standard|";

  const openAdmission: MarketplaceOfferLifecycleAdmission = { check: async () => ({ admitted: true }) };

  async function lifecycleServices(
    wrapAppend?: (
      append: NonNullable<EventStore["appendToStreams"]>,
      memory: EventStore,
    ) => NonNullable<EventStore["appendToStreams"]>,
    admission: MarketplaceOfferLifecycleAdmission | null = openAdmission,
  ) {
    const memory = createInMemoryEventStore().eventStore;
    const services = createMarketplaceOfferRuntime({
      ...(admission ? { offerLifecycleAdmission: admission } : {}),
      eventStore: wrapAppend ? { ...memory, appendToStreams: wrapAppend(memory.appendToStreams!, memory) } : memory,
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
    await seedActiveListing(memory, buyerContext);
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
      context: buyerContext,
    } as never);
    return { memory, services };
  }

  const change = (
    services: Awaited<ReturnType<typeof lifecycleServices>>["services"],
    action: "pause" | "resume" | "withdraw",
    buyerAccountId = "acc_buyer",
  ) =>
    services.changeOfferLifecycle(
      { offerId: "off_1" as never, buyerAccountId: buyerAccountId as never, action },
      buyerContext,
    );

  it("keeps Pause, Resume and Withdraw closed without a host admission and appends nothing", async () => {
    const { memory, services } = await lifecycleServices(undefined, null);
    for (const action of ["pause", "resume", "withdraw"] as const) {
      const refusal = change(services, action);
      await expect(refusal).rejects.toBeInstanceOf(MarketplaceOfferLifecycleClosedError);
      await expect(refusal).rejects.toMatchObject({
        code: "offer_lifecycle_closed",
        reason: "admission_not_configured",
      });
    }
    await expect(
      services.bulkChangeOfferLifecycle(
        { buyerAccountId: "acc_buyer" as never, action: "withdraw", offerIds: ["off_1" as never, "off_2" as never] },
        buyerContext,
      ),
    ).rejects.toBeInstanceOf(MarketplaceOfferLifecycleClosedError);
    expect((await memory.readStream({ streamId: "marketplace.offer-off_1" })).map((event) => event.eventType)).toEqual([
      "marketplace.offer.submitted",
    ]);
  });

  it("asks admission once per request and appends only after it opens", async () => {
    let admitted = false;
    const check = vi.fn(async () =>
      admitted ? ({ admitted: true } as const) : ({ admitted: false, reason: "worker_without_capability" } as const),
    );
    const { memory, services } = await lifecycleServices(undefined, { check });
    await expect(change(services, "pause")).rejects.toMatchObject({ reason: "worker_without_capability" });
    const bulk = () =>
      services.bulkChangeOfferLifecycle(
        { buyerAccountId: "acc_buyer" as never, action: "pause", offerIds: ["off_1" as never, "off_1" as never] },
        buyerContext,
      );
    await expect(bulk()).rejects.toBeInstanceOf(MarketplaceOfferLifecycleClosedError);
    expect(await memory.readStream({ streamId: "marketplace.offer-off_1" })).toHaveLength(1);
    admitted = true;
    check.mockClear();
    expect(await bulk()).toMatchObject([
      { outcome: "changed", status: "paused" },
      { outcome: "unchanged", status: "paused" },
    ]);
    expect(check).toHaveBeenCalledTimes(1);
    expect((await memory.readStream({ streamId: "marketplace.offer-off_1" })).at(-1)?.eventType).toBe(
      "marketplace.offer.paused",
    );
  });

  it("lets only the Offer's buyer pause, resume and withdraw, reporting each outcome", async () => {
    const { memory, services } = await lifecycleServices();
    await expect(change(services, "pause", "acc_other")).rejects.toMatchObject({ code: "not_found" });
    await expect(
      services.changeOfferLifecycle(
        { offerId: "off_missing" as never, buyerAccountId: "acc_buyer" as never, action: "pause" },
        buyerContext,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await change(services, "resume")).toMatchObject({ outcome: "unchanged", status: "submitted", version: 1 });
    expect(await change(services, "pause")).toMatchObject({ outcome: "changed", status: "paused", version: 2 });
    expect(await change(services, "pause")).toMatchObject({ outcome: "unchanged", status: "paused", version: 2 });
    expect(await change(services, "resume")).toMatchObject({ outcome: "changed", status: "submitted", version: 3 });
    expect(await change(services, "withdraw")).toMatchObject({ outcome: "changed", status: "withdrawn", version: 4 });
    await expect(change(services, "resume")).rejects.toMatchObject({ code: "offer_transition_rejected" });
    const events = await memory.readStream({ streamId: "marketplace.offer-off_1" });
    expect(events.map((event) => event.eventType)).toEqual([
      "marketplace.offer.submitted",
      "marketplace.offer.paused",
      "marketplace.offer.resumed",
      "marketplace.offer.withdrawn",
    ]);
    expect(events[1]!.payload).toMatchObject({ offerId: "off_1", buyerAccountId: "acc_buyer" });
  });

  it.each(["decision", "append"] as const)(
    "rejects a Pause as offer_transition_rejected when a Withdraw lands before its %s",
    async (window) => {
      const { memory, services } = await lifecycleServices();
      const withdraw = () =>
        memory.appendToStream({
          streamId: "marketplace.offer-off_1",
          expectedVersion: 1,
          context: buyerContext,
          events: [
            {
              eventType: "marketplace.offer.withdrawn",
              payload: { offerId: "off_1", buyerAccountId: "acc_buyer", at: "2026-10-14T00:00:00.000Z" },
            },
          ],
        });
      let reads = 0;
      const readStream = memory.readStream.bind(memory);
      const appendToStream = memory.appendToStream.bind(memory);
      vi.spyOn(memory, "readStream").mockImplementation(async (input) => {
        if (window === "decision" && input.streamId === "marketplace.offer-off_1" && ++reads === 2) await withdraw();
        return readStream(input);
      });
      vi.spyOn(memory, "appendToStream").mockImplementation(async (input) => {
        if (window === "append" && input.streamId === "marketplace.offer-off_1" && reads++ === 0) await withdraw();
        return appendToStream(input);
      });
      await expect(change(services, "pause")).rejects.toMatchObject({ code: "offer_transition_rejected" });
      expect((await readStream({ streamId: "marketplace.offer-off_1" })).map((event) => event.eventType)).toEqual([
        "marketplace.offer.submitted",
        "marketplace.offer.withdrawn",
      ]);
    },
  );

  it("reports the command result status when a paused Offer is re-priced", async () => {
    const { memory, services } = await lifecycleServices();
    await change(services, "pause");
    const params = {
      attemptId: "paused_price_attempt_identity_01",
      offerId: "off_1" as never,
      buyerAccountId: "acc_buyer" as never,
      priceAmount: "360.00",
      priceCurrencyCode: "USD",
    };
    const first = await services.updateOfferPrice(params, buyerContext);
    expect(first).toEqual({ offerId: "off_1", version: 3, status: "paused" });
    await change(services, "resume");
    const append = vi.spyOn(memory, "appendToStreams");
    expect(await services.updateOfferPrice(params, buyerContext)).toEqual(first);
    await expect(services.updateOfferPrice({ ...params, priceAmount: "361.00" }, buyerContext)).rejects.toMatchObject({
      code: "attempt_conflict",
    });
    const lookup = await createMarketplaceMutationLookup(memory)({
      attemptId: params.attemptId,
      accountId: "acc_buyer",
      mutationKind: "offer.update-price",
      target: { kind: "offer", id: "off_1" },
      requestHash: hashMarketplaceRequest(marketplaceOfferCanonicalRequest("offer.update-price", params)),
    });
    expect(lookup).toMatchObject({ ownerStatus: "committed", ownerReceipt: { id: "off_1", version: 3 } });
    expect(lookup).not.toHaveProperty("status");
    expect(append).not.toHaveBeenCalled();
    expect(await memory.readStream({ streamId: "marketplace.offer-off_1" })).toHaveLength(4);
  });

  it("rejects accepting a paused or withdrawn Offer as offer_not_open", async () => {
    const { services } = await lifecycleServices();
    const accept = () =>
      services.acceptOffer(
        {
          sourceActionKey: "paused_accept_attempt_identity_01",
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
          listingId: "lst_1",
          feeQuoteFingerprint: fingerprint,
        },
        { ...buyerContext, audit: { ...buyerContext.audit, forAccountId: "acc_seller" as never } },
      );
    await change(services, "pause");
    await expect(accept()).rejects.toMatchObject({ code: "offer_not_open", details: { status: "paused" } });
    await change(services, "withdraw");
    await expect(accept()).rejects.toMatchObject({ code: "offer_not_open", details: { status: "withdrawn" } });
  });

  it("reports offer_not_open when the buyer pauses between the acceptance read and its atomic append", async () => {
    const { memory, services } = await lifecycleServices((append, store) => async (inputs) => {
      await store.appendToStream({
        streamId: "marketplace.offer-off_1",
        expectedVersion: 1,
        context: buyerContext,
        events: [
          {
            eventType: "marketplace.offer.paused",
            payload: { offerId: "off_1", buyerAccountId: "acc_buyer", at: "2026-10-14T00:00:00.000Z" },
          },
        ],
      });
      return append(inputs);
    });
    await expect(
      services.acceptOffer(
        {
          sourceActionKey: "racing_accept_attempt_identity_01",
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
          listingId: "lst_1",
          feeQuoteFingerprint: fingerprint,
        },
        { ...buyerContext, audit: { ...buyerContext.audit, forAccountId: "acc_seller" as never } },
      ),
    ).rejects.toMatchObject({ code: "offer_not_open", details: { status: "paused" } });
    expect((await memory.readStream({ streamId: "marketplace.offer-off_1" })).at(-1)?.eventType).toBe(
      "marketplace.offer.paused",
    );
  });

  it("checks every bulk row on its own and rejects another buyer's Offer as not_found", async () => {
    const { services } = await lifecycleServices();
    expect(
      await services.bulkChangeOfferLifecycle(
        { buyerAccountId: "acc_buyer" as never, action: "pause", offerIds: ["off_1", "off_1", "off_missing"] as never },
        buyerContext,
      ),
    ).toEqual([
      { offerId: "off_1", outcome: "changed", status: "paused", version: 2 },
      { offerId: "off_1", outcome: "unchanged", status: "paused", version: 2 },
      { offerId: "off_missing", outcome: "rejected", code: "not_found" },
    ]);
    await expect(
      services.bulkChangeOfferLifecycle(
        { buyerAccountId: "acc_buyer" as never, action: "pause", offerIds: [] },
        buyerContext,
      ),
    ).rejects.toThrow("Bulk Offer changes take 1 to 250 Offers.");
  });
});
