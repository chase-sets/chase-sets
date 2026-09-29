import { inspect } from "node:util";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { buildMarketplaceApi, type MarketplaceApiEnv } from "../../../api";
import { createMarketplaceServices } from "../../../support/runtime-support/services";
import { initialMarketplaceListingState } from "../domain/domain";
import { MarketplaceListingDomainError } from "../domain/listing-error";
import { MarketplaceListingBulkPriceUpdatePolicyError } from "../domain/bulk-price-update-policy";
import { MarketplaceEvidenceGovernanceError } from "../domain/evidence-governance";
import { MarketplaceListingGatePolicyError } from "../domain/listing-gate-policy";
import { MarketplaceListingRequestError } from "./listing-request-error";
import { createListingGatePolicyRoutes } from "./listing-gate-policy-route";
import { createAccountListingRoutes, createPublicListingRoutes } from "./route";
import {
  createMarketplaceListingRuntime,
  MarketplaceListingEvidenceIncompleteError,
  MarketplaceSalesFeeQuoteStaleError,
  type MarketplaceListingServices,
} from "./runtime";

const actor = {
  sessionId: "ses_test",
  tenantId: "tnt_test",
  userId: "usr_seller",
  accountId: "acc_seller",
  membershipId: "mbr_test",
  roleKey: "owner",
  permissions: ["listings.view", "listings.manage"],
};

function buildApp(
  services: Partial<MarketplaceListingServices>,
  options: {
    actor?: MarketplaceApiEnv["Variables"]["actor"];
    policies?: Partial<PolicyRuntime>;
    resolver?: RateLimitRuleResolver;
  } = {},
) {
  const app = new Hono<MarketplaceApiEnv>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("actor", options.actor === undefined ? actor : options.actor);
    c.set("context", { tenantId: "tnt_test" as never, audit: { performedByUserId: "usr_seller" as never } });
    await next();
  });
  app.route("/account", createAccountListingRoutes(services as MarketplaceListingServices, options.resolver));
  app.route("/", createPublicListingRoutes(services as MarketplaceListingServices, options.resolver));
  app.route("/listing-gate-policy", createListingGatePolicyRoutes((options.policies ?? {}) as PolicyRuntime));
  return app;
}

afterEach(() => vi.restoreAllMocks());

