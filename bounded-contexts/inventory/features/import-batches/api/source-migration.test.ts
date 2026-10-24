import { describe, expect, it } from "vitest";
import type { BcSchemaMigrationClient } from "@chase-sets/bounded-context-module";
import { contractInventoryImportSources } from "./source-migration";
import { prepareInventoryImportSnapshot } from "./safe-snapshot";

type Page = readonly [RegExp, readonly Record<string, unknown>[]];

function migrationClient(pages: readonly Page[] = []) {
  const statements: string[] = [];
  const served = new Set<Page>();
  const db: BcSchemaMigrationClient = {
    query: async <Row>(sql: string) => {
      statements.push(sql.replace(/\s+/g, " ").trim());
      const page = pages.find((candidate) => candidate[0].test(sql) && !served.has(candidate));
      if (page) served.add(page);
      return { rows: (page?.[1] ?? []) as Row[] };
    },
  };
  return { db, statements };
}

describe("contractInventoryImportSources", () => {
  it("takes every cutover lock before any read and leaves the transaction to the migration runner", async () => {
    const { db, statements } = migrationClient();

    await contractInventoryImportSources(db);

    expect(statements.slice(0, 4)).toEqual([
      "SELECT pg_advisory_xact_lock(hashtextextended('inventory-import-source-cutover/v1', 0))",
      "SET LOCAL lock_timeout = '5s'",
      "LOCK TABLE inventory_import_batch_job_inputs, inventory_import_batches IN ACCESS EXCLUSIVE MODE",
      "LOCK TABLE inventory_import_batch_jobs, inventory_import_batch_rows, inventory_import_batch_job_events IN SHARE ROW EXCLUSIVE MODE",
    ]);
    expect(statements.slice(4).filter((sql) => /\bLOCK\b|lock_timeout|pg_advisory/i.test(sql))).toEqual([]);
    expect(
      statements.filter((sql) =>
        /^(?:BEGIN|COMMIT|ROLLBACK)\b|CONCURRENTLY|information_schema|_source_contracted/i.test(sql),
      ),
    ).toEqual([]);
  });

  it("leaves already-safe retained rows and results unwritten", async () => {
    // A floor-era TCGplayer row: re-normalizing it through its adapter would blank the derived rowNote.
    const rawRow = prepareInventoryImportSnapshot({
      accountId: "acc_safe_synthetic",
      sourceKey: "tcgplayer-csv",
      csvText:
        "TCGplayer Id,Product Line,Set Name,Product Name,Condition,Total Quantity,Add to Quantity,TCG Marketplace Price\n" +
        "9846,Pokemon,Base,Pikachu,Near Mint,3,0,1.50",
    }).rows[0].rawRow;
    expect(rawRow.rowNote).toBe("Pikachu | Base | Near Mint");
    const { db, statements } = migrationClient([
      [
        /FROM inventory_import_batch_rows AS row/,
        [
          {
            row_id: "imr_safe_synthetic",
            account_id: "acc_safe_synthetic",
            source_key: "tcgplayer-csv",
            row_number: 2,
            raw_row: rawRow,
          },
        ],
      ],
      [
        /SELECT job_id, result/,
        [
          { job_id: "job_safe_synthetic", result: { source_key: "tcgplayer-csv", raw_row: rawRow } },
          { job_id: "job_unset_synthetic", result: null },
        ],
      ],
    ]);

    await contractInventoryImportSources(db);

    expect(statements.filter((sql) => sql.startsWith("UPDATE"))).toEqual([]);
  });
});
