import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import {
  censusImportCommitParent,
  getImportBatch,
  listImportBatches,
  type InventoryImportBatch,
  type InventoryImportCommitCensusRow,
} from "./queries";
import { inventoryImportSourceProfiles } from "../domain/import-source-profiles";

const rejectedBatch: InventoryImportBatch = {
  batch_id: "imb_rejected",
  account_id: "acc_1",
  status: "committed",
  source_key: "native-csv",
  adapter_version: 1,
  quantity_mode: "add",
  default_storage_location_id: "loc_1",
  total_count: 1,
  accepted_count: 0,
  rejected_count: 1,
  committed_count: 0,
  created_at: "2026-06-23T11:35:30.237Z",
  updated_at: "2026-06-23T11:35:30.310Z",
};

const mixedCommittedBatch: InventoryImportBatch = {
  batch_id: "imb_mixed",
  account_id: "acc_1",
  status: "uploaded",
  source_key: "native-csv",
  adapter_version: 1,
  quantity_mode: "add",
  default_storage_location_id: "loc_1",
  total_count: 2,
  accepted_count: 1,
  rejected_count: 1,
  committed_count: 1,
  created_at: "2026-06-23T11:35:30.237Z",
  updated_at: "2026-06-23T11:35:30.310Z",
};

function normalizedStatus(batch: InventoryImportBatch): InventoryImportBatch["status"] {
  return batch.total_count > 0 && batch.accepted_count > 0 && batch.committed_count === batch.accepted_count
    ? "committed"
    : "uploaded";
}

class ImportBatchReadModelDb implements PgQueryable {
  private readonly batches = [rejectedBatch, mixedCommittedBatch];
  private draftListingState: "pending" | "failed" = "pending";
  private readonly rows = [
    {
      row_id: "imr_rejected",
      batch_id: rejectedBatch.batch_id,
      row_number: 2,
      status: "rejected",
      raw_row: {},
      external_reference: null,
      row_fingerprint: "native-csv|2||cat_1|loc_1|2|",
      quantity_mode: "add",
      quantity_delta: 2,
      set_quantity: null,
      source_price_amount: null,
      resolution_status: "native",
      catalog_item_id: "cat_1",
      product_id: null,
      selected_options: [],
      storage_location_id: "loc_1",
      total_quantity: 2,
      acquisition_cost_amount: null,
      acquisition_cost_currency_code: null,
      seller_sku: null,
      listing_price_amount: null,
      listing_quantity_cap: null,
      row_note: null,
      validation_errors: ["Selected options must include Form."],
      committed_inventory_item_id: null,
      committed_listing_id: null,
      committed_at: null,
      created_at: rejectedBatch.created_at,
      updated_at: rejectedBatch.updated_at,
    },
    {
      row_id: "imr_mixed_accepted",
      batch_id: mixedCommittedBatch.batch_id,
      row_number: 2,
      status: "committed",
      raw_row: {},
      external_reference: null,
      row_fingerprint: "native-csv|2||cat_1|loc_1|2|",
      quantity_mode: "add",
      quantity_delta: 2,
      set_quantity: null,
      source_price_amount: null,
      resolution_status: "native",
      catalog_item_id: "cat_1",
      product_id: "cat_1::form:raw",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      storage_location_id: "loc_1",
      total_quantity: 2,
      acquisition_cost_amount: null,
      acquisition_cost_currency_code: null,
      seller_sku: null,
      listing_price_amount: "4.44",
      listing_quantity_cap: 1,
      row_note: null,
      validation_errors: [],
      committed_inventory_item_id: "inv_1",
      committed_listing_id: "lst_mixed_pending",
      committed_at: mixedCommittedBatch.updated_at,
      created_at: mixedCommittedBatch.created_at,
      updated_at: mixedCommittedBatch.updated_at,
    },
    {
      row_id: "imr_mixed_rejected",
      batch_id: mixedCommittedBatch.batch_id,
      row_number: 3,
      status: "rejected",
      raw_row: {},
      external_reference: null,
      row_fingerprint: "native-csv|3||cat_missing|loc_1|2|",
      quantity_mode: "add",
      quantity_delta: null,
      set_quantity: null,
      source_price_amount: null,
      resolution_status: "unresolved",
      catalog_item_id: "cat_missing",
      product_id: null,
      selected_options: [],
      storage_location_id: "loc_1",
      total_quantity: 2,
      acquisition_cost_amount: null,
      acquisition_cost_currency_code: null,
      seller_sku: null,
      listing_price_amount: null,
      listing_quantity_cap: null,
      row_note: null,
      validation_errors: ["Catalog item was not found."],
      committed_inventory_item_id: null,
      committed_listing_id: null,
      committed_at: null,
      created_at: mixedCommittedBatch.created_at,
      updated_at: mixedCommittedBatch.updated_at,
    },
  ] as const;

