import { sendListingCommandsWithFreshAttempts } from "../tests/listing-attempt-test-support";
import { Hono } from "hono";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketplaceApiEnv } from "../../../api";
import { action } from "../../../routes/account-listings-new";
import { initialMarketplaceListingState, normalizePurchaseLimits } from "../domain/domain";
import { MarketplaceListingDomainError } from "../domain/listing-error";
import { createAccountListingRoutes } from "./route";
import type { MarketplaceListingServices } from "./runtime";

vi.mock("@chase-sets/platform-runtime/post-write-token-store", () => ({
  getDefaultPostWriteTokenStore: () => ({
    storePostWriteToken: async () => "pwt_photo00000000000000000001",
    resolvePostWriteToken: async () => null,
  }),
}));

const actor: NonNullable<MarketplaceApiEnv["Variables"]["actor"]> = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_seller",
  accountId: "acc_seller",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["listings.view", "listings.manage"],
};
const limitKeys = ["maxUnitsPerOrder", "maxUnitsPerDay", "maxUnitsPerCustomerAccount"] as const;
const populatedLimits = { maxUnitsPerOrder: 1, maxUnitsPerDay: 2, maxUnitsPerCustomerAccount: 3 };
const unlimited = { maxUnitsPerOrder: null, maxUnitsPerDay: null, maxUnitsPerCustomerAccount: null };
// This accepted snapshot isolates the separately owned Inventory snapshot contract repair.
const snapshot = {
  inventoryItemId: "inv_1",
  catalogItemId: "cat_charizard",
  productId: "cat_charizard::dim_condition:near_mint",
  selectedOptions: [{ dimensionId: "dim_condition", optionId: "near_mint" }],
  gradedCard: null,
  storageLocationId: "loc_1",
  storageLocationName: "Listing stock",
  shipFromCode: "CHI",
  shipFromAddress: {
    name: "Seller",
    line1: "100 Market St",
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
  },
  totalQuantity: 7,
  availableQuantity: 7,
  acquisitionCostAmount: null,
};
const supplyItem = {
  item_id: snapshot.inventoryItemId,
  catalog_catalog_item_id: snapshot.catalogItemId,
  product_id: snapshot.productId,
  selected_options: snapshot.selectedOptions,
  graded_card: snapshot.gradedCard,
  storage_location_id: snapshot.storageLocationId,
  storage_location_name: snapshot.storageLocationName,
  ship_from_code: snapshot.shipFromCode,
  ship_from_address: snapshot.shipFromAddress,
  total_quantity: snapshot.totalQuantity,
  available_quantity: snapshot.availableQuantity,
  acquisition_cost_amount: snapshot.acquisitionCostAmount,
};
type StockPath = "existing inventory" | "Listing stock" | "supply fallback";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function submitPhotoCreate(stockPath: StockPath, intent: string, limits: Partial<Record<string, string>>) {
  const created: Awaited<ReturnType<MarketplaceListingServices["createListing"]>> = {
    listingId: "lst_photo" as never,
    version: 1,
    feeQuoteFingerprint: "photo-fee-quote",
    state: initialMarketplaceListingState,
  };
  const createListing = vi.fn(async (input: Parameters<MarketplaceListingServices["createListing"]>[0]) => {
    if (stockPath === "supply fallback") {
      throw new MarketplaceListingDomainError("inventory-item-not-found", "Inventory item not found.");
    }
    normalizePurchaseLimits(input.purchaseLimits, input.quantityCap);
    return created;
  });
  const createListingFromInventorySnapshot = vi.fn<MarketplaceListingServices["createListingFromInventorySnapshot"]>(
    async (input) => {
      normalizePurchaseLimits(input.purchaseLimits, input.quantityCap);
      return created;
    },
  );
  const publishListing = vi.fn<MarketplaceListingServices["publishListing"]>(async () => ({
    listingId: "lst_photo",
    version: 2,
  }));
  const app = sendListingCommandsWithFreshAttempts(new Hono<MarketplaceApiEnv>());
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", {
      tenantId: "tnt_identity" as never,
      audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
    });
    await next();
  });
  app.route(
    "/api/marketplace/account",
    createAccountListingRoutes({
      createListing,
      createListingFromInventorySnapshot,
      publishListing,
    } as unknown as MarketplaceListingServices),
  );
  const requests: FormData[] = [];
  const responses: Array<{ status: number; body: unknown }> = [];
  const ensureListingStock = vi.fn(() => Response.json({ snapshot }));
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return Response.json({ actor });
    if (path === "/api/inventory/items/listing-stock/ensure") return ensureListingStock();
    if (path === "/api/marketplace/account/listing-inventory") {
      return Response.json({ items: [supplyItem], total: 1, count: 1 });
    }
    if (path === "/api/marketplace/account/listings") {
      requests.push(await request.clone().formData());
      const response = await app.fetch(request);
      responses.push({ status: response.status, body: await response.clone().json() });
      return response;
    }
    if (path === "/api/marketplace/account/listings/lst_photo/publish") return app.fetch(request);
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  const form = new FormData();
  for (const [key, value] of Object.entries({
    intent,
    // The create page renders one Listing attempt per form, which the create and publish commands both carry.
    attemptId: "create_page_attempt_0001",
    inventoryItemId: stockPath === "Listing stock" ? "" : "inv_1",
    catalogItemId: "cat_charizard",
    priceAmount: "987.00",
    priceCurrencyCode: "USD",
    quantityCap: "7",
    ...limits,
  })) {
    if (value !== undefined) form.set(key, value);
  }
  form.append("evidence", new File([png], "photo.png", { type: "image/png" }));
  const result = await action({
    request: new Request("http://marketplace.test/account/listings/new", { method: "POST", body: form }),
    params: {},
    context: undefined,
  } as never);
  return {
    result,
    requests,
    responses,
    createListing,
    createListingFromInventorySnapshot,
    publishListing,
    ensureListingStock,
    png,
  };
}

