import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as fulfillmentModule } from "../index";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

async function readColumnNames(pool: PgTransactionalPool, tableName: string): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY column_name`,
    [tableName],
  );
  return result.rows.map((row) => row.column_name);
}

describeDb("fulfillment schema upgrades", () => {
  let pools: Readonly<Record<"fulfillment", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["fulfillment"], "fulfillment_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("converges deployed return-shipment pages to the complete fresh schema", async () => {
    const pool = pools.fulfillment;
    await bootstrapContextDatabase(fulfillmentModule, pool);
    const freshCustomerColumns = await readColumnNames(pool, "fulfillment_return_shipment_customer_pages");
    const freshOperatorColumns = await readColumnNames(pool, "fulfillment_return_shipment_operator_pages");

    await pool.query(`ALTER TABLE fulfillment_return_shipment_customer_pages
      DROP COLUMN label_status,
      DROP COLUMN label_document_url,
      DROP COLUMN label_failure_reason`);
    await pool.query(`ALTER TABLE fulfillment_return_shipment_operator_pages
      DROP COLUMN label_document_url,
      DROP COLUMN postage_provider_name,
      DROP COLUMN postage_provider_mode,
      DROP COLUMN postage_provider_shipment_id,
      DROP COLUMN postage_provider_label_id,
      DROP COLUMN postage_amount_cents,
      DROP COLUMN estimated_postage_amount_cents,
      DROP COLUMN postage_currency,
      DROP COLUMN label_failure_reason,
      DROP COLUMN label_failure_detail,
      DROP COLUMN label_refund_status,
      DROP COLUMN label_refund_reference,
      DROP COLUMN label_failed_at,
      DROP COLUMN label_voided_at`);
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260718_fulfillment_return_shipment_label_columns'",
    );
    await bootstrapContextDatabase(fulfillmentModule, pool);

    expect(await readColumnNames(pool, "fulfillment_return_shipment_customer_pages")).toEqual(freshCustomerColumns);
    expect(await readColumnNames(pool, "fulfillment_return_shipment_operator_pages")).toEqual(freshOperatorColumns);
    const migration = await pool.query<{ migration_id: string }>(
      "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20260718_fulfillment_return_shipment_label_columns'",
    );
    expect(migration.rows).toEqual([{ migration_id: "20260718_fulfillment_return_shipment_label_columns" }]);
  });
});
