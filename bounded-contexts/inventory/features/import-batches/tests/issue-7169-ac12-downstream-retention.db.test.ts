import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapContextDatabase,
  drainContextRuntime,
  resolveModuleSubscriptions,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryDraftListingMessage, InventoryDraftListingReceipt } from "@chase-sets/inventory-draft-listing";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { module as inventoryModule } from "../../../index";
import { createInventoryServices } from "../../../support/runtime-support/services";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";
import {
  enqueueInventoryDraftListingMessage,
  processNextInventoryDraftListingDelivery,
  type InventoryDraftListingDelivery,
} from "../api/draft-listing-delivery";
import { scanInventoryDraftListingHandoffs } from "../api/draft-listing-retention";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for draft listing retention DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const accountId = "acc_ac12_synthetic" as AccountId;
const context: EventStoreContext = {
  tenantId: "tnt_ac12_synthetic",
  audit: { performedByUserId: "usr_ac12_synthetic", forAccountId: accountId },
};
const claim = { claimOwnerId: "ac12-worker-synthetic", claimTtlMs: 30_000 };
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Synthetic Marketplace receipt ledger: one immutable receipt and one effect per message identity. */
function marketplaceDouble() {
  const receipts = new Map<string, InventoryDraftListingReceipt>();
  const effects: string[] = [];
  const accept = vi.fn(async (message: InventoryDraftListingMessage): Promise<InventoryDraftListingReceipt> => {
    const existing = receipts.get(message.messageId);
    if (existing) return existing;
    effects.push(message.messageId);
    const receipt: InventoryDraftListingReceipt = {
      schemaVersion: "inventory-draft-listing-receipt/v1",
      messageVersion: "inventory-draft-listing/v1",
      messageId: message.messageId,
      tenantId: message.authority.tenantId,
      accountId: message.authority.accountId,
      performedByUserId: message.authority.performedByUserId,
      importBatchId: message.snapshot.importBatchId,
      importRowId: message.snapshot.importRowId,
      intentHash: "b".repeat(64),
      listingId: message.snapshot.importRowId.replace(/^imr_/, "lst_"),
      listingVersion: 1,
      feeQuoteFingerprint: "fee_ac12_synthetic",
      acceptedAt: new Date().toISOString(),
      source: "message",
    };
    receipts.set(message.messageId, receipt);
    return receipt;
  });
  const delivery: InventoryDraftListingDelivery = { accept };
  return { delivery, accept, receipts, effects };
}

