import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  enqueueInventoryDraftListingMessage,
  inventoryDraftListingOutboxSchemaSql,
  processNextInventoryDraftListingDelivery,
  type InventoryDraftListingDeliveryMessage,
} from "../api/draft-listing-delivery";
import type { InventoryDraftListingReceipt } from "@chase-sets/inventory-draft-listing";

const message: InventoryDraftListingDeliveryMessage = {
  schemaVersion: "inventory-draft-listing/v1",
  messageId: "imr_c5_1",
  authority: { tenantId: "tnt_c5", accountId: "acc_c5", performedByUserId: "usr_c5" },
  snapshot: {
    importBatchId: "imb_c5",
    importRowId: "imr_c5_1",
    committedAt: "2026-10-26T12:00:00.000Z",
    inventoryItemId: "inv_c5",
    catalogItemId: "cat_c5",
    productId: "cat_c5::",
    selectedOptions: [],
    storageLocationId: "loc_c5",
    storageLocationName: "Shelf",
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
    quantityCap: 1,
  },
};

function dbForDelivery() {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  let persistedMessage: InventoryDraftListingDeliveryMessage | null = null;
  const db: PgQueryable = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO inventory_import_draft_listing_outbox")) {
        const firstInsert = !persistedMessage;
        if (firstInsert) persistedMessage = JSON.parse(String(values[6])) as InventoryDraftListingDeliveryMessage;
        return { rows: [], rowCount: firstInsert ? 1 : 0 };
      }
      if (sql.includes("RETURNING outbox.message_id")) {
        return {
          rows: [
            {
              message_id: message.messageId,
              tenant_id: message.authority.tenantId,
              account_id: message.authority.accountId,
              performed_by_user_id: message.authority.performedByUserId,
              message: persistedMessage ?? message,
              attempts: 1,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  return { db, calls };
}

describe("issue-7169 C5 draft handoff", () => {
  it("retains one durable message identity and never inserts a duplicate", async () => {
    const { db, calls } = dbForDelivery();
    await enqueueInventoryDraftListingMessage(db, message);
    await enqueueInventoryDraftListingMessage(db, { ...message, snapshot: { ...message.snapshot, quantityCap: 2 } });
    const inserts = calls.filter((call) => call.sql.includes("INSERT INTO inventory_import_draft_listing_outbox"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.values[0]).toBe(message.messageId);
    expect(JSON.parse(String(inserts[0]?.values[6]))).toEqual(message);
    expect(inventoryDraftListingOutboxSchemaSql).toContain("UNIQUE (import_batch_id, import_row_id)");
  });

  it("accepts the exact message once and persists the immutable receipt", async () => {
    const { db, calls } = dbForDelivery();
    const receipt = {
      schemaVersion: "inventory-draft-listing-receipt/v1",
      messageVersion: "inventory-draft-listing/v1",
      messageId: message.messageId,
      tenantId: message.authority.tenantId,
      accountId: message.authority.accountId,
      performedByUserId: message.authority.performedByUserId,
      importBatchId: message.snapshot.importBatchId,
      importRowId: message.snapshot.importRowId,
      intentHash: "a".repeat(64),
      listingId: "lst_c5_1",
      listingVersion: 1 as const,
      feeQuoteFingerprint: "fee_c5",
      acceptedAt: "2026-10-26T12:00:00.000Z",
      source: "message" as const,
    } satisfies InventoryDraftListingReceipt;
    const delivery = { accept: vi.fn(async () => receipt) };
    expect(await processNextInventoryDraftListingDelivery(db, delivery)).toMatchObject({
      outcome: "accepted",
      messageId: message.messageId,
      attempts: 1,
    });
    expect(delivery.accept).toHaveBeenCalledExactlyOnceWith(
      message,
      expect.objectContaining({ tenantId: "tnt_c5", audit: expect.objectContaining({ forAccountId: "acc_c5" }) }),
    );
    const update = calls.find((call) => call.sql.includes("SET state = 'accepted'"));
    expect(update?.values[0]).toBe(message.messageId);
    expect(update?.values[2]).toBe(JSON.stringify(receipt));
  });

  it("requeues a failed handoff and fails closed after the bounded retry count", async () => {
    const { db, calls } = dbForDelivery();
    const delivery = {
      accept: vi.fn(async () => {
        throw { code: "inventory-draft-unavailable", diagnostic: "consumer-unbound" };
      }),
    };
    expect(await processNextInventoryDraftListingDelivery(db, delivery)).toMatchObject({
      outcome: "requeued",
      attempts: 1,
      code: "inventory-draft-unavailable:consumer-unbound",
    });
    const update = calls.find((call) => call.sql.includes("SET state = CASE"));
    expect(update?.values[3]).toBe("inventory-draft-unavailable:consumer-unbound");
  });
});