describe("listing photo create action to multipart route", () => {
  for (const stockPath of ["existing inventory", "Listing stock", "supply fallback"] as const) {
    for (const intent of ["create-listing", "create-and-publish-listing"]) {
      it.each([
        {
          label: "populated",
          fields: { maxUnitsPerOrder: "1", maxUnitsPerDay: "2", maxUnitsPerCustomerAccount: "3" },
          expected: populatedLimits,
        },
        {
          label: "blank",
          fields: { maxUnitsPerOrder: "", maxUnitsPerDay: "", maxUnitsPerCustomerAccount: "" },
          expected: unlimited,
        },
        { label: "omitted", fields: {}, expected: unlimited },
      ])(`${stockPath} / ${intent} / $label limits creates the draft with its photo`, async ({ fields, expected }) => {
        const run = await submitPhotoCreate(stockPath, intent, fields);
        expect(run.responses.at(-1)).toMatchObject({ status: 201, body: { id: "lst_photo", status: "draft" } });
        expect(run.result).toBeInstanceOf(Response);
        expect((run.result as Response).status).toBe(302);
        expect((run.result as Response).headers.get("Location")).toContain(
          "/account/listings/lst_photo?evidenceEvent=",
        );
        expect(run.requests).toHaveLength(stockPath === "supply fallback" ? 2 : 1);
        for (const request of run.requests) {
          expect(request.has("purchaseLimits")).toBe(false);
          for (const key of limitKeys) {
            expect(request.get(key)).toBe(expected[key] === null ? null : String(expected[key]));
          }
        }
        const service = stockPath === "existing inventory" ? run.createListing : run.createListingFromInventorySnapshot;
        expect(service).toHaveBeenCalledWith(
          expect.objectContaining({
            purchaseLimits: expected,
            priceAmount: "987.00",
            priceCurrencyCode: "USD",
            quantityCap: 7,
            listingPhotoUploads: [
              { body: new Uint8Array(run.png), contentType: "image/png", originalFilename: "photo.png", altText: null },
            ],
          }),
          expect.any(Object),
        );
        expect(run.ensureListingStock).toHaveBeenCalledTimes(stockPath === "Listing stock" ? 1 : 0);
        if (stockPath !== "existing inventory") {
          expect(run.createListingFromInventorySnapshot).toHaveBeenCalledWith(
            expect.objectContaining(snapshot),
            expect.any(Object),
          );
        }
        if (stockPath === "supply fallback") {
          expect(run.responses[0]).toMatchObject({
            status: 400,
            body: { error: { code: "inventory_item_not_found" } },
          });
        }
        expect(run.publishListing).toHaveBeenCalledTimes(intent === "create-and-publish-listing" ? 1 : 0);
      });
    }
  }

  it.each(limitKeys.flatMap((key) => ["0", "-1", "1.5"].map((value) => ({ key, value }))))(
    "refuses invalid $key=$value through the action and real route",
    async ({ key, value }) => {
      const run = await submitPhotoCreate("existing inventory", "create-listing", { [key]: value });
      expect(run.requests[0]?.get(key)).toBe(value);
      expect(run.responses).toMatchObject([{ status: 400, body: { error: { code: "listing_command_rejected" } } }]);
      expect(run.result).toMatchObject({ error: expect.any(String) });
      expect(run.publishListing).not.toHaveBeenCalled();
    },
  );
});
