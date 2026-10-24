import { describe, expect, it } from "vitest";
import {
  canonicalDraftValue,
  inventoryDraftListingErrorCodes,
  inventoryDraftListingUnavailableDiagnostics,
  inventoryDraftListingMessageSchema,
  inventoryDraftListingReceiptSchema,
  listingIdForInventoryDraftRow,
} from "./index";
import type { InventoryDraftListingUnavailableDiagnostic } from "./index";

const receipt = {
  schemaVersion: "inventory-draft-listing-receipt/v1",
  messageVersion: "inventory-draft-listing/v1",
  messageId: "imr_batch_1",
  tenantId: "tnt_owner",
  accountId: "acc_owner",
  performedByUserId: "usr_owner",
  importBatchId: "imb_batch",
  importRowId: "imr_batch_1",
  intentHash: "a".repeat(64),
  listingId: "lst_batch_1",
  listingVersion: 1,
  feeQuoteFingerprint: "quote_v1",
  acceptedAt: "2026-10-19T12:00:00.000Z",
  source: "message",
};

describe("Inventory draft receipt v1", () => {
  it("keeps the producer error vocabulary closed", () => {
    expect(inventoryDraftListingErrorCodes).toEqual(["inventory-draft-conflict", "inventory-draft-unavailable"]);
    expect(inventoryDraftListingUnavailableDiagnostics).toEqual([
      "listing-rejected",
      "unexpected-failure",
      "receipt-ledger-not-ready",
      "consumer-unbound",
    ]);
  });

  it("rejects non-member unavailable diagnostics at the contract type boundary", () => {
    // @ts-expect-error diagnostics are intentionally a closed vocabulary.
    const invalid: InventoryDraftListingUnavailableDiagnostic = "provider-secret";
    expect(inventoryDraftListingUnavailableDiagnostics).not.toContain(invalid as never);
  });

  it.each(["purchaseLimits", "gradedCard", "availableQuantity"])("rejects removed snapshot key %s", (key) => {
    const snapshot = {
      importBatchId: "imb_batch",
      importRowId: "imr_batch_1",
      committedAt: "2026-10-19T12:00:00.000Z",
      inventoryItemId: "inv_batch",
      catalogItemId: "cat_batch",
      productId: "cat_batch::",
      selectedOptions: [],
      storageLocationId: "loc_batch",
      storageLocationName: "Warehouse",
      shipFromCode: "US-IL",
      shipFromAddress: {
        name: "Seller",
        line1: "1 Main St",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
      totalQuantity: 2,
      acquisitionCostAmount: null,
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      quantityCap: 2,
      [key]:
        key === "purchaseLimits" ? { maxUnitsPerOrder: 2, maxUnitsPerDay: 2, maxUnitsPerCustomerAccount: 2 } : null,
    };
    expect(
      inventoryDraftListingMessageSchema.safeParse({
        schemaVersion: "inventory-draft-listing/v1",
        messageId: "imr_batch_1",
        authority: { tenantId: "tnt_owner", accountId: "acc_owner", performedByUserId: "usr_owner" },
        snapshot,
      }).success,
    ).toBe(false);
  });

  it("rejects zero price and a cap above total quantity", () => {
    const base = {
      schemaVersion: "inventory-draft-listing/v1" as const,
      messageId: "imr_batch_1",
      authority: { tenantId: "tnt_owner", accountId: "acc_owner", performedByUserId: "usr_owner" },
      snapshot: {
        importBatchId: "imb_batch",
        importRowId: "imr_batch_1",
        committedAt: "2026-10-19T12:00:00.000Z",
        inventoryItemId: "inv_batch",
        catalogItemId: "cat_batch",
        productId: "cat_batch::",
        selectedOptions: [],
        storageLocationId: "loc_batch",
        storageLocationName: "Warehouse",
        shipFromCode: "US-IL",
        shipFromAddress: {
          name: "Seller",
          line1: "1 Main St",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
        totalQuantity: 2,
        acquisitionCostAmount: null,
        priceAmount: "10.00",
        priceCurrencyCode: "USD",
        quantityCap: 2,
      },
    };
    expect(
      inventoryDraftListingMessageSchema.safeParse({ ...base, snapshot: { ...base.snapshot, priceAmount: "0.00" } })
        .success,
    ).toBe(false);
    expect(
      inventoryDraftListingMessageSchema.safeParse({ ...base, snapshot: { ...base.snapshot, quantityCap: 3 } }).success,
    ).toBe(false);
  });

  it("is a closed versioned result with an exact row/message/listing binding", () => {
    expect(inventoryDraftListingReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(listingIdForInventoryDraftRow(receipt.importRowId)).toBe(receipt.listingId);
  });
  it.each([
    { raw: "private" },
    { schemaVersion: "inventory-draft-listing-receipt/v2" },
    { messageVersion: "inventory-draft-listing/v2" },
    { messageId: "imr_other" },
    { listingId: "lst_other" },
    { intentHash: "unknown" },
    { acceptedAt: "2026-10-19" },
    { acceptedAt: "2026-10-19T12:00:00" },
    { listingVersion: "1" },
    { duration: 100 },
  ])("rejects changed or unknown receipt fields: %j", (change) => {
    expect(inventoryDraftListingReceiptSchema.safeParse({ ...receipt, ...change }).success).toBe(false);
  });
  it("canonicalizes recursive key order, but not array or presence changes", () => {
    expect(canonicalDraftValue({ b: [{ d: 2, c: 1 }], a: null })).toBe(
      canonicalDraftValue({ a: null, b: [{ c: 1, d: 2 }] }),
    );
    expect(canonicalDraftValue({ a: null })).not.toBe(canonicalDraftValue({}));
  });
});