const createBody = { inventoryItemId: "inv_1", priceAmount: "10.00", priceCurrencyCode: "USD", quantityCap: 1 };
const readiness = { coverage: { complete: false } } as never;
const quote = { basis_amount: "10.00", fee_quote_fingerprint: "current" } as never;
const table = [
  ["unknown-field", "/account/listings", "createListing", 400, "listing_request_unknown_field", "unknownField"],
  [
    "price-currency-invalid",
    "/account/listings",
    "createListing",
    400,
    "listing_price_currency_invalid",
    "priceCurrencyInvalid",
  ],
  [
    "availability-reason-invalid",
    "/account/listing-availability/disable",
    "disableSellerListingAvailability",
    400,
    "listing_availability_reason_invalid",
    "availabilityReasonInvalid",
  ],
  [
    "away-window-reason-required",
    "/account/listing-availability/away-window",
    "scheduleSellerAwayWindow",
    400,
    "away_window_reason_required",
    "awayWindowReasonRequired",
  ],
  [
    "away-window-instant-required",
    "/account/listing-availability/away-window",
    "scheduleSellerAwayWindow",
    400,
    "away_window_instant_required",
    "awayWindowInstantRequired",
  ],
  [
    "order-capacity-invalid",
    "/account/order-capacity",
    "setSellerOrderCapacity",
    400,
    "order_capacity_invalid",
    "orderCapacityInvalid",
  ],
  [
    "photo-multipart-required",
    "/account/listings/lst_1/photos",
    "addListingPhotos",
    400,
    "listing_photo_multipart_required",
    "photoMultipartRequired",
  ],
  [
    "photo-replacement-required",
    "/account/listings/lst_1/photos/lpho_1/replace",
    "replaceListingPhoto",
    400,
    "listing_photo_replacement_required",
    "photoReplacementRequired",
  ],
  ["id-invalid", "/account/listings", "createListing", 400, "listing_request_id_invalid", "idInvalid"],
  [
    "inventory-snapshot-invalid",
    "/account/listings",
    "createListing",
    400,
    "listing_inventory_snapshot_invalid",
    "inventorySnapshotInvalid",
  ],
  ["listing-not-found", "/account/listings", "createListing", 404, "listing_not_found", "listingNotFound"],
  [
    "inventory-item-not-found",
    "/account/listings",
    "createListing",
    400,
    "inventory_item_not_found",
    "inventoryItemNotFound",
  ],
  [
    "command-rejected",
    "/account/listings/lst_1/pause",
    "pauseListing",
    400,
    "listing_command_rejected",
    "commandRejected",
  ],
  [
    "bulk-price-update-invalid",
    "/account/listings/prices/bulk",
    "applyBulkListingPriceUpdates",
    400,
    "bulk_price_update_invalid",
    "bulkPriceUpdateInvalid",
  ],
  ["evidence-invalid", "/account/listings", "createListing", 400, "listing_evidence_invalid", "evidenceInvalid"],
  [
    "listing-gate-policy-invalid",
    "/listing-gate-policy",
    "createListing",
    400,
    "listing_gate_policy_invalid",
    "gate.invalid",
  ],
  [
    "evidence-incomplete",
    "/account/listings/lst_1/publish",
    "publishListing",
    409,
    "listing_evidence_incomplete",
    "evidenceIncomplete",
  ],
  [
    "fee-quote-stale",
    "/account/listings/lst_1/quantity-cap",
    "updateListingQuantityCap",
    409,
    "fee_quote_stale",
    "feeQuoteStale",
  ],
] as const;

function tableError(code: (typeof table)[number][0]): Error {
  switch (code) {
    case "listing-not-found":
    case "inventory-item-not-found":
    case "command-rejected":
      return new MarketplaceListingDomainError(code, "postgres password=secret");
    case "bulk-price-update-invalid":
      return new MarketplaceListingBulkPriceUpdatePolicyError("postgres password=secret");
    case "evidence-invalid":
      return new MarketplaceEvidenceGovernanceError("postgres password=secret", "too-many-evidence");
    case "listing-gate-policy-invalid":
      return new MarketplaceListingGatePolicyError("postgres password=secret");
    case "evidence-incomplete":
      return new MarketplaceListingEvidenceIncompleteError(readiness);
    case "fee-quote-stale":
      return new MarketplaceSalesFeeQuoteStaleError(quote);
    default:
      return new MarketplaceListingRequestError(code, "postgres password=secret");
  }
}

function jsonRequest(body: unknown = createBody): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

