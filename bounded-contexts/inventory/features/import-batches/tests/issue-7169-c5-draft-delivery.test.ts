import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  enqueueInventoryDraftListingMessage,
  inventoryDraftListingOutboxSchemaSql,
  processNextInventoryDraftListingDelivery,
} from "../api/draft-listing-delivery";

const message = {
  schemaVersion: "inventory-draft-listing/v1" as const,
  messageId: "imr_c5_1",
  authority: { tenantId: "tnt_c5", accountId: "acc_c5", performedByUserId: "usr_c5" },
  snapshot: { importBatchId: "imb_c5", importRowId: "imr_c5_1", quantityCap: 1 },
};

function dbForDelivery() {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const db: PgQueryable = {
    query: vi.fn(async <Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("RETURNING outbox.message_id")) {
        return {
          rows: [
            {
              message_id: message.messageId,
              tenant_id: message.authority.tenantId,
              account_id: message.authority.accountId,
              performed_by_user_id: message.authority.performedByUserId,
              message,
            } as Row,
          ],
          rowCount: 1,
        };
      }
      return { rows: [] as Row[], rowCount: 1 };
    }),
  };
  return { db, calls };
}

describe("issue-7169 C5 draft handoff", () => {
  it("retains one durable message identity and never inserts a duplicate", async () => {
    const { db, calls } = dbForDelivery();
    await enqueueInventoryDraftListingMessage(db, message);
    const insert = calls[0]!;
    expect(insert.sql).toContain("ON CONFLICT (message_id) DO NOTHING");
    expect(insert.values[0]).toBe(message.messageId);
    expect(inventoryDraftListingOutboxSchemaSql).toContain("UNIQUE (import_batch_id, import_row_id)");
  });

  it("accepts the exact message once and persists the immutable receipt", async () => {
    const { db, calls } = dbForDelivery();
    const receipt = { messageId: message.messageId, listingId: "lst_c5_1" };
    const delivery = { accept: vi.fn(async () => receipt), readReceipt: vi.fn(async () => receipt) };
    expect(await processNextInventoryDraftListingDelivery(db, delivery)).toBe(1);
    expect(delivery.accept).toHaveBeenCalledExactlyOnceWith(
      message,
      expect.objectContaining({ tenantId: "tnt_c5", audit: expect.objectContaining({ forAccountId: "acc_c5" }) }),
    );
    const update = calls.find((call) => call.sql.includes("SET state = 'accepted'"));
    expect(update?.values[0]).toBe(message.messageId);
    expect(update?.values[1]).toBe(JSON.stringify(receipt));
  });

  it("requeues a failed handoff and fails closed after the bounded retry count", async () => {
    const { db, calls } = dbForDelivery();
    const delivery = {
      accept: vi.fn(async () => {
        throw new Error("consumer unavailable");
      }),
      readReceipt: vi.fn(async () => null),
    };
    expect(await processNextInventoryDraftListingDelivery(db, delivery)).toBe(1);
    const update = calls.find((call) => call.sql.includes("SET state = CASE"));
    expect(update?.sql).toContain("attempts >= 8");
    expect(update?.values[1]).toBe("consumer unavailable");
  });
});
