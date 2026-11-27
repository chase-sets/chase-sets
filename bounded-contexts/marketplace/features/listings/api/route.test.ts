import { sendListingCommandsWithFreshAttempts } from "../tests/listing-attempt-test-support";
import { MarketplaceListingDomainError } from "../domain/listing-error";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore, createInMemoryConfigurationConsumer } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createMarketplaceCommercialTermsResolver, type MarketplaceApiEnv } from "../../../api";
import { createAccountListingRoutes, createPublicListingRoutes } from "./route";
import { listingAttempt } from "./listing-attempt";
import { listingBatchStreamId, runListingBatch } from "./listing-batch";
import { createListingRecovery, listingRecoveryResult } from "./listing-recovery";
import type { ListingRecoveryReference } from "../ui/contracts";
import {
  createMarketplaceListingRuntime,
  MarketplaceListingEvidenceIncompleteError,
  type MarketplaceListingServices,
} from "./runtime";
import { decideMarketplaceListing, initialMarketplaceListingState, normalizePurchaseLimits } from "../domain/domain";
import type { AcceptedListingTargetPriceV1, ListingTargetPrincipal } from "./target-contracts";
import { createListingRequestExecutor, ListingRequestConflictError } from "./listing-request";

function buildApp(
  options: Readonly<{
    actor: MarketplaceApiEnv["Variables"]["actor"];
    services: MarketplaceListingServices;
  }>,
) {
  const app = sendListingCommandsWithFreshAttempts(new Hono<MarketplaceApiEnv>());

  app.use("*", async (c, next) => {
    c.set("actor", options.actor);
    c.set(
      "context",
      options.actor
        ? {
            tenantId: "tnt_identity" as never,
            audit: {
              performedByUserId: options.actor.userId as never,
              forAccountId: options.actor.accountId as never,
            },
          }
        : null,
    );
    await next();
  });

  app.route("/", createPublicListingRoutes(options.services));
  app.route("/account", createAccountListingRoutes(options.services));

  return app;
}

function createServices(): MarketplaceListingServices {
  return {
    acceptListingTargetPrice: vi.fn(async () => {
      throw new Error("not configured");
    }),
    activateListingForChannel: vi.fn(async () => {
      throw new Error("not configured");
    }),
    readAcceptedListingTargetPrices: vi.fn(async () => []),
    getListingPhotoJpeg: vi.fn(async () => null),
    createListing: vi.fn(async () => ({
      listingId: "lst_checkout_fallback" as never,
      version: 1,
      feeQuoteFingerprint: "12.00|0.60|11.40|cts_default|",
      state: initialMarketplaceListingState,
    })),
    createListingFromInventorySnapshot: vi.fn(async () => ({
      listingId: "lst_checkout_fallback" as never,
      version: 1,
      feeQuoteFingerprint: "12.00|0.60|11.40|cts_default|",
      state: initialMarketplaceListingState,
    })),
    previewPublicStandardListingTerms: vi.fn(async () => ({
      account_type: "personal",
      basis_amount: "20.00",
      marketplace_sales_fee_unit_amount: "1.95",
      seller_net_unit_amount: "18.05",
      shipping_allowance_percentage_bps: 500,
      source_kind: "public-standard-seller-terms",
      source_label: "Standard seller terms",
      schedule_label: "Personal Default",
      source_updated_at: "2026-04-17T00:00:00.000Z",
      resolved_at: "2026-04-17T00:00:00.000Z",
    })),
    createAnonymousListingDraftIntent: vi.fn(
      async (params: Parameters<MarketplaceListingServices["createAnonymousListingDraftIntent"]>[0]) => ({
        intent_id: "ldi_1",
        anonymous_owner_id: params.anonymousOwnerId,
        source_path: params.sourcePath,
        catalog_item_id: params.catalogItemId,
        product_id: params.productId,
        selected_options: params.selectedOptions,
        product_summary: params.productSummary ?? null,
        price_amount: params.priceAmount,
        price_currency_code: params.priceCurrencyCode,
        quantity_cap: params.quantityCap,
        max_units_per_order: params.purchaseLimits?.maxUnitsPerOrder ?? null,
        max_units_per_day: params.purchaseLimits?.maxUnitsPerDay ?? null,
        max_units_per_customer_account: params.purchaseLimits?.maxUnitsPerCustomerAccount ?? null,
        status: "active",
        claimed_account_id: null,
        claimed_at: null,
        expires_at: "2026-05-17T00:00:00.000Z",
        created_at: "2026-04-17T00:00:00.000Z",
        updated_at: "2026-04-17T00:00:00.000Z",
      }),
    ),
    getAnonymousListingDraftIntent: vi.fn(async () => null),
    claimAnonymousListingDraftIntent: vi.fn(
      async (params: Parameters<MarketplaceListingServices["claimAnonymousListingDraftIntent"]>[0]) => ({
        intent_id: params.intentId,
        anonymous_owner_id: params.anonymousOwnerId,
        source_path: "/items/charizard?market=sell",
        catalog_item_id: "cat_charizard",
        product_id: "cat_charizard::form:raw",
        selected_options: [{ dimensionId: "form", optionId: "raw" }],
        product_summary: "Form: Raw",
        price_amount: "20.00",
        price_currency_code: "USD",
        quantity_cap: 1,
        max_units_per_order: null,
        max_units_per_day: null,
        max_units_per_customer_account: null,
        status: "claimed",
        claimed_account_id: params.accountId,
        claimed_at: "2026-04-17T00:00:00.000Z",
        expires_at: "2026-05-17T00:00:00.000Z",
        created_at: "2026-04-17T00:00:00.000Z",
        updated_at: "2026-04-17T00:00:00.000Z",
      }),
    ),
    publishListing: vi.fn(async () => ({ listingId: "lst_1", version: 2 })),
    listSellerListingFeeHistory: vi.fn(async () => [
      {
        event_type: "marketplace.listing.published",
        stream_version: 2,
        price_amount: null,
        price_currency_code: null,
        quantity_cap: null,
        marketplace_sales_fee_unit_amount: "1.00",
        seller_net_unit_amount: "19.00",
        terms_schedule_id: "cts_default",
        terms_agreement_id: null,
        terms_resolved_at: "2026-04-17T00:00:00.000Z",
        fee_quote_fingerprint: "20.00|1.00|19.00|cts_default|",
        recorded_at: "2026-04-17T00:00:00.000Z",
        performed_by_user_id: "usr_seller",
      },
    ]),
    listSellerListings: vi.fn(async () => ({ items: [], total: 0 })),
    getSellerListingStatusCounts: vi.fn(async () => ({ active: 2, draft: 1, paused: 3, withdrawn: 4 })),
    getSellerListingAvailability: vi.fn(async () => ({
      account_id: "acc_seller",
      status: "available",
      disabled_reason_category: null,
      available_again_on: null,
      available_again_at: null,
      disabled_at: null,
      enabled_at: null,
      away_window_starts_at: null,
      away_window_ends_at: null,
      away_window_reason_category: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    })),
    disableSellerListingAvailability: vi.fn(async () => ({
      accountId: "acc_seller",
      version: 1,
      status: "unavailable",
    })),
    enableSellerListingAvailability: vi.fn(async () => ({
      accountId: "acc_seller",
      version: 2,
      status: "available",
    })),
    getSellerOrderCapacity: vi.fn(async () => ({
      account_id: "acc_seller",
      max_open_orders: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    })),
    setSellerOrderCapacity: vi.fn(async () => ({
      accountId: "acc_seller",
      version: 1,
      maxOpenOrders: 5,
    })),
    clearSellerOrderCapacity: vi.fn(async () => ({
      accountId: "acc_seller",
      version: 2,
      maxOpenOrders: null,
    })),
    scheduleSellerAwayWindow: vi.fn(async () => ({
      accountId: "acc_seller",
      version: 1,
    })),
    cancelScheduledAwayWindow: vi.fn(async () => ({
      accountId: "acc_seller",
      version: 2,
    })),
    sweepDueSellerAwayWindowStarts: vi.fn(async () => ({
      checked: 0,
      started: 0,
      skipped: 0,
    })),
    listSellerListingFeeLockReport: vi.fn(async () => ({
      items: [
        {
          listing_id: "lst_1",
          inventory_item_id: "inv_1",
          item_title: "Charizard",
          product_summary: "Condition: Near Mint",
          status: "active",
          price_amount: "20.00",
          quantity_cap: 1,
          marketplace_sales_fee_unit_amount: "1.00",
          seller_net_unit_amount: "19.00",
          terms_schedule_id: "cts_default",
          terms_agreement_id: null,
          terms_resolved_at: "2026-04-17T00:00:00.000Z",
          fee_quote_fingerprint: "20.00|1.00|19.00|cts_default|",
          created_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:00:00.000Z",
        },
      ],
      total: 1,
    })),
    listSellerInventoryItemSupply: vi.fn(async () => ({ items: [], total: 0 })),
    getInventoryItemSupply: vi.fn(async () => null),
    getListingEvidenceCoverage: vi.fn(async () => ({
      listingId: "lst_1",
      listingStatus: "active",
      evidence: [],
      policyHash: "sha256:policy",
      policyVersion: 1,
      requirements: {
        minimumPhotoCount: 1,
        requiredSlots: [],
        sellerTrustRequirements: [],
        buyerAcknowledgment: "none",
      },
      coverage: {
        complete: false,
        unmetCodes: ["min-photo-count-unmet"],
        slots: [],
        activePhotoCount: 0,
        minimumPhotoCount: 1,
      },
      updatedAt: "2026-07-13T00:00:00.000Z",
    })),
    getSellerListing: vi.fn(async () => null),
    getListingEvidenceReadiness: vi.fn(async () => ({
      policy: {
        policyId: "pol_1",
        policyVersion: 2,
        policyHash: "sha256:test",
        explanationCodes: ["configured-evidence"],
        effectiveInterval: { from: "2026-07-13T00:00:00.000Z", until: null },
      },
      requirements: {
        minimumPhotoCount: 1,
        requiredSlots: [],
        sellerTrustRequirements: [],
        buyerAcknowledgment: "none",
      },
      coverage: {
        complete: false,
        unmetCodes: ["min-photo-count-unmet"],
        slots: [],
        activePhotoCount: 0,
        minimumPhotoCount: 1,
      },
      nextActions: [
        {
          code: "min-photo-count-unmet",
          localeKey: "marketplace.features.listings.evidenceCoverage.min-photo-count-unmet",
          slotIds: [],
        },
      ],
      publicGallery: [],
    })),
    previewListingEvidenceReadiness: vi.fn(async () => ({
      policy: {
        policyId: null,
        policyVersion: null,
        policyHash: "sha256:test",
        explanationCodes: [],
        effectiveInterval: { from: null, until: null },
      },
      requirements: {
        minimumPhotoCount: 0,
        requiredSlots: [],
        sellerTrustRequirements: [],
        buyerAcknowledgment: "none",
      },
      coverage: {
        complete: true,
        unmetCodes: [],
        slots: [],
        activePhotoCount: 0,
        minimumPhotoCount: 0,
      },
      nextActions: [],
      publicGallery: [],
    })),
    addListingPhotos: vi.fn(async () => ({ listingId: "lst_1", version: 3 })),
    classifyListingPhoto: vi.fn(async () => ({ listingId: "lst_1", version: 4 })),
    replaceListingPhoto: vi.fn(async () => ({ listingId: "lst_1", version: 5 })),
    removeListingPhoto: vi.fn(async () => ({ listingId: "lst_1", version: 6 })),
    reorderListingPhotos: vi.fn(async () => ({ listingId: "lst_1", version: 7 })),
    updateListingPrice: vi.fn(async () => ({ listingId: "lst_1", version: 2 })),
    applyBulkListingPriceUpdates: vi.fn(async (params: { updates: readonly { listingId: string }[] }) =>
      params.updates.map((update) => ({ listingId: update.listingId, outcome: "applied" as const, version: 2 })),
    ),
    projectors: [],
  } as unknown as MarketplaceListingServices;
}

