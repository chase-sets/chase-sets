import { describe, expect, it } from "vitest";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import type { InventoryCatalogItemServices } from "../../inventory-items/integrations/catalog/runtime";
import type { InventoryItemServices } from "../../inventory-items/api/runtime";
import {
  classifyDraftListingHandoff,
  draftListingHandoffScanHoldsRetention,
  parseRetentionInstant,
  pruneAcknowledgedImportCommitJobs,
  scanInventoryDraftListingHandoffs,
  type DraftListingHandoffRow,
} from "../api/draft-listing-retention";
import { createInventoryImportBatchRuntime } from "../api/runtime";

type Call = Readonly<{ sql: string; values: readonly unknown[] }>;

function handoffRow(index: number, overrides: Partial<DraftListingHandoffRow> = {}): DraftListingHandoffRow {
  return {
    row_id: `imr_ac12_${String(index).padStart(4, "0")}`,
    batch_id: "imb_ac12",
    row_status: "committed",
    has_listing: true,
    after_lineage: true,
    outbox_state: "accepted",
    acknowledged: true,
    claim_expired: true,
    cursor_created_at: `2026-10-30T00:00:00.${String(index).padStart(6, "0")}Z`,
    ...overrides,
  };
}

/** Keyset fake for the scan: honours the cursor ($4, $5) and the look-ahead LIMIT ($6). */
function scanDb(rows: readonly DraftListingHandoffRow[], lineage: string | null = "2026-10-27T00:00:00.000000Z") {
  const calls: Call[] = [];
  const db: PgQueryable = {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("AS scan_until")) {
        return {
          rows: [{ scan_until: "2026-11-01T00:00:00.000000Z", lineage_started_at: lineage }] as Row[],
          rowCount: 1,
        } satisfies PgQueryResult<Row>;
      }
      if (sql.includes("FROM inventory_import_batch_rows AS import_row")) {
        const [cursorAt, cursorRowId, limit] = [values[3], values[4], Number(values[5])];
        const page = rows
          .filter(
            (row) =>
              row.cursor_created_at > String(cursorAt) ||
              (row.cursor_created_at === cursorAt && row.row_id > String(cursorRowId)),
          )
          .slice(0, limit);
        return { rows: page as Row[], rowCount: page.length };
      }
      if (sql.includes("DELETE FROM inventory_import_batch_jobs")) return { rows: [] as Row[], rowCount: 0 };
      if (sql.includes("inventory_import_batch_job_inputs")) return { rows: [] as Row[], rowCount: 0 };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  return { db, calls, pageCalls: () => calls.filter((call) => call.sql.includes("AS import_row")) };
}