describeDb("issue-7169-ac12 downstream retention through ACK cleanup", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["inventory"], "inventory_ac12_retention");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    quantitySeed = 0;
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await pools.inventory.query(
      "INSERT INTO inventory_catalog_items (catalog_item_id, status) VALUES ('cat_ac12_synthetic', 'active')",
    );
    await pools.inventory.query(
      `INSERT INTO inventory_storage_locations
         (storage_location_id, account_id, name, ship_from_code, ship_from_address)
       VALUES ('loc_ac12_synthetic', $1, 'Synthetic shelf', 'MAIN', $2::jsonb)`,
      [
        accountId,
        JSON.stringify({
          name: "Synthetic seller",
          line1: "1 Main St",
          line2: null,
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
          phone: null,
          email: null,
        }),
      ],
    );
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  type Inventory = ReturnType<typeof createInventoryServices>;
  let quantitySeed = 0;

  async function drainInventory(inventory: Inventory) {
    await drainContextRuntime(
      {
        subscriptionRunners: resolveModuleSubscriptions([
          {
            contextName: "inventory",
            module: { ...inventoryModule, buildSubscriptions: () => [], eventSubscriptions: [], eventReactions: [] },
            services: inventory,
            pool: pools.inventory,
            projectionHandlerSets: inventoryModule.projectionHandlerSets?.(inventory) ?? [],
          },
        ]),
      },
      { settleIdleCheckpoints: true },
    );
  }

  async function commitBatch(rowCount: number, inventory: Inventory) {
    const createJob = await inventory.importBatches.enqueueCreateBatchJob(
      {
        accountId,
        parsedRows: Array.from({ length: rowCount }, (_, index) => ({
          rowNumber: index + 1,
          values: {
            catalogItemId: "cat_ac12_synthetic",
            storageLocationId: "loc_ac12_synthetic",
            totalQuantity: String((quantitySeed += 1)),
            listingPriceAmount: "5.00",
            listingPriceCurrencyCode: "USD",
            listingQuantityCap: "1",
          },
        })),
      },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    for (let index = 0; index < rowCount; index += 1) {
      expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(1);
    }
    await drainInventory(inventory);
    const batchId = createJob.payload.batchId!;
    const commitJob = await inventory.importBatches.enqueueCommitBatchJob(
      { accountId, batchId },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    expect(await inventory.importBatches.processNextImportBatchJob(claim)).toBe(rowCount);
    expect((await inventory.importBatches.getImportBatchJob(commitJob.jobId))?.status).toBe("completed");
    await drainInventory(inventory);
    const rowIds = (
      await pools.inventory.query<{ row_id: string }>(
        "SELECT row_id FROM inventory_import_batch_rows WHERE batch_id = $1 ORDER BY row_number",
        [batchId],
      )
    ).rows.map((row) => row.row_id);
    return { batchId, commitJobId: commitJob.jobId, rowIds };
  }

  async function ageJob(jobId: string) {
    await pools.inventory.query(
      "UPDATE inventory_import_batch_jobs SET completed_at = now() - interval '30 days' WHERE job_id = $1",
      [jobId],
    );
  }

  const prune = (inventory: Inventory) =>
    inventory.importBatches.pruneImportBatchJobRetention({ completedBefore: new Date(Date.now() - 7 * DAY_MS) });

  async function retainedAudit(jobId: string) {
    const result = await pools.inventory.query<{ jobs: number; events: number; units: number }>(
      `SELECT (SELECT count(*)::integer FROM inventory_import_batch_jobs WHERE job_id = $1) AS jobs,
              (SELECT count(*)::integer FROM inventory_import_batch_job_events WHERE job_id = $1) AS events,
              (SELECT count(*)::integer FROM inventory_import_batch_work_units WHERE job_id = $1) AS units`,
      [jobId],
    );
    return result.rows[0]!;
  }

  async function outboxRows(batchId: string) {
    return (
      await pools.inventory.query<{
        message_id: string;
        state: string;
        message: InventoryDraftListingMessage;
        receipt: InventoryDraftListingReceipt | null;
      }>(
        `SELECT message_id, state, message, receipt FROM inventory_import_draft_listing_outbox
         WHERE import_batch_id = $1 ORDER BY message_id`,
        [batchId],
      )
    ).rows;
  }

  const failingAckDb = (): PgQueryable => ({
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("SET state = 'accepted'")) throw new Error("synthetic ack outage");
      return pools.inventory.query<Row>(sql, values);
    },
  });

  const makeDue = (messageId: string) =>
    pools.inventory.query(
      `UPDATE inventory_import_draft_listing_outbox
       SET next_attempt_at = now() - interval '1 second', claimed_until = now() - interval '1 second'
       WHERE message_id = $1`,
      [messageId],
    );

  it("does not delete before durable acknowledgement", async () => {
    const marketplace = marketplaceDouble();
    const inventory = createInventoryServices(pools.inventory, { draftListingDelivery: marketplace.delivery });
    const { batchId, commitJobId, rowIds } = await commitBatch(1, inventory);
    const messageId = rowIds[0]!;
    await ageJob(commitJobId);
    const committedAudit = await retainedAudit(commitJobId);
    expect(committedAudit.jobs).toBe(1);
    expect(committedAudit.units).toBeGreaterThan(0);
    expect(committedAudit.events).toBeGreaterThan(0);

    // Pending: the commit job and its audit survive cleanup.
    expect(await prune(inventory)).toMatchObject({ jobs: 0, commitJobsHeld: false });
    expect(await retainedAudit(commitJobId)).toEqual(committedAudit);

    // ACK loss: Marketplace accepted but Inventory could not record the acknowledgement.
    await expect(processNextInventoryDraftListingDelivery(failingAckDb(), marketplace.delivery)).rejects.toThrow(
      "synthetic ack outage",
    );
    expect((await outboxRows(batchId)).map((row) => row.state)).toEqual(["sending"]);
    expect(await prune(inventory)).toMatchObject({ jobs: 0 });
    expect(await retainedAudit(commitJobId)).toEqual(committedAudit);

    // Worker death: the lease expired with no acknowledgement; the scan sees resumable work.
    await makeDue(messageId);
    const afterDeath = await prune(inventory);
    expect(afterDeath).toMatchObject({ jobs: 0, handoffs: { complete: true, counts: { reclaimable: 1 } } });
    expect(await retainedAudit(commitJobId)).toEqual(committedAudit);

    // Abort: the replacement attempt is aborted before Marketplace answers.
    expect(
      await processNextInventoryDraftListingDelivery(pools.inventory, {
        accept: async () => {
          throw new DOMException("Synthetic abort", "AbortError");
        },
      }),
    ).toMatchObject({ outcome: "requeued", messageId });
    expect(await prune(inventory)).toMatchObject({ jobs: 0 });
    expect(await retainedAudit(commitJobId)).toEqual(committedAudit);

    // Replay: the resumed message returns the one immutable receipt; only now may cleanup run.
    await makeDue(messageId);
    expect(await inventory.importBatches.processNextImportDraftListingDelivery()).toMatchObject({
      outcome: "accepted",
      messageId,
    });
    expect(marketplace.effects).toEqual([messageId]);
    expect(marketplace.accept).toHaveBeenCalledTimes(2);
    const accepted = await outboxRows(batchId);
    expect(accepted).toEqual([
      expect.objectContaining({
        message_id: messageId,
        state: "accepted",
        receipt: marketplace.receipts.get(messageId),
      }),
    ]);

    expect(await prune(inventory)).toMatchObject({ jobs: 1, commitJobsHeld: false });
    expect(await retainedAudit(commitJobId)).toEqual({ jobs: 0, events: 0, units: 0 });
    expect(await outboxRows(batchId)).toEqual(accepted);
    const detail = await inventory.importBatches.getBatch(batchId, accountId);
    expect(detail?.rows.map((row) => [row.row_id, row.status, row.committed_listing_id])).toEqual([
      [messageId, "committed", messageId.replace(/^imr_/, "lst_")],
    ]);
  });

  it("replays one message without duplicate effects", async () => {
    const marketplace = marketplaceDouble();
    const inventory = createInventoryServices(pools.inventory, { draftListingDelivery: marketplace.delivery });
    const { batchId, rowIds } = await commitBatch(2, inventory);
    const enqueued = await outboxRows(batchId);
    expect(enqueued.map((row) => [row.message_id, row.state])).toEqual(rowIds.map((rowId) => [rowId, "pending"]));

    const lostAck = await processNextInventoryDraftListingDelivery(failingAckDb(), marketplace.delivery).catch(
      (error: unknown) => error,
    );
    expect(lostAck).toBeInstanceOf(Error);
    const replayed = enqueued.find((row) => marketplace.effects.includes(row.message_id))!;
    await makeDue(replayed.message_id);
    for (let pass = 0; pass < 2; pass += 1) {
      expect(await inventory.importBatches.processNextImportDraftListingDelivery()).toMatchObject({
        outcome: "accepted",
      });
    }
    expect(await inventory.importBatches.processNextImportDraftListingDelivery()).toEqual({ outcome: "idle" });

    // A replayed enqueue of the same message identity is a no-op against the retained receipt.
    await enqueueInventoryDraftListingMessage(pools.inventory, replayed.message);
    expect(await inventory.importBatches.processNextImportDraftListingDelivery()).toEqual({ outcome: "idle" });

    const settled = await outboxRows(batchId);
    expect([...marketplace.effects].sort()).toEqual([...rowIds].sort());
    expect(marketplace.accept).toHaveBeenCalledTimes(3);
    expect(settled.map((row) => [row.message_id, row.state])).toEqual(rowIds.map((rowId) => [rowId, "accepted"]));
    for (const row of settled) {
      expect(row.message).toEqual(enqueued.find((candidate) => candidate.message_id === row.message_id)?.message);
      expect(row.receipt).toEqual(marketplace.receipts.get(row.message_id));
    }
  });

  it("retains terminal failed delivery audit indefinitely", async () => {
    const inventory = createInventoryServices(pools.inventory);
    const { batchId, commitJobId } = await commitBatch(1, inventory);
    expect(
      await processNextInventoryDraftListingDelivery(pools.inventory, {
        accept: async () => {
          throw { code: "inventory-draft-conflict" };
        },
      }),
    ).toMatchObject({ outcome: "failed" });
    await ageJob(commitJobId);
    const before = await retainedAudit(commitJobId);
    expect(await prune(inventory)).toMatchObject({ jobs: 0, commitJobsHeld: false });
    expect(await retainedAudit(commitJobId)).toEqual(before);
    expect((await outboxRows(batchId)).map((row) => row.state)).toEqual(["failed"]);
  });

  it("holds the commit job of a batch whose orphan lies outside the resume window", async () => {
    const marketplace = marketplaceDouble();
    const inventory = createInventoryServices(pools.inventory, { draftListingDelivery: marketplace.delivery });
    const settled = await commitBatch(1, inventory);
    const stale = await commitBatch(2, inventory);
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await inventory.importBatches.processNextImportDraftListingDelivery()).toMatchObject({
        outcome: "accepted",
      });
    }
    const [deliveredRow, orphanRow] = stale.rowIds as [string, string];
    // Synthetic orphan: its handoff is missing and its rows predate the scan window, so only the per-job gate can see it.
    await pools.inventory.query("DELETE FROM inventory_import_draft_listing_outbox WHERE message_id = $1", [orphanRow]);
    await pools.inventory.query(
      "UPDATE inventory_import_batch_rows SET created_at = now() - interval '30 days' WHERE batch_id = $1",
      [stale.batchId],
    );
    await ageJob(settled.commitJobId);
    await ageJob(stale.commitJobId);

    const result = await prune(inventory);
    console.info(
      JSON.stringify({ artifact: "inventory-draft-handoff-scan/v1", case: "orphan-outside-window", result }),
    );
    expect(result).toMatchObject({
      jobs: 1,
      commitJobsHeld: false,
      handoffs: { complete: true, counts: { accepted: 1, orphan: 0 } },
    });
    expect((await retainedAudit(settled.commitJobId)).jobs).toBe(0);
    expect((await retainedAudit(stale.commitJobId)).jobs).toBe(1);
    expect((await outboxRows(stale.batchId)).map((row) => [row.message_id, row.state])).toEqual([
      [deliveredRow, "accepted"],
    ]);
  });

  it("does not treat a receipt for another identity as a durable acknowledgement", async () => {
    const marketplace = marketplaceDouble();
    const inventory = createInventoryServices(pools.inventory, { draftListingDelivery: marketplace.delivery });
    const { batchId, commitJobId, rowIds } = await commitBatch(1, inventory);
    expect(await inventory.importBatches.processNextImportDraftListingDelivery()).toMatchObject({
      outcome: "accepted",
    });
    await ageJob(commitJobId);
    const [receipt] = (await outboxRows(batchId)).map((row) => row.receipt);
    const setReceipt = (value: unknown) =>
      pools.inventory.query(
        "UPDATE inventory_import_draft_listing_outbox SET receipt = $2::jsonb WHERE message_id = $1",
        [rowIds[0], JSON.stringify(value)],
      );

    // Synthetic corruption control: the stored receipt names another batch.
    await setReceipt({ ...receipt, importBatchId: "imb_ac12_other_batch" });
    expect(await prune(inventory)).toMatchObject({
      jobs: 0,
      commitJobsHeld: true,
      handoffs: { counts: { accepted: 0, ambiguous: 1 } },
    });
    expect((await retainedAudit(commitJobId)).jobs).toBe(1);

    await setReceipt(receipt);
    expect(await prune(inventory)).toMatchObject({ jobs: 1, commitJobsHeld: false });
    expect((await retainedAudit(commitJobId)).jobs).toBe(0);
  });

  it("enqueues the durable outbox from commit without any direct draft call", async () => {
    const marketplace = marketplaceDouble();
    const directCreator = vi.fn();
    const inventory = createInventoryServices(pools.inventory, {
      draftListingDelivery: marketplace.delivery,
      // A superseded host port must be inert even when a stale host still passes it.
      ...({ draftListingCreator: directCreator } as object),
    });
    const { batchId, rowIds } = await commitBatch(2, inventory);
    const counts = await pools.inventory.query<{ committed: number; listed: number; outbox: number; pending: number }>(
      `SELECT (SELECT count(*)::integer FROM inventory_import_batch_rows WHERE batch_id = $1 AND status = 'committed') AS committed,
              (SELECT count(*)::integer FROM inventory_import_batch_rows
                WHERE batch_id = $1 AND committed_listing_id = replace(row_id, 'imr_', 'lst_')) AS listed,
              (SELECT count(*)::integer FROM inventory_import_draft_listing_outbox WHERE import_batch_id = $1) AS outbox,
              (SELECT count(*)::integer FROM inventory_import_draft_listing_outbox
                WHERE import_batch_id = $1 AND state = 'pending' AND attempts = 0) AS pending`,
      [batchId],
    );
    expect(counts.rows).toEqual([{ committed: 2, listed: 2, outbox: 2, pending: 2 }]);
    expect(directCreator).not.toHaveBeenCalled();
    expect(marketplace.accept).not.toHaveBeenCalled();
    expect(marketplace.effects).toEqual([]);

    await inventory.importBatches.processNextImportDraftListingDelivery();
    await inventory.importBatches.processNextImportDraftListingDelivery();
    expect([...marketplace.effects].sort()).toEqual([...rowIds].sort());
    expect(directCreator).not.toHaveBeenCalled();
  });

  it("resume-window scan finds every eligible handoff and backstops cleanup on an orphan", async () => {
    const marketplace = marketplaceDouble();
    const inventory = createInventoryServices(pools.inventory, { draftListingDelivery: marketplace.delivery });
    const settledBatch = await commitBatch(1, inventory);
    await inventory.importBatches.processNextImportDraftListingDelivery();
    await ageJob(settledBatch.commitJobId);

    const states = await commitBatch(5, inventory);
    const [acceptedRow, , sendingRow, reclaimableRow, failedRow] = states.rowIds as [
      string,
      string,
      string,
      string,
      string,
    ];
    await pools.inventory.query(
      `UPDATE inventory_import_draft_listing_outbox
       SET state = 'accepted', receipt = jsonb_build_object('messageId', message_id, 'importBatchId', import_batch_id, 'synthetic', true), accepted_at = now()
       WHERE message_id = $1`,
      [acceptedRow],
    );
    await pools.inventory.query(
      `UPDATE inventory_import_draft_listing_outbox
       SET state = 'sending', claim_token = 'live', claimed_until = now() + interval '5 minutes' WHERE message_id = $1`,
      [sendingRow],
    );
    await pools.inventory.query(
      `UPDATE inventory_import_draft_listing_outbox
       SET state = 'sending', claim_token = 'dead', claimed_until = now() - interval '5 minutes' WHERE message_id = $1`,
      [reclaimableRow],
    );
    await pools.inventory.query(
      "UPDATE inventory_import_draft_listing_outbox SET state = 'failed' WHERE message_id = $1",
      [failedRow],
    );

    // Legacy (committed before the first outbox write) and orphan (after it) rows carry no outbox row.
    const lineage = await commitBatch(2, inventory);
    const [legacyRow, orphanRow] = lineage.rowIds as [string, string];
    await pools.inventory.query("DELETE FROM inventory_import_draft_listing_outbox WHERE import_batch_id = $1", [
      lineage.batchId,
    ]);
    await pools.inventory.query(
      "UPDATE inventory_import_batch_rows SET committed_at = now() - interval '30 days' WHERE row_id = $1",
      [legacyRow],
    );

    const since = new Date(Date.now() - DAY_MS);
    const allRows = 1 + 5 + 2;
    const scan = await scanInventoryDraftListingHandoffs(pools.inventory, { since, pageLimit: allRows - 1 });
    console.info(JSON.stringify({ artifact: "inventory-draft-handoff-scan/v1", case: "decisive-beyond-page", scan }));
    expect(scan).toMatchObject({
      complete: true,
      pages: 2,
      scannedRows: allRows,
      counts: {
        accepted: 2,
        pending: 1,
        sending: 1,
        reclaimable: 1,
        failed: 1,
        uncommitted: 0,
        legacy: 1,
        orphan: 1,
        ambiguous: 0,
      },
      findings: [{ batchId: lineage.batchId, rowId: orphanRow, handoff: "orphan" }],
    });

    const laggedEmpty = await scanInventoryDraftListingHandoffs(pools.inventory, { since, pageLimit: 1 });
    expect(laggedEmpty).toMatchObject({ complete: true, pages: allRows, counts: { orphan: 1 } });
    const truncated = await scanInventoryDraftListingHandoffs(pools.inventory, {
      since,
      pageLimit: allRows - 1,
      maxPages: 1,
    });
    expect(truncated).toMatchObject({ complete: false, pages: 1, counts: { orphan: 0 } });
    const zero = await scanInventoryDraftListingHandoffs(pools.inventory, { since: new Date(Date.now() + DAY_MS) });
    expect(zero).toMatchObject({ complete: true, pages: 1, scannedRows: 0 });
    console.info(
      JSON.stringify({ artifact: "inventory-draft-handoff-scan/v1", case: "controls", laggedEmpty, truncated, zero }),
    );

    // Backstop: an orphan in the resume window holds even a fully acknowledged commit job.
    const held = await prune(inventory);
    expect(held).toMatchObject({ jobs: 0, commitJobsHeld: true, handoffs: { counts: { orphan: 1 } } });
    expect((await retainedAudit(settledBatch.commitJobId)).jobs).toBe(1);

    // Once the orphan is accounted for, only the acknowledged batch's job is cleaned up.
    await pools.inventory.query(
      "UPDATE inventory_import_batch_rows SET committed_at = now() - interval '30 days' WHERE row_id = $1",
      [orphanRow],
    );
    await ageJob(states.commitJobId);
    const released = await prune(inventory);
    console.info(JSON.stringify({ artifact: "inventory-draft-handoff-scan/v1", case: "released", released }));
    expect(released).toMatchObject({ commitJobsHeld: false, handoffs: { counts: { legacy: 2, orphan: 0 } } });
    expect((await retainedAudit(settledBatch.commitJobId)).jobs).toBe(0);
    expect((await retainedAudit(states.commitJobId)).jobs).toBe(1);
    expect(
      (await pools.inventory.query("SELECT count(*)::integer AS count FROM inventory_import_draft_listing_outbox"))
        .rows,
    ).toEqual([{ count: 6 }]);
  });

  it("keeps legacy, pending and accepted lineage visible, hides only failed, and never edits history on read", async () => {
    const inventory = createInventoryServices(pools.inventory);
    const { batchId, rowIds } = await commitBatch(3, inventory);
    const [legacyRow, pendingRow, failedRow] = rowIds as [string, string, string];
    await pools.inventory.query("DELETE FROM inventory_import_draft_listing_outbox WHERE message_id = $1", [legacyRow]);
    await pools.inventory.query(
      "UPDATE inventory_import_draft_listing_outbox SET state = 'failed' WHERE message_id = $1",
      [failedRow],
    );
    // A mis-scoped failed outbox row for another batch must not hide the legacy row's listing.
    const foreignMessage = (await outboxRows(batchId)).find((row) => row.message_id === pendingRow)!.message;
    await pools.inventory.query(
      `INSERT INTO inventory_import_draft_listing_outbox
         (message_id, tenant_id, account_id, performed_by_user_id, import_batch_id, import_row_id, message, state)
       VALUES ($1, $2, $3, $4, 'imb_ac12_other_batch', $1, $5::jsonb, 'failed')`,
      [legacyRow, context.tenantId, accountId, context.audit.performedByUserId, JSON.stringify(foreignMessage)],
    );
    const history = () =>
      pools.inventory.query(
        `SELECT row_id, status, committed_listing_id, committed_at, updated_at FROM inventory_import_batch_rows
         WHERE batch_id = $1 ORDER BY row_number`,
        [batchId],
      );
    const outboxHistory = () =>
      pools.inventory.query(
        "SELECT message_id, import_batch_id, state, updated_at FROM inventory_import_draft_listing_outbox ORDER BY message_id, import_batch_id",
      );
    const [rowsBefore, outboxBefore] = [(await history()).rows, (await outboxHistory()).rows];

    const detail = await inventory.importBatches.getBatch(batchId, accountId);
    expect(detail?.rows.map((row) => [row.row_id, row.committed_listing_id])).toEqual([
      [legacyRow, legacyRow.replace(/^imr_/, "lst_")],
      [pendingRow, pendingRow.replace(/^imr_/, "lst_")],
      [failedRow, null],
    ]);
    await pools.inventory.query(
      `UPDATE inventory_import_draft_listing_outbox
       SET state = 'accepted', receipt = jsonb_build_object('messageId', message_id, 'importBatchId', import_batch_id, 'synthetic', true), accepted_at = now()
       WHERE message_id = $1`,
      [pendingRow],
    );
    const acceptedDetail = await inventory.importBatches.getBatch(batchId, accountId);
    expect(acceptedDetail?.rows.find((row) => row.row_id === pendingRow)?.committed_listing_id).toBe(
      pendingRow.replace(/^imr_/, "lst_"),
    );
    expect((await history()).rows).toEqual(rowsBefore);
    expect((await outboxHistory()).rows.filter((row) => row.message_id !== pendingRow)).toEqual(
      outboxBefore.filter((row) => row.message_id !== pendingRow),
    );
  });
});