  setDraftListingState(state: "pending" | "failed") {
    this.draftListingState = state;
  }

  public async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("COUNT(*)")) {
      return { rows: [{ count: String(this.batches.length) } as Row], rowCount: 1 };
    }

    if (sql.includes("FROM inventory_import_batch_rows")) {
      const rows = this.rows.filter((row) => row.batch_id === values[0]);
      const normalized = sql.includes("inventory_import_draft_listing_outbox")
        ? rows.map((row) => ({
            ...row,
            committed_listing_id: this.draftListingState === "failed" ? null : row.committed_listing_id,
          }))
        : rows;
      return { rows: normalized as Row[], rowCount: normalized.length };
    }

    if (sql.includes("FROM inventory_import_batches")) {
      const matchingBatches = sql.includes("WHERE batch_id = $1")
        ? this.batches.filter((batch) => batch.batch_id === values[0] && batch.account_id === values[1])
        : this.batches.filter((batch) => batch.account_id === values[0]);
      const rows = matchingBatches.map((batch) => ({
        ...batch,
        status: normalizedStatus(batch),
      }));
      return { rows: rows as Row[], rowCount: rows.length };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

const censusBatchId = "imb_c51c_unit";
const censusJobId = "job_c51c_unit";

function censusRows(count: number): InventoryImportCommitCensusRow[] {
  return Array.from({ length: count }, (_, index) => ({
    row_id: `imr_c51c_${String(index + 1).padStart(3, "0")}`,
    batch_id: censusBatchId,
    row_number: index + 1,
    status: "accepted",
  }));
}

function censusDb(
  acceptedRows: readonly InventoryImportCommitCensusRow[],
  options: Readonly<{ missingRowId?: string; queuedCommittedRowId?: string }> = {},
): PgQueryable & { pageSizes: number[] } {
  const pageSizes: number[] = [];
  const units = acceptedRows.map((row) => ({
    unit_id: row.row_id,
    unit_kind: "commit-row-v1",
    state: options.queuedCommittedRowId === row.row_id ? "queued" : "completed",
    payload: { rowNumber: row.row_number },
    result: options.queuedCommittedRowId === row.row_id ? null : { rowId: row.row_id, status: "committed" },
    claim_owner_id: null,
    claim_token: null,
    claimed_until: null,
  }));
  const db: PgQueryable & { pageSizes: number[] } = {
    pageSizes,
    async query<Row = Record<string, unknown>>(
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<PgQueryResult<Row>> {
      if (sql.includes("FROM jsonb_array_elements")) {
        const page = JSON.parse(String(values[0])) as InventoryImportCommitCensusRow[];
        const offset = Number(values[2]);
        pageSizes.push(page.length);
        return {
          rows: page.map((row, index) => ({
            ordinal: offset + index + 1,
            row_id: row.row_id,
            row_number: row.row_number,
            expected_batch_id: row.batch_id,
            expected_status: row.status,
            unit: units.find((unit) => unit.unit_id === row.row_id) ?? null,
            outcome:
              row.row_id === options.missingRowId
                ? null
                : {
                    row_id: row.row_id,
                    batch_id: censusBatchId,
                    status: "committed",
                    commit_generation: 1,
                    committed_at: "2026-10-31T00:00:00.000Z",
                  },
          })) as Row[],
          rowCount: page.length,
        };
      }
      if (sql.includes("SELECT unit_id, unit_kind, state")) {
        const after = String(values[1] ?? "");
        const page = units.filter((unit) => unit.unit_id > after).slice(0, Number(values[2]));
        return { rows: page as Row[], rowCount: page.length };
      }
      throw new Error(`Unexpected census query: ${sql}`);
    },
  };
  return db;
}

describe("inventory import batch read model queries", () => {
  it.each(inventoryImportSourceProfiles)(
    "getImportBatch projects needs_seller for $sourceKey",
    async ({ sourceKey }) => {
      const stored = new ImportBatchReadModelDb();
      const db: PgQueryable = {
        query: async <Row>(sql: string, values?: readonly unknown[]) => {
          const result = await stored.query<Record<string, unknown>>(sql, values);
          return {
            ...result,
            rows: result.rows.map((row) =>
              row.row_id
                ? { ...row, resolution_status: "resolved", product_id: "valid-product" }
                : { ...row, source_key: sourceKey },
            ) as Row[],
          };
        },
      };
      const detail = await getImportBatch(db, "imb_rejected", "acc_1");
      expect(detail?.rows[0]?.needs_seller).toBe(sourceKey === "saved-list");
    },
  );
  it("getImportBatch projects needs_seller", async () => {
    const rejected = await getImportBatch(new ImportBatchReadModelDb(), "imb_rejected", "acc_1");
    expect(rejected?.rows[0]).toMatchObject({ needs_seller: true });
    expect(rejected).toMatchObject({ can_commit: false, commit_ready_count: 0 });
    const mixed = await getImportBatch(new ImportBatchReadModelDb(), "imb_mixed", "acc_1");
    expect(mixed?.rows.map((row) => row.needs_seller)).toEqual([false, true]);
    expect(mixed).toMatchObject({ can_commit: false, commit_ready_count: 0 });
  });
  it("normalizes rejected-only persisted batches back to reviewable status", async () => {
    const db = new ImportBatchReadModelDb();

    const list = await listImportBatches(db, { accountId: "acc_1" });
    const detail = await getImportBatch(db, "imb_rejected", "acc_1");

    expect(list.items[0]).toMatchObject({
      batch_id: "imb_rejected",
      status: "uploaded",
      accepted_count: 0,
      rejected_count: 1,
      committed_count: 0,
    });
    expect(detail).toMatchObject({
      batch_id: "imb_rejected",
      status: "uploaded",
      rows: [
        expect.objectContaining({
          status: "rejected",
          validation_errors: ["Selected options must include Form."],
        }),
      ],
    });
  });

  it("treats mixed batches as committed once every accepted row is committed", async () => {
    const db = new ImportBatchReadModelDb();

    const list = await listImportBatches(db, { accountId: "acc_1" });
    const detail = await getImportBatch(db, "imb_mixed", "acc_1");

    expect(list.items.find((batch) => batch.batch_id === "imb_mixed")).toMatchObject({
      batch_id: "imb_mixed",
      status: "committed",
      accepted_count: 1,
      rejected_count: 1,
      committed_count: 1,
    });
    expect(detail).toMatchObject({
      batch_id: "imb_mixed",
      status: "committed",
      rows: [
        expect.objectContaining({
          status: "committed",
          committed_inventory_item_id: "inv_1",
        }),
        expect.objectContaining({
          status: "rejected",
          validation_errors: ["Catalog item was not found."],
        }),
      ],
    });
  });

  it("keeps a pending draft handoff visible but hides a terminal failed handoff", async () => {
    const db = new ImportBatchReadModelDb();
    const pending = await getImportBatch(db, "imb_mixed", "acc_1");
    expect(pending?.rows.find((row) => row.row_id === "imr_mixed_accepted")?.committed_listing_id).toBe(
      "lst_mixed_pending",
    );

    db.setDraftListingState("failed");
    const failed = await getImportBatch(db, "imb_mixed", "acc_1");
    expect(failed?.rows.find((row) => row.row_id === "imr_mixed_accepted")?.committed_listing_id).toBeNull();
  });

  it("proves a valid later-page census and keeps every JSON page bounded", async () => {
    const acceptedRows = censusRows(250);
    const db = censusDb(acceptedRows);
    await expect(
      censusImportCommitParent(db, {
        jobId: censusJobId,
        inputId: "input",
        batchId: censusBatchId,
        accountId: "account",
        acceptedRows,
      }),
    ).resolves.toEqual({ total: 250, completed: 250, complete: true });
    expect(db.pageSizes).toEqual([100, 100, 50, 0]);
    expect(db.pageSizes.every((size) => size <= 100)).toBe(true);
  });

  it("rejects a missing outcome beyond page one", async () => {
    const acceptedRows = censusRows(250);
    const db = censusDb(acceptedRows, { missingRowId: acceptedRows[149]!.row_id });
    await expect(
      censusImportCommitParent(db, {
        jobId: censusJobId,
        inputId: "input",
        batchId: censusBatchId,
        accountId: "account",
        acceptedRows,
      }),
    ).rejects.toThrow("Import commit outcomes require reconciliation");
  });

  it("treats a queued unit with a committed outcome as nonterminal", async () => {
    const acceptedRows = censusRows(2);
    const db = censusDb(acceptedRows, { queuedCommittedRowId: acceptedRows[0]!.row_id });
    await expect(
      censusImportCommitParent(db, {
        jobId: censusJobId,
        inputId: "input",
        batchId: censusBatchId,
        accountId: "account",
        acceptedRows,
      }),
    ).resolves.toEqual({ total: 2, completed: 1, complete: false });
  });

  it("keeps production census on validated rows and gates it after pending units", () => {
    const queries = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
    const runtime = readFileSync(new URL("../api/runtime.ts", import.meta.url), "utf8");
    expect(queries).toContain("acceptedRows.slice(ordinal, ordinal + IMPORT_COMMIT_CENSUS_PAGE_SIZE)");
    expect(queries).not.toContain("verifyAcceptedRows");
    expect(runtime).toContain("state NOT IN ('completed', 'failed', 'skipped')");
    expect(runtime).toContain("if (pending > 0)");
    expect(runtime.indexOf("const pendingResult")).toBeLessThan(
      runtime.indexOf("const census = await censusImportCommitParent"),
    );
  });
});