describe("issue-7169-ac12 downstream retention (unit)", () => {
  it.each([
    [{ outbox_state: "accepted", acknowledged: true }, "accepted"],
    [{ outbox_state: "accepted", acknowledged: false }, "ambiguous"],
    [{ outbox_state: "pending" }, "pending"],
    [{ outbox_state: "sending", claim_expired: false }, "sending"],
    [{ outbox_state: "sending", claim_expired: true }, "reclaimable"],
    [{ outbox_state: "sending", claim_expired: null }, "ambiguous"],
    [{ outbox_state: "failed" }, "failed"],
    [{ outbox_state: "unknown-state" }, "ambiguous"],
    [{ outbox_state: "pending", row_status: "accepted" }, "uncommitted"],
    [{ outbox_state: "pending", has_listing: false }, "ambiguous"],
    [{ outbox_state: null, after_lineage: true }, "orphan"],
    [{ outbox_state: null, after_lineage: false }, "legacy"],
    [{ outbox_state: null, after_lineage: null }, "ambiguous"],
    [{ outbox_state: null, has_listing: false }, null],
    [{ outbox_state: null, row_status: "accepted" }, null],
  ] as const)("classifies %j as %s", (overrides, expected) => {
    expect(classifyDraftListingHandoff(handoffRow(1, overrides))).toBe(expected);
  });

  it("zero control: an empty window is complete after one page and holds nothing", async () => {
    const { db, pageCalls } = scanDb([]);
    const scan = await scanInventoryDraftListingHandoffs(db, { since: "2026-10-24T00:00:00.000Z" });
    expect(scan).toMatchObject({ complete: true, pages: 1, scannedRows: 0, findings: [] });
    expect(Object.values(scan.counts).every((count) => count === 0)).toBe(true);
    expect(draftListingHandoffScanHoldsRetention(scan)).toBe(false);
    // The first page's keyset cursor is the window start itself, so no page needs an unindexable OR branch.
    expect(pageCalls()[0]?.values).toEqual([
      "2026-10-24T00:00:00.000Z",
      "2026-11-01T00:00:00.000000Z",
      "2026-10-27T00:00:00.000000Z",
      "2026-10-24T00:00:00.000Z",
      "",
      501,
    ]);
    expect(pageCalls()[0]?.sql.replace(/\s+/g, " ")).toContain(
      "AND (import_row.created_at, import_row.row_id) > ($4::timestamptz, $5::text) ORDER BY",
    );
  });

  it("partial control: a short page completes the window and counts every state", async () => {
    const rows = [
      handoffRow(1),
      handoffRow(2, { outbox_state: "pending" }),
      handoffRow(3, { outbox_state: "sending", claim_expired: false }),
      handoffRow(4, { outbox_state: "failed" }),
      handoffRow(5, { outbox_state: null, after_lineage: false }),
    ];
    const scan = await scanInventoryDraftListingHandoffs(scanDb(rows).db, {
      since: "2026-10-24T00:00:00Z",
      pageLimit: 10,
    });
    expect(scan).toMatchObject({ complete: true, pages: 1, scannedRows: 5 });
    expect(scan.counts).toMatchObject({ accepted: 1, pending: 1, sending: 1, failed: 1, legacy: 1, orphan: 0 });
    expect(draftListingHandoffScanHoldsRetention(scan)).toBe(false);
  });

  it("exact-boundary control: a full page with no look-ahead row is complete without a second page", async () => {
    const { db, pageCalls } = scanDb([handoffRow(1), handoffRow(2)]);
    const scan = await scanInventoryDraftListingHandoffs(db, { since: "2026-10-24T00:00:00Z", pageLimit: 2 });
    expect(scan).toMatchObject({ complete: true, pages: 1, scannedRows: 2 });
    expect(pageCalls()).toHaveLength(1);
  });

  it("decisive-beyond-page: the orphan just past page one is read by the follow-up page from a microsecond cursor", async () => {
    const rows = [handoffRow(1), handoffRow(2), handoffRow(3, { outbox_state: null })];
    const { db, pageCalls } = scanDb(rows);
    const scan = await scanInventoryDraftListingHandoffs(db, { since: "2026-10-24T00:00:00Z", pageLimit: 2 });
    expect(scan).toMatchObject({
      complete: true,
      pages: 2,
      scannedRows: 3,
      findings: [{ batchId: "imb_ac12", rowId: "imr_ac12_0003", handoff: "orphan" }],
    });
    expect(pageCalls()[1]?.values.slice(3)).toEqual(["2026-10-30T00:00:00.000002Z", "imr_ac12_0002", 3]);
    expect(draftListingHandoffScanHoldsRetention(scan)).toBe(true);
  });

  it("lagged-empty control: pages with no eligible handoff do not end the scan before a later orphan", async () => {
    const rows = [
      handoffRow(1, { outbox_state: null, row_status: "accepted" }),
      handoffRow(2, { outbox_state: null, has_listing: false }),
      handoffRow(3, { outbox_state: null, row_status: "rejected" }),
      handoffRow(4, { outbox_state: null }),
    ];
    const scan = await scanInventoryDraftListingHandoffs(scanDb(rows).db, {
      since: "2026-10-24T00:00:00Z",
      pageLimit: 1,
    });
    expect(scan).toMatchObject({ complete: true, pages: 4, scannedRows: 4 });
    expect(scan.counts.orphan).toBe(1);
  });

  it("truncated control: exhausting maxPages before the window ends is incomplete and holds retention", async () => {
    const rows = [handoffRow(1), handoffRow(2), handoffRow(3, { outbox_state: null })];
    const scan = await scanInventoryDraftListingHandoffs(scanDb(rows).db, {
      since: "2026-10-24T00:00:00Z",
      pageLimit: 2,
      maxPages: 1,
    });
    expect(scan).toMatchObject({ complete: false, pages: 1, scannedRows: 2 });
    expect(scan.counts.orphan).toBe(0);
    expect(draftListingHandoffScanHoldsRetention(scan)).toBe(true);
  });

  it("no-outbox lineage control: without any outbox write, committed listing rows stay legacy", async () => {
    const scan = await scanInventoryDraftListingHandoffs(
      scanDb([handoffRow(1, { outbox_state: null, after_lineage: false })], null).db,
      { since: "2026-10-24T00:00:00Z" },
    );
    expect(scan).toMatchObject({ lineageStartedAt: null, counts: { legacy: 1, orphan: 0 } });
  });

  it("caps findings while still counting every retention-holding row", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => handoffRow(index + 1, { outbox_state: null }));
    const scan = await scanInventoryDraftListingHandoffs(scanDb(rows).db, { since: "2026-10-24T00:00:00Z" });
    expect(scan.counts.orphan).toBe(101);
    expect(scan.findings).toHaveLength(100);
    expect(scan.findingsTruncated).toBe(true);
  });

  it.each([
    ["date-only", "2026-10-24"],
    ["offset-less", "2026-10-24T00:00:00"],
    ["invalid date", new Date(Number.NaN)],
    ["impossible instant", "2026-13-40T00:00:00Z"],
  ])("refuses a %s retention instant", async (_label, since) => {
    expect(() => parseRetentionInstant(since)).toThrow(RangeError);
    await expect(scanInventoryDraftListingHandoffs(scanDb([]).db, { since })).rejects.toThrow(RangeError);
  });

  it("accepts an explicit non-UTC offset as the same instant", () => {
    expect(parseRetentionInstant("2026-10-24T02:00:00+02:00").toISOString()).toBe("2026-10-24T00:00:00.000Z");
  });

  it.each([
    ["pageLimit", { pageLimit: 0 }],
    ["pageLimit", { pageLimit: 1.5 }],
    ["pageLimit", { pageLimit: Number.NaN }],
    ["pageLimit", { pageLimit: 501 }],
    ["maxPages", { maxPages: -1 }],
    ["maxPages", { maxPages: 101 }],
  ])("refuses an out-of-bounds %s", async (_label, bounds) => {
    const { db, calls } = scanDb([]);
    await expect(scanInventoryDraftListingHandoffs(db, { since: "2026-10-24T00:00:00Z", ...bounds })).rejects.toThrow(
      RangeError,
    );
    expect(calls).toHaveLength(0);
  });

  const DURABLE_ACK =
    "COALESCE( outbox.state = 'accepted' AND outbox.accepted_at IS NOT NULL AND outbox.receipt->>'messageId' = outbox.message_id AND outbox.receipt->>'importBatchId' = outbox.import_batch_id, false)";

  it("gates commit-job deletion on identity-checked acknowledgement and no orphan in the job's own batch", async () => {
    const { db, calls } = scanDb([]);
    await pruneAcknowledgedImportCommitJobs(db, {
      jobKind: "commit",
      completedBefore: new Date("2026-10-25T00:00:00.000Z"),
      lineageStartedAt: "2026-10-27T00:00:00.000000Z",
      limit: 9,
    });
    const statement = calls[0]!;
    const sql = statement.sql.replace(/\s+/g, " ");
    expect(statement.values).toEqual(["2026-10-25T00:00:00.000Z", 9, "commit", "2026-10-27T00:00:00.000Z"]);
    expect(sql).toContain("job.job_kind = $3 AND job.status IN ('completed', 'failed')");
    expect(sql).toContain("job.payload->>'batchId' IS NOT NULL");
    // Every outbox row of the batch: acknowledged for its own identity and owned by a committed listing row.
    expect(sql).toContain(
      `AND NOT EXISTS ( SELECT 1 FROM inventory_import_draft_listing_outbox AS outbox LEFT JOIN inventory_import_batch_rows AS import_row ON import_row.row_id = outbox.message_id AND import_row.batch_id = outbox.import_batch_id WHERE outbox.import_batch_id = job.payload->>'batchId' AND NOT COALESCE( ${DURABLE_ACK} AND import_row.status = 'committed' AND import_row.committed_listing_id IS NOT NULL, false) )`,
    );
    // Backstop independent of the scan window: a post-lineage or undated committed listing row without its handoff.
    expect(sql).toContain(
      "AND NOT EXISTS ( SELECT 1 FROM inventory_import_batch_rows AS import_row LEFT JOIN inventory_import_draft_listing_outbox AS outbox ON outbox.message_id = import_row.row_id AND outbox.import_batch_id = import_row.batch_id WHERE import_row.batch_id = job.payload->>'batchId' AND import_row.status = 'committed' AND import_row.committed_listing_id IS NOT NULL AND outbox.message_id IS NULL AND $4::timestamptz IS NOT NULL AND (import_row.committed_at IS NULL OR import_row.committed_at >= $4::timestamptz) )",
    );
    expect(sql).toContain("FOR UPDATE OF job SKIP LOCKED");
    const writes = sql
      .replace("FOR UPDATE OF job SKIP LOCKED", "")
      .match(/\b(?:DELETE FROM|UPDATE|INSERT INTO)\s+\w+/g);
    expect(writes).toEqual(["DELETE FROM inventory_import_batch_jobs"]);
  });

  it("passes a null lineage through and refuses an offset-less lineage instant", async () => {
    const { db, calls } = scanDb([]);
    await pruneAcknowledgedImportCommitJobs(db, {
      jobKind: "commit",
      completedBefore: "2026-10-25T00:00:00Z",
      lineageStartedAt: null,
    });
    expect(calls[0]?.values).toEqual(["2026-10-25T00:00:00.000Z", 500, "commit", null]);
    await expect(
      pruneAcknowledgedImportCommitJobs(db, {
        jobKind: "commit",
        completedBefore: "2026-10-25T00:00:00Z",
        lineageStartedAt: "2026-10-27",
      }),
    ).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(1);
  });

  it("reads lineage from one index endpoint and classifies with the drain's own predicates", async () => {
    const { db, calls } = scanDb([]);
    await scanInventoryDraftListingHandoffs(db, { since: "2026-10-24T00:00:00Z" });
    const [head, page] = calls.map((call) => call.sql.replace(/\s+/g, " "));
    expect(head).toContain(
      "FROM inventory_import_draft_listing_outbox AS outbox ORDER BY outbox.created_at ASC, outbox.message_id ASC LIMIT 1",
    );
    expect(head).not.toMatch(/\bmin\(/);
    expect(page).toContain(`${DURABLE_ACK} AS acknowledged`);
    expect(page).toContain("outbox.claimed_until <= now() AS claim_expired");
    expect(page).toContain("ON outbox.message_id = import_row.row_id AND outbox.import_batch_id = import_row.batch_id");
    expect(page).toContain("ORDER BY import_row.created_at ASC, import_row.row_id ASC");
  });

  describe("backstop through the import runtime prune", () => {
    function runtimeOver(db: PgQueryable) {
      return createInventoryImportBatchRuntime({
        db,
        catalogItems: {} as InventoryCatalogItemServices,
        items: {} as InventoryItemServices,
      });
    }
    const commitDeletes = (calls: readonly Call[]) =>
      calls.filter(
        (call) => call.sql.includes("DELETE FROM inventory_import_batch_jobs") && call.sql.includes("outbox"),
      );

    it("holds every commit-job deletion while the resume window holds an orphan", async () => {
      const { db, calls } = scanDb([handoffRow(1), handoffRow(2, { outbox_state: null })]);
      const result = await runtimeOver(db).pruneImportBatchJobRetention({
        completedBefore: "2026-10-25T00:00:00.000Z",
      });
      expect(result).toMatchObject({ commitJobsHeld: true, jobs: 0, handoffs: { counts: { orphan: 1 } } });
      expect(commitDeletes(calls)).toHaveLength(0);
      expect(calls.find((call) => call.sql.includes("AS import_row"))?.values[0]).toBe("2026-10-24T00:00:00.000Z");
    });

    it("runs the ACK-gated deletion once the window is complete with only legacy, accepted and in-flight rows", async () => {
      const { db, calls } = scanDb([
        handoffRow(1),
        handoffRow(2, { outbox_state: "pending" }),
        handoffRow(3, { outbox_state: "failed" }),
        handoffRow(4, { outbox_state: null, after_lineage: false }),
      ]);
      const result = await runtimeOver(db).pruneImportBatchJobRetention({
        completedBefore: "2026-10-25T00:00:00.000Z",
      });
      expect(result.commitJobsHeld).toBe(false);
      expect(commitDeletes(calls)).toHaveLength(1);
      // The per-job orphan backstop receives the scan's causal lineage, not a fresh guess.
      expect(commitDeletes(calls)[0]?.values[3]).toBe("2026-10-27T00:00:00.000Z");
    });
  });
});
