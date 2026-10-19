import { describe, expect, it } from "vitest";
import { canonicalDraftValue, inventoryDraftListingReceiptSchema, listingIdForInventoryDraftRow } from "./index";

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
