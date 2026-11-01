import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { InventoryDraftListingMessage, InventoryDraftListingReceipt } from "@chase-sets/inventory-draft-listing";
import { module as inventoryModule } from "../../../index";
import {
  enqueueInventoryDraftListingMessage,
  processNextInventoryDraftListingDelivery,
} from "../api/draft-listing-delivery";
import { getImportBatch } from "../read-model/queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for draft listing delivery DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

function message(messageId: string): InventoryDraftListingMessage {
  return {
    schemaVersion: "inventory-draft-listing/v1",
    messageId,
    authority: { tenantId: "tnt_delivery_db", accountId: "acc_delivery_db", performedByUserId: "usr_delivery_db" },
    snapshot: {
      importBatchId: "imb_delivery_db",
      importRowId: messageId,
      committedAt: "2026-10-26T12:00:00.000Z",
      inventoryItemId: "inv_delivery_db",
      catalogItemId: "cat_delivery_db",
      productId: "cat_delivery_db::",
      selectedOptions: [],
      storageLocationId: "loc_delivery_db",
      storageLocationName: "Synthetic shelf",
      shipFromCode: "US-IL",
      shipFromAddress: {
        name: "Synthetic Seller",
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
}

function receipt(messageId: string): InventoryDraftListingReceipt {
  return {
    schemaVersion: "inventory-draft-listing-receipt/v1",
    messageVersion: "inventory-draft-listing/v1",
    messageId,
    tenantId: "tnt_delivery_db",
    accountId: "acc_delivery_db",
    performedByUserId: "usr_delivery_db",
    importBatchId: "imb_delivery_db",
    importRowId: messageId,
    intentHash: "a".repeat(64),
    listingId: messageId.replace(/^imr_/, "lst_"),
    listingVersion: 1,
    feeQuoteFingerprint: "fee_delivery_db",
    acceptedAt: "2026-10-26T12:00:00.000Z",
    source: "message",
  };
}

describeDb("issue-7169 C5 draft listing delivery durable DB proof", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["inventory"], "inventory_draft_delivery");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("reclaims an expired lease and fences a late acknowledgement while replacement holds the lease", async () => {
    const pending = message("imr_delivery_reclaim");
    await enqueueInventoryDraftListingMessage(pools.inventory, pending);
    let started!: () => void;
    const claimed = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (value: InventoryDraftListingReceipt) => void;
    const firstAccept = new Promise<InventoryDraftListingReceipt>((resolve) => {
      release = resolve;
    });
    const first = processNextInventoryDraftListingDelivery(pools.inventory, {
      accept: async () => {
        started();
        return firstAccept;
      },
    });
    await claimed;
    await pools.inventory.query(
      "UPDATE inventory_import_draft_listing_outbox SET claimed_until = now() - interval '1 second' WHERE message_id = $1",
      [pending.messageId],
    );

    let replacementStarted!: () => void;
    const replacementClaimed = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    let releaseReplacement!: (value: InventoryDraftListingReceipt) => void;
    const replacementAccept = new Promise<InventoryDraftListingReceipt>((resolve) => {
      releaseReplacement = resolve;
    });
    const secondAccept = vi.fn(async () => {
      replacementStarted();
      return replacementAccept;
    });
    const second = processNextInventoryDraftListingDelivery(pools.inventory, { accept: secondAccept });
    await replacementClaimed;
    release(receipt(pending.messageId));
    await expect(first).resolves.toMatchObject({ outcome: "lost", messageId: pending.messageId, attempts: 1 });
    expect(
      (
        await pools.inventory.query(
          "SELECT state, attempts, claim_token IS NOT NULL AS has_claim_token FROM inventory_import_draft_listing_outbox",
        )
      ).rows,
    ).toEqual([{ state: "sending", attempts: 2, has_claim_token: true }]);
    releaseReplacement(receipt(pending.messageId));
    await expect(second).resolves.toMatchObject({ outcome: "accepted", messageId: pending.messageId, attempts: 2 });
    expect(secondAccept).toHaveBeenCalledExactlyOnceWith(pending, expect.anything());
    expect(
      (await pools.inventory.query("SELECT state, attempts FROM inventory_import_draft_listing_outbox")).rows,
    ).toEqual([{ state: "accepted", attempts: 2 }]);
  });

  it("fences a stale conflict while a reclaimed lease is still sending", async () => {
    const pending = message("imr_delivery_reclaim_conflict");
    await enqueueInventoryDraftListingMessage(pools.inventory, pending);
    let started!: () => void;
    const claimed = new Promise<void>((resolve) => {
      started = resolve;
    });
    let rejectFirst!: (reason: unknown) => void;
    const firstAccept = new Promise<InventoryDraftListingReceipt>((_, reject) => {
      rejectFirst = reject;
    });
    const first = processNextInventoryDraftListingDelivery(pools.inventory, {
      accept: async () => {
        started();
        return firstAccept;
      },
    });
    await claimed;
    await pools.inventory.query(
      "UPDATE inventory_import_draft_listing_outbox SET claimed_until = now() - interval '1 second' WHERE message_id = $1",
      [pending.messageId],
    );

    let replacementStarted!: () => void;
    const replacementClaimed = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    let releaseReplacement!: (value: InventoryDraftListingReceipt) => void;
    const replacementAccept = new Promise<InventoryDraftListingReceipt>((resolve) => {
      releaseReplacement = resolve;
    });
    const second = processNextInventoryDraftListingDelivery(pools.inventory, {
      accept: async () => {
        replacementStarted();
        return replacementAccept;
      },
    });
    await replacementClaimed;
    rejectFirst({ code: "inventory-draft-conflict" });
    await expect(first).resolves.toMatchObject({ outcome: "lost", messageId: pending.messageId, attempts: 1 });
    expect(
      (
        await pools.inventory.query(
          "SELECT state, attempts, claim_token IS NOT NULL AS has_claim_token FROM inventory_import_draft_listing_outbox",
        )
      ).rows,
    ).toEqual([{ state: "sending", attempts: 2, has_claim_token: true }]);
    releaseReplacement(receipt(pending.messageId));
    await expect(second).resolves.toMatchObject({ outcome: "accepted", messageId: pending.messageId, attempts: 2 });
  });

  it("keeps the first snapshot when a message is enqueued twice", async () => {
    const first = message("imr_delivery_duplicate");
    const second = { ...first, snapshot: { ...first.snapshot, quantityCap: 99 } };
    await enqueueInventoryDraftListingMessage(pools.inventory, first);
    await enqueueInventoryDraftListingMessage(pools.inventory, second);
    const rows = await pools.inventory.query<{ message: InventoryDraftListingMessage }>(
      "SELECT message FROM inventory_import_draft_listing_outbox WHERE message_id = $1",
      [first.messageId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.message).toEqual(first);
  });

  it("backs off transient unavailability, fails poison conflicts, and resumes after the delay", async () => {
    const transient = message("imr_delivery_backoff");
    await enqueueInventoryDraftListingMessage(pools.inventory, transient);
    const accept = vi
      .fn()
      .mockRejectedValueOnce({ code: "inventory-draft-unavailable", diagnostic: "consumer-unbound" })
      .mockResolvedValueOnce(receipt(transient.messageId));
    expect(await processNextInventoryDraftListingDelivery(pools.inventory, { accept })).toMatchObject({
      outcome: "requeued",
      attempts: 1,
      code: "inventory-draft-unavailable:consumer-unbound",
    });
    expect(await processNextInventoryDraftListingDelivery(pools.inventory, { accept })).toEqual({ outcome: "idle" });
    const delayed = await pools.inventory.query(
      "SELECT state, attempts, next_attempt_at > now() AS delayed, last_error FROM inventory_import_draft_listing_outbox WHERE message_id = $1",
      [transient.messageId],
    );
    expect(delayed.rows).toEqual([
      {
        state: "pending",
        attempts: 1,
        delayed: true,
        last_error: "inventory-draft-unavailable:consumer-unbound",
      },
    ]);
    await pools.inventory.query(
      "UPDATE inventory_import_draft_listing_outbox SET next_attempt_at = now() - interval '1 second' WHERE message_id = $1",
      [transient.messageId],
    );
    expect(await processNextInventoryDraftListingDelivery(pools.inventory, { accept })).toMatchObject({
      outcome: "accepted",
      attempts: 2,
    });

    const poison = message("imr_delivery_conflict");
    await enqueueInventoryDraftListingMessage(pools.inventory, poison);
    expect(
      await processNextInventoryDraftListingDelivery(pools.inventory, {
        accept: async () => {
          throw { code: "inventory-draft-conflict" };
        },
      }),
    ).toMatchObject({ outcome: "failed", attempts: 1, code: "inventory-draft-conflict:unexpected-failure" });
    expect(
      (
        await pools.inventory.query(
          "SELECT state, attempts FROM inventory_import_draft_listing_outbox WHERE message_id = $1",
          [poison.messageId],
        )
      ).rows,
    ).toEqual([{ state: "failed", attempts: 1 }]);
  });

  it("does not mark a message failed when the accepted acknowledgement cannot be written", async () => {
    const pending = message("imr_delivery_ack_failure");
    await enqueueInventoryDraftListingMessage(pools.inventory, pending);
    const failingAckDb: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("SET state = 'accepted'")) throw new Error("synthetic ack outage");
        return pools.inventory.query<Row>(sql, values);
      },
    };
    await expect(
      processNextInventoryDraftListingDelivery(failingAckDb, { accept: async () => receipt(pending.messageId) }),
    ).rejects.toThrow("synthetic ack outage");
    expect(
      (
        await pools.inventory.query("SELECT state FROM inventory_import_draft_listing_outbox WHERE message_id = $1", [
          pending.messageId,
        ])
      ).rows,
    ).toEqual([{ state: "sending" }]);
    await pools.inventory.query(
      "UPDATE inventory_import_draft_listing_outbox SET claimed_until = now() - interval '1 second' WHERE message_id = $1",
      [pending.messageId],
    );
    expect(
      await processNextInventoryDraftListingDelivery(pools.inventory, {
        accept: async () => receipt(pending.messageId),
      }),
    ).toMatchObject({
      outcome: "accepted",
      attempts: 2,
    });
  });

  it("uses SKIP LOCKED so concurrent passes deliver one row once", async () => {
    const pending = message("imr_delivery_concurrent");
    await enqueueInventoryDraftListingMessage(pools.inventory, pending);
    const accept = vi.fn(async () => receipt(pending.messageId));
    const results = await Promise.all([
      processNextInventoryDraftListingDelivery(pools.inventory, { accept }),
      processNextInventoryDraftListingDelivery(pools.inventory, { accept }),
    ]);
    expect(results.filter((result) => result.outcome === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "idle")).toHaveLength(1);
    expect(accept).toHaveBeenCalledExactlyOnceWith(pending, expect.anything());
  });

  it("keeps legacy and pending committed listings visible but hides failed handoffs", async () => {
    await pools.inventory.query(
      `INSERT INTO inventory_import_batches (batch_id, account_id, status, total_count, accepted_count, committed_count, created_at, updated_at)
       VALUES ('imb_delivery_read', 'acc_delivery_db', 'committed', 3, 3, 3, now(), now())`,
    );
    for (const [rowId, listingId] of [
      ["imr_delivery_legacy", "lst_delivery_legacy"],
      ["imr_delivery_pending", "lst_delivery_pending"],
      ["imr_delivery_failed", "lst_delivery_failed"],
    ] as const) {
      await pools.inventory.query(
        `INSERT INTO inventory_import_batch_rows
           (row_id, batch_id, row_number, status, committed_listing_id, committed_at, created_at, updated_at)
         VALUES ($1, 'imb_delivery_read', $2, 'committed', $3, now(), now(), now())`,
        [rowId, rowId.endsWith("legacy") ? 1 : rowId.endsWith("pending") ? 2 : 3, listingId],
      );
    }
    const inReadBatch = (messageId: string): InventoryDraftListingMessage => {
      const base = message(messageId);
      return { ...base, snapshot: { ...base.snapshot, importBatchId: "imb_delivery_read" } };
    };
    const pending = inReadBatch("imr_delivery_pending");
    const failed = inReadBatch("imr_delivery_failed");
    await enqueueInventoryDraftListingMessage(pools.inventory, pending);
    await enqueueInventoryDraftListingMessage(pools.inventory, failed);
    await pools.inventory.query(
      "UPDATE inventory_import_draft_listing_outbox SET state = 'failed' WHERE message_id = $1",
      [failed.messageId],
    );

    const detail = await getImportBatch(pools.inventory, "imb_delivery_read", "acc_delivery_db");
    expect(detail?.rows.map((row) => [row.row_id, row.committed_listing_id])).toEqual([
      ["imr_delivery_legacy", "lst_delivery_legacy"],
      ["imr_delivery_pending", "lst_delivery_pending"],
      ["imr_delivery_failed", null],
    ]);
  });
});
