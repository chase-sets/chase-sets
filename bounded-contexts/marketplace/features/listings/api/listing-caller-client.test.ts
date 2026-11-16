import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createMarketplaceApiClient, type MarketplaceApiClient } from "../../../client";
import { hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";
import { listingFormAttempt } from "../../../support/request-support/listing-attempt";
import {
  marketplaceListingCanonicalRequest,
  type MarketplaceListingMutationKind,
} from "../../mutation-recovery/domain/contracts";

const idempotencyKey = "listing_client_attempt_0001";
const listingId = "lst_synthetic";
type CommandCase = {
  kind: MarketplaceListingMutationKind;
  request: Record<string, unknown>;
  send: (client: MarketplaceApiClient) => Promise<unknown>;
};
const cases: CommandCase[] = [
  {
    kind: "listing.create",
    request: { inventoryItemId: "inv_synthetic", priceAmount: "10.00", priceCurrencyCode: "USD", quantityCap: 1 },
    send: (c) =>
      c.createListing({
        idempotencyKey,
        inventoryItemId: "inv_synthetic",
        priceAmount: "10.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
      }),
  },
  { kind: "listing.publish", request: { listingId }, send: (c) => c.publishListing(listingId, { idempotencyKey }) },
  { kind: "listing.pause", request: { listingId }, send: (c) => c.pauseListing(listingId, { idempotencyKey }) },
  { kind: "listing.withdraw", request: { listingId }, send: (c) => c.withdrawListing(listingId, { idempotencyKey }) },
  {
    kind: "listing.update-price",
    request: { listingId, priceAmount: "10.00", priceCurrencyCode: "EUR" },
    send: (c) => c.updateListingPrice(listingId, { idempotencyKey, priceAmount: "10.00", priceCurrencyCode: "EUR" }),
  },
  {
    kind: "listing.update-quantity",
    request: { listingId, quantityCap: 2 },
    send: (c) => c.updateListingQuantityCap(listingId, { idempotencyKey, quantityCap: 2 }),
  },
  {
    kind: "listing.update-purchase-limits",
    request: { listingId, purchaseLimits: { maxUnitsPerOrder: 1 } },
    send: (c) => c.updateListingPurchaseLimits(listingId, { idempotencyKey, purchaseLimits: { maxUnitsPerOrder: 1 } }),
  },
  {
    kind: "seller.availability",
    request: { status: "unavailable", reasonCategory: "travel" },
    send: (c) => c.disableSellerListingAvailability({ idempotencyKey, reasonCategory: "travel" }),
  },
  {
    kind: "seller.availability",
    request: { status: "available" },
    send: (c) => c.enableSellerListingAvailability({ idempotencyKey }),
  },
  {
    kind: "seller.away",
    request: { action: "schedule", startsAt: "2026-12-01T00:00:00Z", reasonCategory: "travel" },
    send: (c) =>
      c.scheduleSellerAwayWindow({ idempotencyKey, startsAt: "2026-12-01T00:00:00Z", reasonCategory: "travel" }),
  },
  { kind: "seller.away", request: { action: "cancel" }, send: (c) => c.cancelScheduledAwayWindow({ idempotencyKey }) },
  {
    kind: "seller.order-capacity",
    request: { maxOpenOrders: 3 },
    send: (c) => c.setSellerOrderCapacity(3, { idempotencyKey }),
  },
  {
    kind: "seller.order-capacity",
    request: { maxOpenOrders: null },
    send: (c) => c.clearSellerOrderCapacity({ idempotencyKey }),
  },
];
function fixture() {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json({ id: listingId, version: 1 });
  });
  return {
    requests,
    fetch,
    client: createMarketplaceApiClient({ baseUrl: "http://localhost/api/marketplace", fetch }),
  };
}
describe("Listing caller identity", () => {
  it("reuses a submitted form identity, separates commands, and refuses a keyless form", () => {
    const form = new FormData();
    expect(() => listingFormAttempt(form, "create")).toThrow();
    form.set("idempotencyKey", idempotencyKey);
    expect(listingFormAttempt(form, "create")).toEqual(listingFormAttempt(form, "create"));
    expect(listingFormAttempt(form, "create")).not.toEqual(listingFormAttempt(form, "publish"));
  });
  it("forwards a supplied hash unchanged so the owner can reject a mismatched request", async () => {
    const f = fixture();
    await f.client.publishListing(listingId, { idempotencyKey, requestHash: "0".repeat(64) });
    expect((await f.requests[0]!.json()).requestHash).toBe("0".repeat(64));
  });
  it.each(cases)(
    "preserves the key and canonical hash across repeated $kind sends",
    async ({ kind, request, send }) => {
      const f = fixture();
      await send(f.client);
      await send(f.client);
      const hash = hashMarketplaceRequest(marketplaceListingCanonicalRequest(kind, request));
      for (const sent of f.requests) {
        const body = sent.method === "DELETE" ? {} : await sent.json();
        expect(body.idempotencyKey ?? sent.headers.get("Idempotency-Key")).toBe(idempotencyKey);
        expect(body.requestHash ?? sent.headers.get("Chase-Sets-Request-Hash")).toBe(hash);
      }
    },
  );
  it("rejects a keyless client call before transport; imported inputs reject decoupled keyless types", async () => {
    const f = fixture();
    expectTypeOf<{ priceAmount: string; priceCurrencyCode: string }>().not.toExtend<
      Parameters<MarketplaceApiClient["updateListingPrice"]>[1]
    >();
    await expect(f.client.publishListing(listingId, {} as never)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("carries one stable batch and a canonical hash per bulk price target", async () => {
    const f = fixture();
    const updates = [{ listingId, priceAmount: "10.00", priceCurrencyCode: "USD" }];
    await f.client.applyBulkListingPriceUpdates({ batchId: idempotencyKey, updates });
    expect(f.requests[0]!.headers.get("Idempotency-Key")).toBe(idempotencyKey);
    expect((await f.requests[0]!.json()).updates[0].requestHash).toBe(
      hashMarketplaceRequest(marketplaceListingCanonicalRequest("listing.update-price", updates[0]!)),
    );
  });
  it("requires a multipart caller key and hashes the normalized form fields", async () => {
    const f = fixture();
    const form = new FormData();
    form.set("inventoryItemId", "inv_synthetic");
    form.set("priceAmount", "10.00");
    form.set("priceCurrencyCode", "USD");
    form.set("quantityCap", "1");
    await expect(f.client.createListingWithPhotos(form)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    form.set("idempotencyKey", idempotencyKey);
    await f.client.createListingWithPhotos(form);
    const sent = await f.requests[0]!.formData();
    expect(sent.get("idempotencyKey")).toBe(idempotencyKey);
    expect(sent.get("requestHash")).toBe(
      hashMarketplaceRequest(
        marketplaceListingCanonicalRequest("listing.create", {
          inventoryItemId: "inv_synthetic",
          priceAmount: "10.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
        }),
      ),
    );
  });
});
