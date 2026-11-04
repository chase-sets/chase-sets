import { expect, test, type APIResponse } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  createPostWriteTokenPayloadFromSources,
  decodeCommitReceipt,
  encodeFreshWriteReceipt,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
import { signInWithPassword } from "./support/auth";
import { marketplaceBrowserE2eBuyerCredentials, marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

test("accepted Offer is present on the first receipted Sales read @marketplace-seller @browser-e2e-seed", async ({
  page,
  browser,
}, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL);
  await signInWithPassword(page, baseURL, marketplaceBrowserE2eSellerCredentials());
  const buyerContext = await browser.newContext({ baseURL });
  const writes: { commitPositions: readonly SourceCommitPosition[] }[] = [];
  let listingId: string | undefined;
  async function committed(response: APIResponse, status: number) {
    expect(response.status(), await response.text()).toBe(status);
    const commitPositions = decodeCommitReceipt(response.headers()[CHASE_SETS_COMMIT_RECEIPT_HEADER.toLowerCase()]);
    expect(commitPositions.length, "real write receipt").toBeGreaterThan(0);
    writes.push({ commitPositions });
    return response.json();
  }
  function headers(target: string) {
    const payload = createPostWriteTokenPayloadFromSources(writes);
    expect(payload, "write receipts must be present").not.toBeNull();
    return {
      [CHASE_SETS_READ_AFTER_WRITE_HEADER]: encodeFreshWriteReceipt(payload!.receipt),
      [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: target,
    };
  }
  const address = {
    name: "Handoff fixture",
    company: null,
    line1: "100 Market Street",
    line2: null,
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
    phone: null,
    email: null,
  };
  const catalogItemId = "cat_seed_surging_sparks_booster_box";
  try {
    const buyer = await buyerContext.newPage();
    await signInWithPassword(buyer, baseURL, marketplaceBrowserE2eBuyerCredentials());
    const unique = randomUUID();
    const location = await committed(
      await page.request.post("/api/inventory/storage-locations", {
        headers: { "Inventory-Mutation-Attempt": randomUUID() },
        data: {
          name: `Offer Sales ${unique}`,
          shipFromCode: `handoff-${unique}`,
          shipFromAddress: address,
        },
      }),
      201,
    );
    const freshLocations = await page.request.get("/api/inventory/storage-locations", {
      headers: headers("inventory"),
    });
    expect(freshLocations.status()).toBe(200);
    const stock = await committed(
      await page.request.post("/api/inventory/items", {
        headers: { "Inventory-Mutation-Attempt": randomUUID() },
        data: {
          catalogItemId,
          selectedOptions: [],
          storageLocationId: location.id,
          totalQuantity: 1,
        },
      }),
      201,
    );
    const stockRead = await page.request.get(`/api/inventory/items/${stock.id}`, { headers: headers("inventory") });
    expect(stockRead.status()).toBe(200);
    const item = await stockRead.json();
    expect(item.item_id).toBe(stock.id);
    const { verification: _verification, ...shipFromAddress } = item.ship_from_address;
    const listing = await committed(
      await page.request.post("/api/marketplace/account/listings", {
        data: {
          idempotencyKey: `e2e_create_${randomUUID().replaceAll("-", "")}`,
          inventoryItemId: stock.id,
          priceAmount: "150.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          inventorySnapshot: {
            inventoryItemId: item.item_id,
            catalogItemId: item.catalog_catalog_item_id,
            productId: item.product_id,
            selectedOptions: item.selected_options,
            gradedCard: item.graded_card,
            storageLocationId: item.storage_location_id,
            storageLocationName: item.storage_location_name,
            shipFromCode: item.ship_from_code,
            shipFromAddress,
            totalQuantity: item.total_quantity,
            availableQuantity: item.available_quantity,
            acquisitionCostAmount: item.acquisition_cost_amount,
          },
        },
      }),
      201,
    );
    listingId = listing.id;
    await committed(
      await page.request.post(`/api/marketplace/account/listings/${listingId}/publish`, {
        data: {
          idempotencyKey: `e2e_publish_${randomUUID().replaceAll("-", "")}`,
          feeQuoteFingerprint: listing.feeQuoteFingerprint,
        },
      }),
      200,
    );
    const offer = await committed(
      await buyer.request.post("/api/marketplace/account/offers/submitted", {
        data: {
          attemptId: randomUUID(),
          catalogItemId,
          productId: `${catalogItemId}::`,
          itemTitle: "Surging Sparks Booster Box",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          shippingDestinationSnapshot: address,
          priceAmount: "150.00",
          priceCurrencyCode: "USD",
          quantityRequested: 1,
        },
      }),
      201,
    );
    // Establish only setup-input readiness before acceptance. There is no Sales read or extra write after acceptance.
    const inputRead = await page.request.get("/api/marketplace/account/purchases", {
      headers: headers("ordering"),
    });
    expect(inputRead.status()).toBe(200);
    const quoteRead = await page.request.get(
      `/api/marketplace/account/offers/matches/${offer.id}/terms-preview?listingId=${listingId}`,
      { headers: headers("marketplace") },
    );
    expect(quoteRead.status()).toBe(200);
    const quote = await quoteRead.json();
    const accepted = await page.request.post(`/api/marketplace/account/offers/matches/${offer.id}/accept`, {
      data: {
        listingId,
        feeQuoteFingerprint: quote.fee_quote_fingerprint,
        sourceActionKey: randomUUID(),
      },
    });
    await committed(accepted, 201);
    const sales = await page.request.get("/api/marketplace/account/sales", { headers: headers("ordering") });
    expect(sales.status(), await sales.text()).toBe(200);
    const result = await sales.json();
    const orders = result.items.filter(
      (order: { source_reference_id: string }) => order.source_reference_id === offer.id,
    );
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ source_type: "offer-acceptance", source_reference_id: offer.id });
  } finally {
    if (listingId) {
      const withdrawn = await page.request.post(`/api/marketplace/account/listings/${listingId}/withdraw`, {
        data: { idempotencyKey: `e2e_withdraw_${randomUUID().replaceAll("-", "")}` },
      });
      expect(withdrawn.status()).toBe(200);
    }
    await buyerContext.close();
  }
});