describe("safe Listing errors", () => {
  it("redacts bulk price outcome messages without changing row outcomes or successful writes", async () => {
    const response = await buildApp({
      applyBulkListingPriceUpdates: vi.fn(async () => [
        { listingId: "lst_1", outcome: "applied", version: 2 },
        { listingId: "lst_2", outcome: "error", version: 0, message: "postgres password=secret" },
        { listingId: "lst_3", outcome: "conflict", version: 1, message: "nested-secret-body" },
      ]),
    }).request("/account/listings/prices/bulk", jsonRequest({ updates: [] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        { listingId: "lst_1", outcome: "applied", version: 2 },
        {
          listingId: "lst_2",
          outcome: "error",
          version: 0,
          message: t("marketplace.features.listings.api.route.request.failed"),
        },
        {
          listingId: "lst_3",
          outcome: "conflict",
          version: 1,
          message: t("marketplace.features.listings.api.route.request.failed"),
        },
      ],
      total: 3,
      count: 3,
    });
  });
  it.each([
    ["/account/listings", { ...createBody, unexpectedSecret: true }, "listing_request_unknown_field"],
    ["/account/listings", { ...createBody, priceCurrencyCode: "secret" }, "listing_price_currency_invalid"],
    ["/account/listing-availability/disable", { reasonCategory: "secret" }, "listing_availability_reason_invalid"],
    ["/account/listing-availability/away-window", { startsAt: "2026-10-01T00:00:00Z" }, "away_window_reason_required"],
    ["/account/listing-availability/away-window", { reasonCategory: "travel" }, "away_window_instant_required"],
    ["/account/order-capacity", { maxOpenOrders: 0 }, "order_capacity_invalid"],
    ["/account/listings/lst_1/photos", {}, "listing_photo_multipart_required"],
    ["/account/listings/lst_1/photos/lpho_1/replace", new FormData(), "listing_photo_replacement_required"],
  ] as const)(
    "preserves typed Listing conflict responses and closes request validation: %s %s",
    async (path, input, code) => {
      const app = buildApp({});
      const response = await app.request(
        path,
        input instanceof FormData ? { method: "POST", body: input } : jsonRequest(input),
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe(code);
      expect(JSON.stringify(body)).not.toMatch(/unexpectedSecret|secret|Expected '/);
    },
  );

  it.each([
    ["/account/listings", "listSellerListings"],
    ["/account/listing-availability", "getSellerListingAvailability"],
    ["/products/prod_1/listings", "listItemListings"],
    ["/products/prod_1/market-summary", "getMarketSummaryForItem"],
  ] as const)("redacts service failures on Listing/settings and public reads: %s", async (path, service) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const call = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("postgres password=secret"), { body: "nested-secret-body" }));
    const response = await buildApp({
      [service]: call,
      getSellerListingStatusCounts: vi.fn(async () => ({}) as never),
    }).request(path);
    expect(call).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
    expect(inspect([await response.json(), log.mock.calls], { depth: null })).not.toMatch(
      /password=secret|nested-secret-body/,
    );
  });

  it.each([
    new MarketplaceListingRequestError("unlisted" as never, "secret"),
    new MarketplaceListingRequestError("inventory-snapshot-invalid", "secret"),
    new MarketplaceEvidenceGovernanceError("secret", "unlisted" as never),
  ])("rejects an unlisted or endpoint-ineligible typed code: %s", async (error) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await buildApp({ pauseListing: vi.fn().mockRejectedValue(error) }).request(
      "/account/listings/lst_1/pause",
      { method: "POST" },
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("internal_error");
  });

  it("distinguishes real commandHandler rejection from an identical plain persistence failure through buildMarketplaceApi", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const plain of [false, true]) {
      const { eventStore } = createInMemoryEventStore();
      const context = { tenantId: "tnt_test" as never, audit: { performedByUserId: "usr_seller" as never } };
      await eventStore.appendToStream({
        streamId: "marketplace.listing-lst_1",
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "marketplace.listing.created",
            payload: { ...initialMarketplaceListingState, listingId: "lst_1", accountId: "acc_seller" },
          },
          ...(plain ? [{ eventType: "marketplace.listing.published", payload: {} }] : []),
        ],
      });
      const append = vi.spyOn(eventStore, "appendToStream");
      if (plain) append.mockRejectedValue(new Error("Only active listings can be paused."));
      const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
      const services = createMarketplaceServices(db);
      const listings = createMarketplaceListingRuntime({
        db,
        eventStore,
        commercialTermsResolver: services.commercialTermsResolver,
        checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
      });
      const app = new Hono<MarketplaceApiEnv>();
      app.onError(errorHandler);
      app.use("*", async (c, next) => {
        c.set("actor", actor);
        c.set("context", context);
        await next();
      });
      app.route("/api/marketplace", buildMarketplaceApi({ ...services, listings }));
      const response = await app.request("/api/marketplace/account/listings/lst_1/pause", { method: "POST" });
      expect(response.status).toBe(plain ? 500 : 400);
      expect((await response.json()).error.code).toBe(plain ? "internal_error" : "listing_command_rejected");
      expect(append).toHaveBeenCalledTimes(plain ? 1 : 0);
    }
    expect(inspect(log.mock.calls, { depth: null })).not.toContain("Only active listings can be paused.");
  });

  it.each([
    ["/account/listings", "createListing"],
    ["/guest/listing-draft-intents", "createAnonymousListingDraftIntent"],
    ["/terms/public-standard/listing-preview", "previewPublicStandardListingTerms"],
    ["/account/listing-availability/enable", "enableSellerListingAvailability"],
  ] as const)("fails adjacent typed families closed at %s", async (path, service) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const call = vi.fn().mockRejectedValue(new MarketplaceListingGatePolicyError("postgres password=secret"));
    const init = jsonRequest(path.startsWith("/guest") ? { priceCurrencyCode: "USD" } : createBody);
    init.headers = { ...init.headers, "x-marketplace-anonymous-listing-draft-id": "anon_test" };
    const response = await buildApp({ [service]: call }).request(path, init);
    expect(call).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
    expect(inspect([await response.json(), log.mock.calls], { depth: null })).not.toContain("password=secret");
  });
  it.each(table)(
    "maps closed table row %s to its endpoint, status, public code and localized copy",
    async (code, path, service, status, publicCode, copy) => {
      const failure = tableError(code);
      const reject = vi.fn().mockRejectedValue(failure);
      const app = buildApp({ [service]: reject }, { policies: { createPolicyDocument: reject } });
      let init = jsonRequest({
        ...createBody,
        maxOpenOrders: 1,
        reasonCategory: "travel",
        startsAt: "2026-10-01T00:00:00Z",
      });
      if (code.startsWith("photo-")) {
        const form = new FormData();
        form.set("listingPhoto", new File(["photo"], "photo.png", { type: "image/png" }));
        init = { method: "POST", body: form };
      }
      if (path === "/account/listings") init = jsonRequest();
      if (code === "bulk-price-update-invalid") init = jsonRequest({ updates: [] });
      const response = await app.request(path, init);
      const body = await response.json();
      expect(reject).toHaveBeenCalledOnce();
      expect(response.status).toBe(status);
      const key =
        copy === "gate.invalid"
          ? "marketplace.features.listings.api.listingGatePolicyRoute.error.invalid"
          : `marketplace.features.listings.api.route.error.${copy}`;
      expect(body.error.code).toBe(publicCode);
      expect(body.error.message).toBe(t(key));
      expect(body.error.message).not.toBe(key);
      expect(JSON.stringify(body)).not.toContain("password=secret");
      if (code === "evidence-incomplete") expect(body.error.currentEvidenceReadiness).toEqual(readiness);
      if (code === "fee-quote-stale") expect(body.error.currentQuote).toEqual(quote);
    },
  );

  it.each(["Listing not found.", "Inventory item not found."])(
    "redacts a plain create failure even when its message is %s",
    async (message) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const response = await buildApp({ createListing: vi.fn().mockRejectedValue(new Error(message)) }).request(
        "/account/listings",
        jsonRequest(),
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error.code).toBe("internal_error");
      expect(inspect([body, log.mock.calls], { depth: null })).not.toContain(message);
    },
  );

  it.each(["/account/listings", "/account/listings/evidence-readiness/preview"])(
    "closes malformed inventoryItemId at %s before services",
    async (path) => {
      const call = vi.fn();
      const response = await buildApp({ createListing: call, previewListingEvidenceReadiness: call }).request(
        path,
        jsonRequest({ ...createBody, inventoryItemId: "secret" }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "listing_request_id_invalid",
          message: t("marketplace.features.listings.api.route.error.idInvalid"),
        },
      });
      expect(call).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed JPEG IDs before resolver or I/O and preserves the not_found body", async () => {
    const io = vi.fn(async () => null);
    const resolver = vi.fn<RateLimitRuleResolver>(async (_surface, defaults) => defaults);
    const app = buildApp({ getListingPhotoJpeg: io }, { resolver });
    for (const path of [
      "/account/listings/secret/photos/lpho_secret/jpeg",
      "/account/listings/lst_01ARZ3NDEKTSV4RRFFQ69G5FAV/photos/secret/jpeg",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "listing_request_id_invalid",
          message: t("marketplace.features.listings.api.route.error.idInvalid"),
        },
      });
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(io).not.toHaveBeenCalled();
    const missing = await app.request(
      "/account/listings/lst_01ARZ3NDEKTSV4RRFFQ69G5FAV/photos/lpho_01ARZ3NDEKTSV4RRFFQ69G5FAW/jpeg",
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "Listing not found." } });
  });

  it("closes malformed snapshots without parser details or service calls", async () => {
    const call = vi.fn();
    const app = buildApp({ createListing: call, createListingFromInventorySnapshot: call });
    const address = {
      name: "Seller",
      line1: "1 Main",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    };
    for (const inventorySnapshot of [
      { shipFromAddress: { name: "secret" } },
      { shipFromAddress: address, gradedCard: { gradingCompany: "secret", grade: {} } },
    ]) {
      const response = await app.request("/account/listings", jsonRequest({ ...createBody, inventorySnapshot }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "listing_inventory_snapshot_invalid",
          message: t("marketplace.features.listings.api.route.error.inventorySnapshotInvalid"),
        },
      });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it.each([null, { ...actor, permissions: [] }])(
    "keeps Listing authorization ahead of safe error mapping: %s",
    async (unauthorized) => {
      const call = vi.fn().mockRejectedValue(new Error("secret"));
      const app = buildApp(
        { createListing: call, getListingPhotoJpeg: call },
        { actor: unauthorized, policies: { createPolicyDocument: call } },
      );
      for (const path of ["/account/listings", "/listing-gate-policy"]) {
        const response = await app.request(path, jsonRequest());
        expect(response.status).toBe(unauthorized === null ? 401 : 403);
      }
      expect((await app.request("/account/listings/secret/photos/secret/jpeg")).status).toBe(
        unauthorized === null ? 401 : 403,
      );
      expect(call).not.toHaveBeenCalled();
    },
  );
  it.each([
    [new MarketplaceListingDomainError("command-rejected", "Listing is withdrawn."), 400, "listing_command_rejected"],
    [new Error("Listing is withdrawn."), 500, "internal_error"],
    [new MarketplaceListingDomainError("unlisted" as never, "Listing is withdrawn."), 500, "internal_error"],
  ] as const)(
    "maps known Listing errors without message classification and fails adjacent unknowns closed: %s",
    async (error, status, code) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const app = buildApp({ pauseListing: vi.fn().mockRejectedValue(error) });
      const response = await app.request("/account/listings/lst_1/pause", { method: "POST" });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    },
  );

  it("redacts unknown Listing failures through the real error boundary", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const failure of [
      Object.assign(new Error("postgres password=secret"), { body: { nested: "nested-secret-body" } }),
      { message: "postgres password=secret", body: { nested: "nested-secret-body" } },
      Object.assign(new Error("postgres password=secret"), { name: "UnknownDomainError" }),
      Object.assign(new Error("postgres password=secret"), { name: "TypedIdBoundaryDomainError" }),
    ]) {
      log.mockClear();
      const app = buildApp({ pauseListing: vi.fn().mockRejectedValue(failure) });
      const response = await app.request("/account/listings/lst_1/pause", { method: "POST" });
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: "internal_error" } });
      expect(inspect([body, log.mock.calls], { depth: null })).not.toMatch(/password=secret|nested-secret-body/);
      expect(log).toHaveBeenCalled();
    }
  });
});