const sellerActor: MarketplaceApiEnv["Variables"]["actor"] = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_seller",
  accountId: "acc_seller",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["listings.view", "listings.manage"],
};

describe("owner-fenced target routes", () => {
  const accepted: AcceptedListingTargetPriceV1 = {
    schemaVersion: 1,
    accountId: "acc_seller",
    listingId: "lst_target",
    target: { kind: "channel-connection", connectionId: "connection" },
    priceAmount: "12.00",
    priceCurrencyCode: "USD",
    targetPriceRevision: 1,
    listingRevision: 2,
    acceptedByUserId: "usr_seller",
    acceptedAt: "2026-11-16T12:00:00.000Z",
    sourceEventId: "event",
    decision: { kind: "seller-reference" },
    connectionAuthority: {
      connectionId: "connection",
      providerKey: "test",
      environment: "sandbox",
      identityRevision: 1,
    },
  };
  const actor = { ...sellerActor!, sessionProvenance: "auth-session" as const };
  const request = {
    expectedListingVersion: 1,
    idempotencyKey: "target-request",
    target: accepted.target,
    priceAmount: accepted.priceAmount,
    priceCurrencyCode: accepted.priceCurrencyCode,
    expectedTargetPriceRevision: 0,
    decision: accepted.decision,
  };
  it.each([
    ["target-price", "initial-read"],
    ["activate-channel", "initial-read"],
    ["target-price", "lost-acknowledgement"],
    ["activate-channel", "lost-acknowledgement"],
  ])("returns retryable 503 for %s %s and replays the durable result after recovery", async (route, failure) => {
    const consumer = createInMemoryConfigurationConsumer({ storeId: "marketplace", incarnation: "consumer" });
    const memory = createInMemoryEventStore({ configurationEpoch: consumer });
    let unavailable = failure === "initial-read";
    const append = vi.fn(async (inputs: Parameters<NonNullable<typeof memory.eventStore.appendToStreams>>[0]) => {
      const result = await memory.eventStore.appendToStreams!(inputs);
      if (failure === "lost-acknowledgement") {
        unavailable = true;
        throw new Error("lost COMMIT acknowledgement");
      }
      return result;
    });
    const execute = createListingRequestExecutor({
      ...memory.eventStore,
      async readStream(input) {
        if (unavailable) throw new Error("request result unavailable");
        return memory.eventStore.readStream(input);
      },
      appendToStreams: append,
    });
    const result = {
      listingId: "lst_target",
      version: 2,
      state: initialMarketplaceListingState,
      acceptedTargetPrice: accepted,
    };
    const prepare = vi.fn(async () => ({
      result,
      evidence: [{ owner: "identity", key: "account/account", storeIncarnation: "identity", sealVersion: 1, epoch: 0 }],
      appends: [
        {
          streamId: "marketplace.listing-lst_target",
          expectedVersion: "no_stream" as const,
          context: {
            tenantId: "tnt_identity" as never,
            audit: { performedByUserId: actor.userId as never, forAccountId: actor.accountId as never },
          },
          configurationGrants: [
            {
              key: "account/account",
              sourceIncarnation: "identity",
              keyCreationEpoch: 0,
              epoch: 0,
              consumer: consumer.identity,
              topologyRevision: 1,
            },
          ],
          events: [{ eventType: "test.listing.changed", payload: {} }],
        },
      ],
    }));
    async function run(
      command: Record<string, unknown> & { accountId: string; idempotencyKey: string },
      context: EventStoreContext,
      principal: ListingTargetPrincipal,
    ) {
      return execute({
        accountId: command.accountId,
        idempotencyKey: command.idempotencyKey,
        command,
        context,
        principal,
        prepare,
        parseResult(value) {
          expect(value).toEqual(result);
          return result;
        },
      });
    }
    const services = createServices();
    vi.mocked(services.acceptListingTargetPrice).mockImplementation(run);
    vi.mocked(services.activateListingForChannel).mockImplementation(run);
    const app = buildApp({ actor, services });
    const send = () =>
      app.request(`/account/listings/lst_target/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "chase_sets_session=test-token" },
        body: JSON.stringify(
          route === "target-price"
            ? request
            : {
                expectedListingVersion: 1,
                idempotencyKey: "activate-request",
                connectionId: "connection",
                expectedTargetPriceRevision: 1,
                allocationRevision: 1,
              },
        ),
      });
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "request_indeterminate" } });
    expect(prepare).toHaveBeenCalledTimes(failure === "initial-read" ? 0 : 1);
    expect(memory.allEvents).toHaveLength(failure === "initial-read" ? 0 : 2);
    unavailable = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const recovered = await send();
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual(result);
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(memory.allEvents).toHaveLength(2);
  });
  it.each(["target-price", "activate-channel"])(
    "preserves proven conflicts and deterministic refusals for %s",
    async (route) => {
      const services = createServices();
      const app = buildApp({ actor, services });
      for (const error of [new ListingRequestConflictError(), new Error("domain refusal")]) {
        vi.mocked(services.acceptListingTargetPrice).mockRejectedValue(error);
        vi.mocked(services.activateListingForChannel).mockRejectedValue(error);
        const response = await app.request(`/account/listings/lst_target/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: "chase_sets_session=test-token" },
          body: JSON.stringify(
            route === "target-price"
              ? request
              : {
                  expectedListingVersion: 1,
                  idempotencyKey: "activate-request",
                  connectionId: "connection",
                  expectedTargetPriceRevision: 1,
                  allocationRevision: 1,
                },
          ),
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: {
            code:
              error instanceof ListingRequestConflictError
                ? "request_conflict"
                : route === "target-price"
                  ? "target_acceptance_refused"
                  : "channel_activation_refused",
          },
        });
      }
    },
  );
  it.each(["target-price", "activate-channel"])(
    "returns the exact committed %s snapshot with a poisoned projection",
    async (route) => {
      const services = createServices();
      const state = {
        ...initialMarketplaceListingState,
        listingId: "lst_target" as never,
        accountId: "acc_seller" as never,
        acceptedTargetPrices: { "channel-connection:connection": accepted },
      };
      const result = { listingId: "lst_target", version: 2, state };
      vi.mocked(services.acceptListingTargetPrice).mockResolvedValue({ ...result, acceptedTargetPrice: accepted });
      vi.mocked(services.activateListingForChannel).mockResolvedValue(result);
      vi.mocked(services.getSellerListing).mockRejectedValue(new Error("poisoned projection"));
      const app = buildApp({ actor, services });
      const response = await app.request(`/account/listings/lst_target/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "chase_sets_session=test-token" },
        body: JSON.stringify(
          route === "target-price"
            ? request
            : {
                expectedListingVersion: 1,
                idempotencyKey: "activate-request",
                connectionId: "connection",
                expectedTargetPriceRevision: 1,
                allocationRevision: 1,
              },
        ),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        route === "target-price" ? { ...result, acceptedTargetPrice: accepted } : result,
      );
      expect(services.getSellerListing).not.toHaveBeenCalled();
      const routes = app.routes.map((r) => `${r.method} ${r.path}`);
      const check = (rows: readonly string[]) => {
        if (
          !rows.includes("POST /account/listings/:id/target-price") ||
          !rows.includes("POST /account/listings/:id/activate-channel")
        )
          throw new Error("target route omitted");
      };
      check(routes);
      for (const required of ["POST /account/listings/:id/target-price", "POST /account/listings/:id/activate-channel"])
        expect(() => check(routes.filter((row) => row !== required))).toThrow("omitted");
    },
  );
  it("rejects an incomplete pair before calling the command and rejects synthetic Sessions", async () => {
    const services = createServices();
    const app = buildApp({ actor, services });
    const response = await app.request("/account/listings/lst_target/target-price", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "chase_sets_session=test-token" },
      body: JSON.stringify({ ...request, priceCurrencyCode: undefined }),
    });
    expect(response.status).toBe(400);
    expect(services.acceptListingTargetPrice).not.toHaveBeenCalled();
    const synthetic = buildApp({
      actor: { ...actor, sessionId: "guest:token", sessionProvenance: "guest-checkout" },
      services,
    });
    expect(
      (
        await synthetic.request("/account/listings/lst_target/target-price", {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: "chase_sets_session=test-token" },
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(401);
  });
});

describe("Listing batch recovery API", () => {
  const preparation = {
    intent: "bulk-pause-listings",
    idempotencyKey: "listing_batch_lookup_0000001",
    listingId: null,
    listingIds: ["lst_one"],
    fields: {},
  };
  const reference = {
    batchId: `${preparation.idempotencyKey}_bulk-pause-listings`,
    mutationKind: "listing.pause",
    bulk: true,
  } as const;
  const recoverPath = (reference: ListingRecoveryReference) =>
    `/account/listings/batch/${reference.batchId}?family=${reference.mutationKind}&bulk=${reference.bulk}`;
  const post = (body: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("accepts the command and returns only its opaque reference without executing it", async () => {
    const services = {
      ...createServices(),
      prepareListingRecovery: vi.fn(async () => ({ reference })),
      applyListingBatch: vi.fn(),
    };
    const response = await buildApp({ actor: sellerActor, services }).request(
      "/account/listings/batch/prepare",
      post(preparation),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reference });
    expect(services.prepareListingRecovery).toHaveBeenCalledWith(
      "acc_seller",
      preparation,
      expect.objectContaining({ audit: expect.objectContaining({ forAccountId: "acc_seller" }) }),
    );
    expect(services.applyListingBatch).not.toHaveBeenCalled();
  });

  it("rejects changed commands and families before appending, then commits and recovers the prepared command", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    const unused = () => {
      throw new Error("This in-memory test does not use a database or projection checkpoints.");
    };
    const db = { query: unused };
    const services = createMarketplaceListingRuntime({
      eventStore,
      db,
      checkpointStore: { loadCheckpoint: unused, saveCheckpoint: unused },
      commercialTermsResolver: createMarketplaceCommercialTermsResolver(db),
    });
    const app = buildApp({ actor: sellerActor, services });
    const prepared = await app.request(
      "/account/listings/batch/prepare",
      post({ ...preparation, intent: "set-order-capacity", listingIds: [], fields: { maxOpenOrders: "7" } }),
    );
    expect(prepared.status).toBe(200);
    const { reference }: { reference: ListingRecoveryReference } = await prepared.json();
    const idempotencyKey = reference.batchId;
    const setCapacity = (maxOpenOrders: number) =>
      app.request("/account/order-capacity", post({ idempotencyKey, maxOpenOrders }));
    expect(allEvents.map(({ eventType }) => eventType)).toEqual(["marketplace.listing-batch.recorded"]);
    for (const changed of [
      await setCapacity(9),
      await app.request("/account/listing-availability/disable", post({ idempotencyKey, reasonCategory: "travel" })),
    ]) {
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({ error: { code: "attempt_conflict" } });
    }
    expect(allEvents).toHaveLength(1);

    for (const original of [await setCapacity(7), await setCapacity(7)]) {
      expect(original.status).toBe(200);
      expect(await original.json()).toMatchObject({ version: 1, maxOpenOrders: 7 });
    }
    const recovered = await app.request(recoverPath(reference));
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      phase: "succeeded",
      items: [{ targetId: "acc_seller", outcome: "succeeded" }],
    });
    expect(allEvents.slice(1)).toMatchObject([
      { eventType: "marketplace.seller-order-capacity.set", payload: { maxOpenOrders: 7 } },
    ]);

    const direct = () =>
      app.request("/account/order-capacity", post({ idempotencyKey: `direct_${idempotencyKey}`, maxOpenOrders: 9 }));
    for (const original of [await direct(), await direct()]) {
      expect(original.status).toBe(200);
      expect(await original.json()).toMatchObject({ version: 2, maxOpenOrders: 9 });
    }
    expect(allEvents).toHaveLength(3);
  });

  it.each(["prepare", "extension"] as const)(
    "keeps every withdrawal recoverable when %s wins adoption",
    async (winner) => {
      const { eventStore, allEvents } = createInMemoryEventStore();
      const a = "lst_one";
      const b = "lst_two";
      const accountId = "acc_seller";
      const withdrawal = { ...preparation, intent: "bulk-withdraw-listings" };
      const retained = {
        ...reference,
        batchId: `${withdrawal.idempotencyKey}_bulk-withdraw-listings`,
        mutationKind: "listing.withdraw",
      } as const;
      const batch = { batchId: retained.batchId, family: retained.mutationKind };
      const vectorStream = listingBatchStreamId({ ...batch, accountId });
      const ownerStream = (listingId: string) => `marketplace.listing-${listingId}`;
      const context: EventStoreContext = {
        tenantId: "tnt_identity" as never,
        audit: { performedByUserId: "usr_seller" as never, forAccountId: accountId as never },
      };
      for (const listingId of [a, b] as const) {
        const facts = decideMarketplaceListing(initialMarketplaceListingState, {
          type: "CreateListing",
          publicationScope: "channel-only",
          listingId,
          accountId,
          inventoryItemId: "inv_synthetic",
          catalogItemId: "cat_synthetic",
          productId: "cat_synthetic::",
          selectedOptions: [],
          itemTitle: "Synthetic item",
          itemSubtitle: null,
          productSummary: null,
          storageLocationName: null,
          shipFromCode: null,
          shipFromAddress: {
            name: "Synthetic seller",
            company: null,
            line1: "1 Synthetic Way",
            line2: null,
            city: "Austin",
            state: "TX",
            postalCode: "78701",
            country: "US",
            phone: null,
            email: null,
          },
          priceAmount: "10",
          priceCurrencyCode: "USD",
          feeLock: null,
          quantityCap: 1,
          evidenceRequirements: null,
        });
        await eventStore.appendToStream({
          streamId: ownerStream(listingId),
          expectedVersion: "no_stream",
          context,
          events: facts.map(({ type, data }) => ({ eventType: type, payload: data })),
        });
      }

      let signalArrival!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => {
        signalArrival = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let armed = false;
      const pause = async () => {
        armed = false;
        signalArrival();
        await released;
      };
      const store = {
        ...eventStore,
        appendToStream: async (input: Parameters<typeof eventStore.appendToStream>[0]) => {
          if (armed && winner === "prepare" && input.streamId === vectorStream) await pause();
          return eventStore.appendToStream(input);
        },
        readStream: async (input: Parameters<typeof eventStore.readStream>[0]) => {
          if (armed && winner === "extension" && input.streamId === ownerStream(b)) await pause();
          return eventStore.readStream(input);
        },
      };
      const unused = () => {
        throw new Error("This in-memory test does not use a database or projection checkpoints.");
      };
      const db = { query: unused };
      const services = createMarketplaceListingRuntime({
        eventStore: store,
        db,
        checkpointStore: { loadCheckpoint: unused, saveCheckpoint: unused },
        commercialTermsResolver: createMarketplaceCommercialTermsResolver(db),
      });
      const app = buildApp({ actor: sellerActor, services });
      const send = async (listingIds: string[]) =>
        app.request("/account/listings/batch", post({ ...batch, listingIds }));
      const first = await send([a]);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ items: [{ targetId: a, outcome: "succeeded" }] });

      armed = true;
      const extension = send([a, b]);
      let prepared: Response;
      try {
        expect(await Promise.race([arrived.then(() => "paused"), extension.then(() => "finished")])).toBe("paused");
        prepared = await app.request("/account/listings/batch/prepare", post({ ...withdrawal, retained }));
      } finally {
        release();
      }
      const extended = await extension;
      const adopted = winner === "prepare";
      if (adopted) {
        expect(prepared.status).toBe(200);
        expect(await prepared.json()).toEqual({ reference: retained });
      } else {
        expect(prepared.status).toBe(200);
        const result = await prepared.json();
        expect(result).not.toHaveProperty("reference");
        expect(result).toMatchObject({ recovery: { phase: "failed-safe" } });
        expect(
          allEvents.filter(
            ({ streamId, metadata }) => streamId === vectorStream && metadata.listingBatchOrigin === "prepared",
          ),
        ).toHaveLength(0);
      }
      expect(extended.status).toBe(200);
      const terminalA = { targetId: a, outcome: "succeeded" };
      const terminalB = { targetId: b, outcome: "succeeded" };
      expect(await extended.json()).toMatchObject({
        items: [terminalA, adopted ? { targetId: b, outcome: "conflict" } : terminalB],
      });
      const withdrawals = (listingId: string) =>
        allEvents.filter(
          ({ streamId, eventType }) =>
            streamId === ownerStream(listingId) && eventType === "marketplace.listing.withdrawn",
        );
      expect(withdrawals(a)).toHaveLength(1);
      expect(withdrawals(b)).toHaveLength(adopted ? 0 : 1);
      const recovered = await app.request(recoverPath(retained));
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ items: adopted ? [terminalA] : [terminalA, terminalB] });
    },
  );

  it.each([null, { ...sellerActor!, permissions: ["listings.view"] }])(
    "requires management authority for preparation and retry",
    async (actor) => {
      const services = {
        ...createServices(),
        prepareListingRecovery: vi.fn(),
        recoverListingBatch: vi.fn(),
        applyListingBatch: vi.fn(),
      };
      const app = buildApp({ actor, services });
      expect((await app.request("/account/listings/batch/prepare", post(preparation))).status).toBe(actor ? 403 : 401);
      expect((await app.request("/account/listings/batch/retry", post(reference))).status).toBe(actor ? 403 : 401);
      expect(services.prepareListingRecovery).not.toHaveBeenCalled();
      expect(services.recoverListingBatch).not.toHaveBeenCalled();
      expect(services.applyListingBatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...preparation, accountId: "acc_other" },
    { ...preparation, fields: { csv: "private bytes" } },
    { ...reference, targets: [{ id: "lst_one", requestHash: "1".repeat(64) }] },
  ])("refuses client-supplied bindings, actor data or unrelated fields", async (body) => {
    const services = { ...createServices(), prepareListingRecovery: vi.fn() };
    const response = await buildApp({ actor: sellerActor, services }).request(
      "/account/listings/batch/prepare",
      post(body),
    );
    expect(response.status).toBe(400);
    expect(services.prepareListingRecovery).not.toHaveBeenCalled();
  });

  it("recovers under the authenticated owner and returns classified outcomes without sending", async () => {
    const recovery = listingRecoveryResult(reference, [{ targetId: "lst_one", outcome: "unknown" }]);
    const services = {
      ...createServices(),
      recoverListingBatch: vi.fn(async () => recovery),
      applyListingBatch: vi.fn(),
    };
    const app = buildApp({ actor: sellerActor, services });
    const response = await app.request(`${recoverPath(reference)}&accountId=acc_other`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(recovery);
    expect(services.recoverListingBatch).toHaveBeenCalledExactlyOnceWith("acc_seller", reference);
    expect(services.applyListingBatch).not.toHaveBeenCalled();
  });

  it.each([null, { ...sellerActor!, permissions: [] }])(
    "requires authenticated Listing view authority",
    async (actor) => {
      const services = { ...createServices(), recoverListingBatch: vi.fn() };
      const response = await buildApp({ actor, services }).request(recoverPath(reference));
      expect(response.status).toBe(actor ? 403 : 401);
      expect(services.recoverListingBatch).not.toHaveBeenCalled();
    },
  );

  it("rejects missing or invalid reference fields before reading history", async () => {
    const services = { ...createServices(), recoverListingBatch: vi.fn() };
    const app = buildApp({ actor: sellerActor, services });
    for (const path of [
      "/account/listings/batch/bad?family=listing.pause&bulk=true",
      `/account/listings/batch/${reference.batchId}?family=listing.invalid&bulk=true`,
      `/account/listings/batch/${reference.batchId}?family=listing.pause`,
    ])
      expect((await app.request(path)).status).toBe(400);
    expect(services.recoverListingBatch).not.toHaveBeenCalled();
  });

  it("selects retry recipients from the recovered vector rather than the POST body", async () => {
    const recovery = listingRecoveryResult(reference, [
      { targetId: "lst_one", outcome: "succeeded" },
      { targetId: "lst_two", outcome: "unknown" },
    ]);
    const services = {
      ...createServices(),
      recoverListingBatch: vi.fn(async () => recovery),
      applyListingBatch: vi.fn(async () => ({
        batchId: reference.batchId,
        family: reference.mutationKind,
        items: [{ targetId: "lst_two", outcome: "succeeded" as const, version: 2 }],
      })),
    };
    const app = buildApp({ actor: sellerActor, services });
    expect(
      (await app.request("/account/listings/batch/retry", post({ ...reference, listingIds: ["lst_one"] }))).status,
    ).toBe(400);
    const response = await app.request("/account/listings/batch/retry", post(reference));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      recovery: { phase: "succeeded", retryTargetIds: [] },
      sent: [{ targetId: "lst_two", outcome: "succeeded" }],
    });
    expect(services.applyListingBatch).toHaveBeenCalledExactlyOnceWith(
      {
        accountId: "acc_seller",
        batchId: reference.batchId,
        family: reference.mutationKind,
        listingIds: ["lst_two"],
      },
      expect.anything(),
    );
  });

  it.each(["error", "conflict"] as const)(
    "keeps a bound %s on owner read failure, but never grants retry when the pending target's history is incomplete",
    async (terminal) => {
      const { eventStore, allEvents } = createInMemoryEventStore();
      let unavailableStream: string | undefined;
      const store = {
        ...eventStore,
        readStream: async (request: Parameters<typeof eventStore.readStream>[0]) => {
          if (request.streamId === unavailableStream) throw new Error("Listing owner history unavailable");
          return eventStore.readStream(request);
        },
      };
      const recovery = createListingRecovery(store);
      const applyListingBatch = vi.fn(async () => ({
        batchId: reference.batchId,
        family: reference.mutationKind,
        items: [{ targetId: "lst_two", outcome: "succeeded" as const, version: 1 }],
      }));
      const app = buildApp({ actor: sellerActor, services: { ...createServices(), ...recovery, applyListingBatch } });
      const response = await app.request(
        "/account/listings/batch/prepare",
        post({ ...preparation, listingIds: ["lst_one", "lst_two"] }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ reference });
      const batch = { batchId: reference.batchId, family: reference.mutationKind, accountId: "acc_seller" };
      const attemptFor = (targetId: string) =>
        listingAttempt({
          idempotencyKey: batch.batchId,
          mutationKind: batch.family,
          accountId: batch.accountId,
          targetId,
          request: { listingId: targetId, reason: "seller" },
        });
      const settled = attemptFor("lst_one");
      await runListingBatch({
        store,
        batch,
        targets: [{ targetId: "lst_one", attempt: settled }],
        context: {
          tenantId: "tnt_identity" as never,
          audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
        },
        drive: async () => new Map([["lst_one", { outcome: terminal, version: 0 }]]),
      });

      const reload = async () => {
        const response = await app.request(recoverPath(reference));
        expect(response.status).toBe(200);
        return response.json();
      };
      const retry = async () => {
        const response = await app.request("/account/listings/batch/retry", post(reference));
        expect(response.status).toBe(200);
        return response.json();
      };
      unavailableStream = attemptFor("lst_two").streamId;
      expect(await retry()).toMatchObject({
        recovery: {
          phase: "ambiguous",
          items: [
            { targetId: "lst_one", outcome: terminal },
            { targetId: "lst_two", outcome: "ambiguous" },
          ],
          retryTargetIds: [],
        },
        sent: [],
      });
      expect(applyListingBatch).not.toHaveBeenCalled();
      unavailableStream = settled.streamId;
      expect(await reload()).toMatchObject({
        phase: "partial",
        items: [
          { targetId: "lst_one", outcome: terminal },
          { targetId: "lst_two", outcome: "unknown" },
        ],
        retryTargetIds: ["lst_two"],
      });
      expect(applyListingBatch).not.toHaveBeenCalled();
      expect(allEvents).toHaveLength(2);
      expect(await retry()).toMatchObject({ sent: [{ targetId: "lst_two", outcome: "succeeded" }] });
      expect(applyListingBatch).toHaveBeenCalledExactlyOnceWith(
        { ...batch, listingIds: ["lst_two"] },
        expect.anything(),
      );
    },
  );

  it("never sends when vector or owner history is unavailable", async () => {
    const recovery = listingRecoveryResult(null, []);
    const services = {
      ...createServices(),
      recoverListingBatch: vi.fn(async () => recovery),
      applyListingBatch: vi.fn(),
    };
    const app = buildApp({ actor: sellerActor, services });
    const response = await app.request("/account/listings/batch/retry", post(reference));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recovery, sent: [] });
    expect(services.applyListingBatch).not.toHaveBeenCalled();
  });
});

const validShipFromAddress = {
  name: "Seller shelf",
  company: null,
  line1: "100 Main St",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: null,
  email: null,
};

const validInventorySnapshot = {
  inventoryItemId: "inv_1",
  catalogItemId: "cat_1",
  productId: "cat_1::form:graded",
  selectedOptions: [{ dimensionId: "form", optionId: "graded" }],
  storageLocationId: "loc_1",
  storageLocationName: "Seller shelf",
  shipFromCode: "CHI-1",
  shipFromAddress: validShipFromAddress,
  totalQuantity: 2,
  acquisitionCostAmount: "4.50",
};

describe("marketplace listing routes", () => {
  it("loads a seller-owned available inventory item by exact listing-inventory id", async () => {
    const services = createServices();
    vi.mocked(services.getInventoryItemSupply).mockResolvedValue({
      item_id: "inv_1",
      account_id: "acc_seller",
      catalog_catalog_item_id: "cat_1",
      product_id: "cat_1::form:raw",
      item_language_code: "en",
      item_title: "Air Balloon",
      item_subtitle: null,
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Form: Raw",
      product_measure_snapshot: null,
      graded_card: null,
      storage_location_id: "loc_1",
      storage_location_name: "Listing stock",
      ship_from_code: "CHI-1",
      ship_from_address: validShipFromAddress,
      total_quantity: 3,
      available_quantity: 3,
      acquisition_cost_amount: "4.50",
      acquisition_cost_currency_code: null,
    });
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.request("/account/listing-inventory?inventoryItemId=inv_1");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(services.getInventoryItemSupply).toHaveBeenCalledWith("inv_1", "acc_seller");
    expect(body).toMatchObject({
      total: 1,
      count: 1,
      items: [{ item_id: "inv_1", available_quantity: 3 }],
    });
  });

  it("does not expose exact listing-inventory items without available quantity", async () => {
    const services = createServices();
    vi.mocked(services.getInventoryItemSupply).mockResolvedValue({
      item_id: "inv_1",
      account_id: "acc_seller",
      catalog_catalog_item_id: "cat_1",
      product_id: "cat_1::form:raw",
      item_language_code: "en",
      item_title: "Air Balloon",
      item_subtitle: null,
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Form: Raw",
      product_measure_snapshot: null,
      graded_card: null,
      storage_location_id: "loc_1",
      storage_location_name: "Listing stock",
      ship_from_code: "CHI-1",
      ship_from_address: validShipFromAddress,
      total_quantity: 3,
      available_quantity: 0,
      acquisition_cost_amount: "4.50",
      acquisition_cost_currency_code: null,
    });
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.request("/account/listing-inventory?inventoryItemId=inv_1");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ total: 0, count: 0, items: [] });
  });

  it("returns display-safe public standard terms without requiring a signed-in actor", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/terms/public-standard/listing-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceAmount: "20.00" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      account_type: "personal",
      basis_amount: "20.00",
      marketplace_sales_fee_unit_amount: "1.95",
      seller_net_unit_amount: "18.05",
      shipping_allowance_percentage_bps: 500,
      source_kind: "public-standard-seller-terms",
      source_label: "Standard seller terms",
      schedule_label: "Personal Default",
      resolved_at: "2026-04-17T00:00:00.000Z",
    });
    expect(body).not.toHaveProperty("fee_quote_fingerprint");
    expect(body).not.toHaveProperty("schedule_id");
    expect(body).not.toHaveProperty("agreement_id");
    expect(services.previewPublicStandardListingTerms).toHaveBeenCalledWith({
      priceAmount: "20.00",
    });
  });

  it("rate limits public standard terms previews", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    let response = new Response(null, { status: 500 });
    for (let index = 0; index < 121; index += 1) {
      response = await app.fetch(
        new Request("http://marketplace.test/terms/public-standard/listing-preview", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": "203.0.113.121",
          },
          body: JSON.stringify({ priceAmount: "20.00" }),
        }),
      );
    }

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "anonymous_request_rate_limited",
      },
    });
    expect(services.previewPublicStandardListingTerms).toHaveBeenCalledTimes(120);
  });

  it("saves an anonymous listing draft intent without requiring a signed-in actor", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/guest/listing-draft-intents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-marketplace-anonymous-listing-draft-id": "anon_listing_draft",
        },
        body: JSON.stringify({
          sourcePath: "/items/charizard?market=sell",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form:raw",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Form: Raw",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      intent_id: "ldi_1",
      anonymous_owner_id: "anon_listing_draft",
      catalog_item_id: "cat_charizard",
      price_amount: "20.00",
      status: "active",
    });
    expect(services.createAnonymousListingDraftIntent).toHaveBeenCalledWith({
      anonymousOwnerId: "anon_listing_draft",
      sourcePath: "/items/charizard?market=sell",
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Form: Raw",
      priceAmount: "20.00",
      priceCurrencyCode: "USD",
      quantityCap: 1,
      purchaseLimits: {
        maxUnitsPerOrder: null,
        maxUnitsPerDay: null,
        maxUnitsPerCustomerAccount: null,
      },
    });
  });

  it("rate limits anonymous listing draft intent capture", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    let response = new Response(null, { status: 500 });
    for (let index = 0; index < 31; index += 1) {
      response = await app.fetch(
        new Request("http://marketplace.test/guest/listing-draft-intents", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-marketplace-anonymous-listing-draft-id": "anon_listing_draft_rate_limited",
            "x-forwarded-for": "203.0.113.122",
          },
          body: JSON.stringify({
            sourcePath: "/items/charizard?market=sell",
            catalogItemId: `cat_rate_${index}`,
            productId: `cat_rate_${index}::form:raw`,
            selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
            productSummary: "Form: Raw",
            priceAmount: "20.00",
            priceCurrencyCode: "USD",
            quantityCap: 1,
          }),
        }),
      );
    }

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "anonymous_request_rate_limited",
      },
    });
    expect(services.createAnonymousListingDraftIntent).toHaveBeenCalledTimes(30);
  });

  it("requires the anonymous owner header before saving a listing draft intent", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/guest/listing-draft-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceAmount: "20.00", quantityCap: 1 }),
      }),
    );

    expect(response.status).toBe(400);
    expect(services.createAnonymousListingDraftIntent).not.toHaveBeenCalled();
  });

  it("claims an anonymous listing draft intent for a signed-in seller", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view", "listings.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listing-draft-intents/ldi_1/claim", {
        method: "POST",
        headers: {
          "x-marketplace-anonymous-listing-draft-id": "anon_listing_draft",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      intent_id: "ldi_1",
      status: "claimed",
      claimed_account_id: "acc_seller",
    });
    expect(services.claimAnonymousListingDraftIntent).toHaveBeenCalledWith({
      anonymousOwnerId: "anon_listing_draft",
      intentId: "ldi_1",
      accountId: "acc_seller",
    });
  });

  it("returns committed channel-only aggregate state while Listing projections are poisoned", async () => {
    const services = createServices();
    const state = {
      ...initialMarketplaceListingState,
      listingId: "lst_channel" as never,
      accountId: "acc_seller" as never,
      publicationScope: "channel-only" as const,
      nativeVisibility: "disabled" as const,
      nativeFeeState: "not-enrolled" as const,
      priceAmount: "12.00",
      priceCurrencyCode: "USD",
      quantityCap: 1,
    };
    vi.mocked(services.createListing).mockResolvedValueOnce({
      listingId: "lst_channel" as never,
      version: 1,
      feeQuoteFingerprint: null,
      state,
    });
    vi.mocked(services.getSellerListing).mockImplementation(async () => {
      throw new Error("Poisoned Listing projection");
    });
    const app = buildApp({ actor: sellerActor, services });
    const response = await app.request("/account/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inventoryItemId: "inv_1",
        priceAmount: "12.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        publicationScope: "channel-only",
      }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).state).toEqual(state);
    expect(services.getSellerListing).not.toHaveBeenCalled();
    expect(services.createListing).toHaveBeenCalledWith(
      expect.objectContaining({ publicationScope: "channel-only" }),
      expect.any(Object),
    );
  });

  it("passes Checkout-provided deterministic listing IDs into seller listing creation", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inventoryItemId: "inv_1",
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: "lst_checkout_fallback",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: "lst_checkout_fallback",
      status: "draft",
    });
    expect(services.createListing).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        inventoryItemId: "inv_1",
        listingIdOverride: "lst_checkout_fallback",
      }),
      expect.any(Object),
    );
  });

  it("requires and forwards seller-authored currency for multipart listing creation", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });
    const form = new FormData();
    form.set("inventoryItemId", "inv_1");
    form.set("priceAmount", "12.00");
    form.set("priceCurrencyCode", " eur ");
    form.set("quantityCap", "1");

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", { method: "POST", body: form }),
    );

    expect(response.status).toBe(201);
    expect(services.createListing).toHaveBeenCalledWith(
      expect.objectContaining({ priceAmount: "12.00", priceCurrencyCode: " eur " }),
      expect.any(Object),
    );

    const missingCurrency = new FormData();
    missingCurrency.set("inventoryItemId", "inv_1");
    missingCurrency.set("priceAmount", "12.00");
    missingCurrency.set("quantityCap", "1");
    const rejected = await app.fetch(
      new Request("http://marketplace.test/account/listings", { method: "POST", body: missingCurrency }),
    );
    expect(rejected.status).toBe(400);
  });

  it.each(["unrelatedField", "purchaseLimits"])("keeps multipart create closed to %s", async (key) => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });
    const form = new FormData();
    form.set("inventoryItemId", "inv_1");
    form.set("priceAmount", "12.00");
    form.set("priceCurrencyCode", "USD");
    form.set("quantityCap", "7");
    form.set(key, JSON.stringify({ maxUnitsPerOrder: 1 }));

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", { method: "POST", body: form }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "listing_request_unknown_field" } });
    expect(services.createListing).not.toHaveBeenCalled();
    expect(services.createListingFromInventorySnapshot).not.toHaveBeenCalled();
  });

  it.each([
    { label: "populated", limits: { maxUnitsPerOrder: 1, maxUnitsPerDay: 2, maxUnitsPerCustomerAccount: 3 } },
    { label: "null", limits: { maxUnitsPerOrder: null, maxUnitsPerDay: null, maxUnitsPerCustomerAccount: null } },
    { label: "omitted", limits: undefined },
  ])("preserves JSON create's nested $label purchase limits", async ({ limits }) => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });
    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inventoryItemId: "inv_1",
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          quantityCap: 7,
          purchaseLimits: limits,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.createListing).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseLimits: limits ?? { maxUnitsPerOrder: null, maxUnitsPerDay: null, maxUnitsPerCustomerAccount: null },
      }),
      expect.any(Object),
    );
  });

  it.each(
    ["maxUnitsPerOrder", "maxUnitsPerDay", "maxUnitsPerCustomerAccount"].flatMap((key) =>
      [0, -1, 1.5].map((value) => ({ key, value })),
    ),
  )("preserves multipart positive-integer validation for $key=$value", async ({ key, value }) => {
    const services = createServices();
    const create = vi.mocked(services.createListing).getMockImplementation()!;
    vi.mocked(services.createListing).mockImplementation(async (input, context) => {
      normalizePurchaseLimits(input.purchaseLimits, input.quantityCap);
      return create(input, context);
    });
    const app = buildApp({ actor: sellerActor, services });
    const form = new FormData();
    for (const [field, text] of Object.entries({
      inventoryItemId: "inv_1",
      priceAmount: "12.00",
      priceCurrencyCode: "USD",
      quantityCap: "7",
      [key]: String(value),
    }))
      form.set(field, text);

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", { method: "POST", body: form }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "listing_command_rejected" } });
  });

  it("rejects incomplete, malformed, and recursively open price authoring requests", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });
    const base = { inventoryItemId: "inv_1", priceAmount: "12.00", quantityCap: 1 };

    for (const body of [
      base,
      { ...base, priceCurrencyCode: "US" },
      { ...base, priceCurrencyCode: "USD", guessedCurrency: "EUR" },
      { ...base, priceCurrencyCode: "USD", purchaseLimits: { maxUnitsPerOrder: 1, guessed: 2 } },
    ]) {
      const response = await app.fetch(
        new Request("http://marketplace.test/account/listings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(400);
    }

    const updateResponse = await app.fetch(
      new Request("http://marketplace.test/account/listings/lst_1/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceAmount: "12.00", priceCurrencyCode: "USD", guessedCurrency: "EUR" }),
      }),
    );
    const bulkResponse = await app.fetch(
      new Request("http://marketplace.test/account/listings/prices/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updates: [{ listingId: "lst_1", priceAmount: "12.00", priceCurrencyCode: "USD", guessed: "EUR" }],
        }),
      }),
    );

    expect(updateResponse.status).toBe(400);
    expect(bulkResponse.status).toBe(400);
    expect(services.createListing).not.toHaveBeenCalled();
    expect(services.updateListingPrice).not.toHaveBeenCalled();
    expect(services.applyBulkListingPriceUpdates).not.toHaveBeenCalled();
  });

  it("returns not found without a fee fingerprint when a deterministic listing is not owned", async () => {
    const services = createServices();
    vi.mocked(services.createListing).mockRejectedValueOnce(
      new MarketplaceListingDomainError("listing-not-found", "Listing not found."),
    );
    const app = buildApp({ actor: sellerActor, services });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inventoryItemId: "inv_1",
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: "lst_existing",
        }),
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "listing_not_found", message: "Listing not found." },
    });
  });

  it("forwards status and search filters to the seller listings query and drops the all-status sentinel", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings?status=paused&search=Charizard&limit=25&offset=0"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      statusCounts: { active: 2, draft: 1, paused: 3, withdrawn: 4 },
    });
    expect(services.listSellerListings).toHaveBeenCalledWith({
      accountId: "acc_seller",
      limit: 25,
      offset: 0,
      status: "paused",
      search: "Charizard",
    });
    expect(services.getSellerListingStatusCounts).toHaveBeenCalledWith("acc_seller");

    vi.mocked(services.listSellerListings).mockClear();
    await app.fetch(new Request("http://marketplace.test/account/listings?status=all"));

    expect(services.listSellerListings).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined, search: undefined }),
    );
  });

  it("returns a stable code when listing creation cannot find Marketplace inventory supply", async () => {
    const services = createServices();
    vi.mocked(services.createListing).mockRejectedValueOnce(
      new MarketplaceListingDomainError("inventory-item-not-found", "Inventory item not found."),
    );
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inventoryItemId: "inv_missing_from_marketplace",
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "inventory_item_not_found",
        message: "Inventory item not found.",
      },
    });
  });

  it("hydrates a valid inventory snapshot into seller listing creation", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          inventorySnapshot: {
            ...validInventorySnapshot,
            availableQuantity: 1,
            gradedCard: {
              gradingCompany: "PSA",
              grade: "10",
              certificationNumber: "12345678",
              population: {
                populationAtGrade: 12,
                populationHigher: 0,
                source: "PSA population report",
                asOf: "2026-04-01",
              },
              conditionDescriptors: ["Gem Mint"],
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.createListingFromInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        availableQuantity: 1,
        shipFromAddress: validShipFromAddress,
        gradedCard: expect.objectContaining({
          gradingCompany: "PSA",
          grade: "10",
          conditionDescriptors: ["Gem Mint"],
        }),
      }),
      expect.any(Object),
    );
  });

  it("rejects malformed inventory snapshot ship-from addresses before creating a listing", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          inventorySnapshot: {
            ...validInventorySnapshot,
            shipFromAddress: {
              ...validShipFromAddress,
              line1: "",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(services.createListingFromInventorySnapshot).not.toHaveBeenCalled();
    expect(services.createListing).not.toHaveBeenCalled();
  });

  it("rejects malformed inventory snapshot graded cards before creating a listing", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          inventorySnapshot: {
            ...validInventorySnapshot,
            gradedCard: {
              gradingCompany: "PSA",
              certificationNumber: "12345678",
              population: null,
              conditionDescriptors: [],
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(services.createListingFromInventorySnapshot).not.toHaveBeenCalled();
    expect(services.createListing).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing Inventory item id", { inventoryItemId: undefined }],
    ["an Inventory item id of another kind", { inventoryItemId: "cat_1" }],
    ["a non-text Inventory item id", { inventoryItemId: 42 }],
    ["a missing Catalog Item id", { catalogItemId: "" }],
    ["a Catalog Item id of another kind", { catalogItemId: "inv_1" }],
    ["a missing Product id", { productId: null }],
    ["a Product id of another Catalog Item", { productId: "cat_2::form:graded" }],
    ["a Product id without its selection separator", { productId: "cat_1" }],
    ["a missing storage location id", { storageLocationId: undefined }],
    ["a storage location id of another kind", { storageLocationId: "inv_1" }],
    ["a negative total quantity", { totalQuantity: -1 }],
    ["a fractional total quantity", { totalQuantity: 1.5 }],
    ["a non-numeric total quantity", { totalQuantity: "two" }],
    ["a boolean total quantity", { totalQuantity: true }],
    ["a negative available quantity", { availableQuantity: -1 }],
    ["a fractional available quantity", { availableQuantity: "0.5" }],
    ["an empty available quantity", { availableQuantity: "" }],
  ])("refuses an inventory snapshot with %s before creating a listing", async (_case, change) => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          inventorySnapshot: { ...validInventorySnapshot, ...change },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "listing_inventory_snapshot_invalid" } });
    expect(services.createListingFromInventorySnapshot).not.toHaveBeenCalled();
    expect(services.createListing).not.toHaveBeenCalled();
  });

  it("takes snapshot quantities sent as digits, and an available quantity that defaults to the total", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });
    expect(validInventorySnapshot).not.toHaveProperty("availableQuantity");

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          inventorySnapshot: { ...validInventorySnapshot, totalQuantity: "3" },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.createListingFromInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        inventoryItemId: "inv_1",
        catalogItemId: "cat_1",
        productId: "cat_1::form:graded",
        storageLocationId: "loc_1",
        totalQuantity: 3,
        availableQuantity: 3,
      }),
      expect.any(Object),
    );
  });

  it("accepts a five-key snapshot gradedCard, creates from the details Inventory holds, and answers a retry with the first result", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    const itemWrites: unknown[] = [];
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("INSERT INTO marketplace_supply_locations")) {
          return { rows: [{ storage_location_id: validInventorySnapshot.storageLocationId }] };
        }
        if (sql.includes("INSERT INTO marketplace_supply_items")) {
          itemWrites.push(values[5]);
          return { rows: [{ item_id: validInventorySnapshot.inventoryItemId }] };
        }
        if (sql.includes("FROM marketplace_supply_items AS item")) {
          const stored = itemWrites.at(-1);
          return {
            rows: [
              {
                item_id: validInventorySnapshot.inventoryItemId,
                account_id: "acc_seller",
                catalog_catalog_item_id: validInventorySnapshot.catalogItemId,
                product_id: validInventorySnapshot.productId,
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: validInventorySnapshot.selectedOptions,
                product_summary: null,
                product_measure_snapshot: {
                  catalogItemId: validInventorySnapshot.catalogItemId,
                  productId: validInventorySnapshot.productId,
                  selectedOptions: validInventorySnapshot.selectedOptions,
                  measureVersion: "pm_test_v1",
                  unitLengthInches: 3.5,
                  unitWidthInches: 2.5,
                  unitHeightInches: 0.01,
                  unitWeightOunces: 0.1,
                  physicalFlags: ["bendable"],
                  stackBehavior: "stackable-thickness",
                  source: "profile",
                  confidence: "measured",
                },
                graded_card: typeof stored === "string" ? JSON.parse(stored) : null,
                storage_location_name: validInventorySnapshot.storageLocationName,
                ship_from_code: validInventorySnapshot.shipFromCode,
                ship_from_address: validShipFromAddress,
                available_quantity: validInventorySnapshot.totalQuantity,
              },
            ],
          };
        }
        if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
          return { rows: [{ quantity_cap: "0" }] };
        }
        throw new Error(`Unexpected query in test: ${sql}`);
      }),
    };
    // Inventory holds the item as raw, whatever the request says.
    const resolve = vi.fn(async () => ({
      gradedCard: null,
      selectedOptions: validInventorySnapshot.selectedOptions,
    }));
    const unused = () => {
      throw new Error("This in-memory test does not use projection checkpoints.");
    };
    const services = createMarketplaceListingRuntime({
      eventStore,
      db,
      checkpointStore: { loadCheckpoint: unused, saveCheckpoint: unused },
      commercialTermsResolver: {
        resolveListingTerms: async ({ amount, accountId }: { amount: string; accountId: string }) => ({
          accountId,
          accountType: "business",
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "0.60",
          sellerNetUnitAmount: "11.40",
          scheduleId: "cts_default",
          agreementId: null,
          resolvedAt: "2026-04-17T00:00:00.000Z",
        }),
      } as never,
      inventoryItemGradedCardAuthority: { resolve },
    });
    const app = buildApp({ actor: sellerActor, services });
    const gradedCard = {
      gradingCompany: "PSA",
      grade: "10",
      certificationNumber: "12345678",
      population: { populationAtGrade: 12, populationHigher: 0, source: "PSA population report", asOf: "2026-04-01" },
      conditionDescriptors: ["Gem Mint"],
    };
    const send = (idempotencyKey: string, requested: unknown) =>
      app.request("/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          inventorySnapshot: { ...validInventorySnapshot, gradedCard: requested },
        }),
      });

    const first = await send("graded_snapshot_attempt_00000001", gradedCard);
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created).toMatchObject({ version: 1, status: "draft", state: { gradedCard: null } });
    const committed = allEvents.length;
    expect(allEvents.filter((event) => event.eventType === "marketplace.listing.created")).toHaveLength(1);

    const retry = await send("graded_snapshot_attempt_00000001", gradedCard);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(created);
    expect(allEvents).toHaveLength(committed);
    expect(itemWrites).toEqual([null, null]);

    // The attempt never covered the snapshot's details, so a retry that sends others is the same attempt.
    const changed = await send("graded_snapshot_attempt_00000001", {
      ...gradedCard,
      gradingCompany: "BGS",
      grade: "9",
    });
    expect(changed.status).toBe(201);
    expect(await changed.json()).toEqual(created);
    expect(allEvents).toHaveLength(committed);
    expect(itemWrites).toEqual([null, null, null]);

    const { grade: _grade, ...malformed } = gradedCard;
    const refused = await send("graded_snapshot_attempt_00000002", malformed);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "listing_inventory_snapshot_invalid" } });
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(allEvents).toHaveLength(committed);
  });

  it("refuses seller-created graded Inventory without a certification number", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    const { catalogItemId, inventoryItemId, productId, selectedOptions, storageLocationId } = validInventorySnapshot;
    const gradedCard = {
      gradingCompany: "PSA",
      grade: "10",
      certificationNumber: null,
      population: null,
      conditionDescriptors: [],
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO marketplace_supply_locations"))
          return { rows: [{ storage_location_id: storageLocationId }] };
        if (sql.includes("INSERT INTO marketplace_supply_items")) return { rows: [{ item_id: inventoryItemId }] };
        if (sql.includes("FROM marketplace_supply_items AS item"))
          return {
            rows: [
              {
                item_id: inventoryItemId,
                account_id: "acc_seller",
                catalog_catalog_item_id: catalogItemId,
                product_id: productId,
                graded_card: gradedCard,
                selected_options: selectedOptions,
                ship_from_address: validShipFromAddress,
                available_quantity: 2,
              },
            ],
          };
        return { rows: [] };
      }),
    };
    const unused = () => {
      throw new Error("This test does not use projection checkpoints.");
    };
    const services = createMarketplaceListingRuntime({
      db: db as never,
      eventStore,
      checkpointStore: { loadCheckpoint: unused, saveCheckpoint: unused },
      commercialTermsResolver: createMarketplaceCommercialTermsResolver(db as never),
      inventoryItemGradedCardAuthority: { resolve: async () => ({ gradedCard, selectedOptions }) },
    });
    const app = buildApp({ actor: sellerActor, services });
    const response = await app.request("/account/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicationScope: "channel-only",
        priceAmount: "12.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        inventorySnapshot: { ...validInventorySnapshot, gradedCard },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "listing_command_rejected" } });
    expect(allEvents).toEqual([]);
  });

  it("sets certification on the seller's Listing and returns only safe refusal text for invalid numbers", async () => {
    const setListingCertificationNumber = vi
      .fn<MarketplaceListingServices["setListingCertificationNumber"]>()
      .mockResolvedValueOnce({ listingId: "lst_1", version: 2 })
      .mockRejectedValueOnce(new MarketplaceListingDomainError("certification-number-invalid", "private diagnostic"));
    const services = { ...createServices(), setListingCertificationNumber };
    const app = buildApp({ actor: sellerActor, services });
    const send = (certificationNumber: string) =>
      app.request("/account/listings/lst_1/certification-number", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ certificationNumber, idempotencyKey: "certification_test_attempt_0001" }),
      });

    const accepted = await send("00123456");
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ id: "lst_1", version: 2, status: "certification-number-set" });
    expect(setListingCertificationNumber).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        listingId: "lst_1",
        certificationNumber: "00123456",
        idempotencyKey: "certification_test_attempt_0001",
      },
      expect.any(Object),
    );
    const refused = await send("001");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: {
        code: "listing_certification_number_invalid",
        message: "Enter a certification number in the format Chase Sets accepts for this grading company.",
      },
    });
  });

  it("returns an actionable conflict when publish requires a certification number", async () => {
    const services = createServices();
    vi.mocked(services.publishListing).mockRejectedValueOnce(
      new MarketplaceListingDomainError("certification-number-required", "private diagnostic"),
    );
    const app = buildApp({ actor: sellerActor, services });
    const response = await app.request("/account/listings/lst_1/publish", { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "listing_certification_number_required",
        message: "Add a certification number before publishing this Listing.",
      },
    });
  });

  it("publishes a seller listing through the documented API action", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings/lst_1/publish", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "lst_1",
      version: 2,
      status: "published",
    });
    expect(services.publishListing).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        listingId: "lst_1",
        feeQuoteFingerprint: null,
        idempotencyKey: expect.stringMatching(/^test_attempt_/),
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("exposes seller-scoped evidence coverage and classification actions", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });

    const coverageResponse = await app.fetch(
      new Request("http://marketplace.test/account/listings/lst_1/evidence-coverage?now=2026-07-13T00:00:00.000Z"),
    );
    expect(coverageResponse.status).toBe(200);
    await expect(coverageResponse.json()).resolves.toMatchObject({
      listingId: "lst_1",
      coverage: { complete: false, unmetCodes: ["min-photo-count-unmet"] },
    });
    expect(services.getListingEvidenceCoverage).toHaveBeenCalledWith({
      accountId: "acc_seller",
      listingId: "lst_1",
      now: "2026-07-13T00:00:00.000Z",
    });

    const classifyResponse = await app.fetch(
      new Request("http://marketplace.test/account/listings/lst_1/photos/lpho_1/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotId: "front", viewKind: "front" }),
      }),
    );
    expect(classifyResponse.status).toBe(200);
    expect(services.classifyListingPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        listingId: "lst_1",
        photoId: "lpho_1",
        slotId: "front",
        viewKind: "front",
      }),
      expect.anything(),
    );
  });

  it("returns the current readiness snapshot when publication evidence is stale or incomplete", async () => {
    const services = createServices();
    const currentReadiness = await services.getListingEvidenceReadiness({
      accountId: "acc_seller",
      listingId: "lst_1",
    });
    vi.mocked(services.publishListing).mockRejectedValue(
      new MarketplaceListingEvidenceIncompleteError(currentReadiness),
    );
    const app = buildApp({ actor: sellerActor, services });

    const response = await app.request("/account/listings/lst_1/publish", { method: "POST" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({
      code: "listing_evidence_incomplete",
      currentEvidenceReadiness: { coverage: { complete: false } },
    });
  });

  it("returns server-owned evidence readiness with a seller listing", async () => {
    const services = createServices();
    vi.mocked(services.getSellerListing).mockResolvedValue({ listing_id: "lst_1" } as never);
    const app = buildApp({ actor: sellerActor, services });

    const response = await app.request("/account/listings/lst_1");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.evidence_readiness).toMatchObject({
      coverage: { complete: false, unmetCodes: ["min-photo-count-unmet"] },
      nextActions: [{ localeKey: "marketplace.features.listings.evidenceCoverage.min-photo-count-unmet" }],
    });
    expect(services.getListingEvidenceReadiness).toHaveBeenCalledWith({
      accountId: "acc_seller",
      listingId: "lst_1",
      now: expect.any(String),
    });
  });

  it("wires evidence classify, replace, remove, and reorder routes to the owned listing services", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });

    const classifyResponse = await app.request("/account/listings/lst_1/photos/lpho_1/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slotId: "front", viewKind: "front", altText: "Front view" }),
    });
    const replacement = new FormData();
    replacement.set("listingPhoto", new File([new Uint8Array([1, 2, 3])], "front.webp", { type: "image/webp" }));
    replacement.set("slotId", "front");
    replacement.set("viewKind", "front");
    const replaceResponse = await app.request("/account/listings/lst_1/photos/lpho_1/replace", {
      method: "POST",
      body: replacement,
    });
    const removeResponse = await app.request("/account/listings/lst_1/photos/lpho_1", { method: "DELETE" });
    const reorderResponse = await app.request("/account/listings/lst_1/photos/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedPhotoIds: ["lpho_2", "lpho_1"] }),
    });

    expect([classifyResponse.status, replaceResponse.status, removeResponse.status, reorderResponse.status]).toEqual([
      200, 200, 200, 200,
    ]);
    expect(services.classifyListingPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc_seller", listingId: "lst_1", photoId: "lpho_1", slotId: "front" }),
      expect.any(Object),
    );
    expect(services.replaceListingPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc_seller", listingId: "lst_1", replacedPhotoId: "lpho_1" }),
      expect.any(Object),
    );
    expect(services.removeListingPhoto).toHaveBeenCalledWith(
      { accountId: "acc_seller", listingId: "lst_1", photoId: "lpho_1" },
      expect.any(Object),
    );
    expect(services.reorderListingPhotos).toHaveBeenCalledWith(
      { accountId: "acc_seller", listingId: "lst_1", orderedPhotoIds: ["lpho_2", "lpho_1"] },
      expect.any(Object),
    );
  });

  it("applies a batch of listing price updates through the bulk price-update route (m113 #4327)", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings/prices/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updates: [
            { listingId: "lst_1", priceAmount: "21.00", priceCurrencyCode: "USD" },
            {
              listingId: "lst_2",
              priceAmount: "22.00",
              priceCurrencyCode: "EUR",
              feeQuoteFingerprint: "some-fingerprint",
            },
            { listingId: "" },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        { listingId: "lst_1", outcome: "applied", version: 2 },
        { listingId: "lst_2", outcome: "applied", version: 2 },
      ],
      total: 2,
      count: 2,
    });
    // The empty listingId entry is dropped before it ever reaches the
    // service -- callers cannot request an update for no listing.
    expect(services.applyBulkListingPriceUpdates).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        batchId: expect.stringMatching(/^test_attempt_/),
        updates: [
          {
            listingId: "lst_1",
            priceAmount: "21.00",
            priceCurrencyCode: "USD",
            feeQuoteFingerprint: null,
            idempotencyKey: expect.stringMatching(/^test_attempt_/),
          },
          {
            listingId: "lst_2",
            priceAmount: "22.00",
            priceCurrencyCode: "EUR",
            feeQuoteFingerprint: "some-fingerprint",
            idempotencyKey: expect.stringMatching(/^test_attempt_/),
          },
        ],
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("returns listing fee history for the seller listing", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://marketplace.test/account/listings/lst_1/fee-history"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      count: 1,
      items: [
        {
          event_type: "marketplace.listing.published",
          marketplace_sales_fee_unit_amount: "1.00",
          seller_net_unit_amount: "19.00",
          performed_by_user_id: "usr_seller",
        },
      ],
    });
    expect(services.listSellerListingFeeHistory).toHaveBeenCalledWith({
      listingId: "lst_1",
      accountId: "acc_seller",
    });
  });

  it("returns marketplace sales fee lock report rows", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://marketplace.test/account/listings/fee-lock-report"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      count: 1,
      items: [
        {
          listing_id: "lst_1",
          marketplace_sales_fee_unit_amount: "1.00",
          seller_net_unit_amount: "19.00",
          fee_quote_fingerprint: "20.00|1.00|19.00|cts_default|",
        },
      ],
    });
    expect(services.listSellerListingFeeLockReport).toHaveBeenCalledWith({
      accountId: "acc_seller",
      limit: 100,
      offset: 0,
    });
  });

  it("turns seller listing availability off for the acting account", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view", "listings.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listing-availability/disable", {
        method: "POST",
        body: JSON.stringify({
          reasonCategory: "audit",
          availableAgainOn: "2026-06-01",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_seller",
      version: 1,
      status: "unavailable",
    });
    expect(services.disableSellerListingAvailability).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        reasonCategory: "audit",
        availableAgainOn: "2026-06-01",
        availableAgainAt: null,
        idempotencyKey: expect.stringMatching(/^test_attempt_/),
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("forwards the client-captured authoritative resume instant when disabling seller listing availability", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view", "listings.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listing-availability/disable", {
        method: "POST",
        body: JSON.stringify({
          reasonCategory: "travel",
          availableAgainOn: "2026-07-20",
          availableAgainAt: "2026-07-20T05:00:00.000Z",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(services.disableSellerListingAvailability).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        reasonCategory: "travel",
        availableAgainOn: "2026-07-20",
        availableAgainAt: "2026-07-20T05:00:00.000Z",
        idempotencyKey: expect.stringMatching(/^test_attempt_/),
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("reads seller order capacity for the acting account", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });

    const response = await app.request("/account/order-capacity");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(services.getSellerOrderCapacity).toHaveBeenCalledWith("acc_seller");
    expect(body).toEqual({
      account_id: "acc_seller",
      max_open_orders: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    });
  });

  it("sets seller order capacity for the acting account", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/order-capacity", {
        method: "POST",
        body: JSON.stringify({ maxOpenOrders: 5 }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_seller",
      version: 1,
      maxOpenOrders: 5,
    });
    expect(services.setSellerOrderCapacity).toHaveBeenCalledWith(
      { accountId: "acc_seller", maxOpenOrders: 5, idempotencyKey: expect.stringMatching(/^test_attempt_/) },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("rejects setting seller order capacity below 1", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/order-capacity", {
        method: "POST",
        body: JSON.stringify({ maxOpenOrders: 0 }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(services.setSellerOrderCapacity).not.toHaveBeenCalled();
  });

  it("clears seller order capacity for the acting account", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/order-capacity", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_seller",
      version: 2,
      maxOpenOrders: null,
    });
    expect(services.clearSellerOrderCapacity).toHaveBeenCalledWith(
      { accountId: "acc_seller", idempotencyKey: expect.stringMatching(/^test_attempt_/) },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("requires listings.manage permission to set seller order capacity", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "viewer",
        permissions: ["listings.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/order-capacity", {
        method: "POST",
        body: JSON.stringify({ maxOpenOrders: 5 }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(403);
    expect(services.setSellerOrderCapacity).not.toHaveBeenCalled();
  });

  it("schedules an away window for the acting account", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view", "listings.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listing-availability/away-window", {
        method: "POST",
        body: JSON.stringify({
          reasonCategory: "travel",
          startsAt: "2026-07-20T05:00:00.000Z",
          endsAt: "2026-07-27T05:00:00.000Z",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_seller",
      version: 1,
    });
    expect(services.scheduleSellerAwayWindow).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        reasonCategory: "travel",
        startsAt: "2026-07-20T05:00:00.000Z",
        endsAt: "2026-07-27T05:00:00.000Z",
        idempotencyKey: expect.stringMatching(/^test_attempt_/),
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("rejects scheduling an away window without a reason", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view", "listings.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listing-availability/away-window", {
        method: "POST",
        body: JSON.stringify({
          startsAt: "2026-07-20T05:00:00.000Z",
          endsAt: null,
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(services.scheduleSellerAwayWindow).not.toHaveBeenCalled();
  });

  it("cancels the scheduled away window for the acting account", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view", "listings.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listing-availability/away-window", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_seller",
      version: 2,
    });
    expect(services.cancelScheduledAwayWindow).toHaveBeenCalledWith(
      { accountId: "acc_seller", idempotencyKey: expect.stringMatching(/^test_attempt_/) },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });
});

describe("public product Listings route", () => {
  /** Every key a public Listing item may carry. Written out here so the production list cannot vouch for itself. */
  const publicListingKeys = [
    "listing_id",
    "catalog_catalog_item_id",
    "product_id",
    "item_title",
    "item_subtitle",
    "selected_options",
    "product_summary",
    "graded_card",
    "price_amount",
    "price_currency_code",
    "listing_stream_version",
    "shipping_allowance_percentage_bps",
    "max_units_per_order",
    "max_units_per_day",
    "max_units_per_customer_account",
    "status",
    "seller_display_name",
    "visible_quantity",
    "public_gallery",
  ] as const;

  const publicRow = {
    listing_id: "lst_public",
    catalog_catalog_item_id: "cat_public",
    product_id: "prod_1",
    item_title: "Air Balloon",
    item_subtitle: null,
    selected_options: [{ dimensionId: "form", optionId: "raw" }],
    product_summary: "Form: Raw",
    graded_card: null,
    price_amount: "21.50",
    price_currency_code: "USD",
    listing_stream_version: 4,
    shipping_allowance_percentage_bps: 0,
    max_units_per_order: null,
    max_units_per_day: null,
    max_units_per_customer_account: null,
    status: "active",
    seller_display_name: "QA Seller",
    visible_quantity: 2,
    public_gallery: [],
  };

  /** What only the seller may read. A service that returned these on a row must not get them past the route. */
  const fieldsOutsidePublicRow = {
    account_id: "acc_private_seller",
    ship_from_code: "Grandma's garage",
    inventory_item_id: "item_private",
    storage_location_name: "Back room bin 7",
    ship_from_address: {
      name: "Private Seller Name",
      line1: "742 Evergreen Terrace",
      city: "Springfield",
      state: "IL",
      postalCode: "62704",
      country: "US",
      phone: "555-0142",
      email: "seller.private@example.test",
    },
    marketplace_sales_fee_unit_amount: "2.37",
    seller_net_unit_amount: "19.13",
    fee_quote_fingerprint: "21.50|2.37|19.13|cts_private|agr_private",
    fee_locks: [{ lockId: "lock_private" }],
    terms_schedule_id: "cts_private",
    terms_agreement_id: "agr_private",
    terms_resolved_at: "2026-04-17T00:00:00.000Z",
    evidence_requirements: { policyHash: "hash_private" },
    evidence: [{ storageKey: "evidence/private-key.webp" }],
    pause_reason: "inventory-capacity",
    inventory_capacity_recovery_block: { reason: "blocked_private" },
    quantity_cap: 9,
  };

  function appServing(rows: readonly unknown[]) {
    const services = {
      ...createServices(),
      listItemListings: vi.fn(async () => rows),
    } as unknown as MarketplaceListingServices;
    return { app: buildApp({ actor: null, services }), services };
  }

  it("answers a caller who is not signed in with items that hold exactly the public keys", async () => {
    const { app, services } = appServing([publicRow]);

    const response = await app.fetch(new Request("http://marketplace.test/products/prod_1/listings"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Record<string, unknown>[]; total: number; count: number };
    expect(body.total).toBe(1);
    expect(body.count).toBe(1);
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([...publicListingKeys].sort());
    expect(body.items[0]).toEqual(publicRow);
    expect(services.listItemListings).toHaveBeenCalledWith("prod_1");
  });

  it("serves no field outside the public row even when the service returns a row that carries them", async () => {
    const { app } = appServing([{ ...publicRow, ...fieldsOutsidePublicRow }]);

    const response = await app.fetch(new Request("http://marketplace.test/products/prod_1/listings"));

    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { items: Record<string, unknown>[] };
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([...publicListingKeys].sort());
    for (const privateValue of [
      "742 Evergreen Terrace",
      "Private Seller Name",
      "62704",
      "555-0142",
      "seller.private@example.test",
      "Back room bin 7",
      "item_private",
      "2.37",
      "19.13",
      "cts_private",
      "agr_private",
      "lock_private",
      "hash_private",
      "private-key.webp",
      "blocked_private",
      "acc_private_seller",
      "garage",
    ]) {
      expect(text).not.toContain(privateValue);
    }
  });

  it("serves a grade, an option and a gallery image key by key when the service returns them with other fields", async () => {
    const gradedCard = {
      gradingCompany: "PSA",
      grade: "Gem Mint 10",
      certificationNumber: "12345678",
      population: { populationAtGrade: 10, populationHigher: 0, source: "census", asOf: "2026-01-01" },
      conditionDescriptors: ["sharp corners"],
    };
    const asset = {
      role: "catalog-detail",
      publicUrl: "https://assets.test/photo_one/catalog-detail.webp",
      width: 480,
      height: 640,
      density: 1,
    };
    const image = { photoId: "photo_one", slotId: "front", viewKind: "front", altText: "Front", sortOrder: 0 };
    const { app } = appServing([
      {
        ...publicRow,
        selected_options: [{ dimensionId: "form", optionId: "graded", internalRank: 7 }],
        graded_card: {
          ...gradedCard,
          population: { ...gradedCard.population, fetchedBy: "usr_private" },
          internalNote: "bought at a show",
        },
        public_gallery: [
          {
            ...image,
            originalFilename: "secret-filename.png",
            assets: [{ ...asset, storageKey: "private/key/photo_one", byteSize: 1234 }],
          },
        ],
      },
    ]);

    const response = await app.fetch(new Request("http://marketplace.test/products/prod_1/listings"));

    expect(response.status).toBe(200);
    const text = await response.text();
    expect((JSON.parse(text) as { items: unknown[] }).items[0]).toEqual({
      ...publicRow,
      selected_options: [{ dimensionId: "form", optionId: "graded" }],
      graded_card: gradedCard,
      public_gallery: [{ ...image, assets: [asset] }],
    });
    for (const privateText of [
      "internalRank",
      "internalNote",
      "fetchedBy",
      "secret-filename",
      "private/key",
      "byteSize",
    ]) {
      expect(text).not.toContain(privateText);
    }
  });
});
