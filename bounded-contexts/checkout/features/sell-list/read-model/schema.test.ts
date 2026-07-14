import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutSellListSchemaMigrations, checkoutSellListSchemaSql } from "./schema";

/**
 * Regression guard for the CREATE-TABLE-IF-NOT-EXISTS drift that 500'd
 * `/account/sell-list` (Postgres "column listing_id does not exist" at position 92):
 * `listing_id` was added to the base table definition but never reached the
 * long-lived staging projection store, because CREATE TABLE IF NOT EXISTS is a no-op
 * against an existing table.
 *
 * Every column that a sell-list line read SELECTs must have a schema home — either a
 * base CREATE TABLE column (for fresh databases) OR an explicit ADD COLUMN migration
 * (to reconcile databases created before the column existed). This catches "added a
 * SELECT column without a migration" before it reaches a persistent database.
 */

const here = dirname(fileURLToPath(import.meta.url));

function lineTableColumns(): Set<string> {
  const create = /CREATE TABLE IF NOT EXISTS checkout_sell_list_line_pages \(([\s\S]*?)\n\);/.exec(
    checkoutSellListSchemaSql,
  );
  const columns = new Set<string>();
  for (const raw of create?.[1].split("\n") ?? []) {
    const match = /^\s{2}([a-z_]+)\s/.exec(raw);
    if (match && match[1] !== "PRIMARY") {
      columns.add(match[1]);
    }
  }
  for (const migration of checkoutSellListSchemaMigrations) {
    for (const statement of migration.statements) {
      for (const added of statement.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_]+)/g)) {
        columns.add(added[1]);
      }
    }
  }
  return columns;
}

function listSellListLinesSelectColumns(): string[] {
  const source = readFileSync(join(here, "queries.ts"), "utf8");
  const fn = /export async function listSellListLines[\s\S]*?FROM checkout_sell_list_line_pages/.exec(source);
  const select = /SELECT([\s\S]*?)FROM checkout_sell_list_line_pages/.exec(fn?.[0] ?? "");
  return (select?.[1] ?? "")
    .split(",")
    .map((column) => column.trim())
    .filter((column) => /^[a-z_]+$/.test(column));
}

describe("checkout sell-list line schema coverage", () => {
  it("gives every SELECTed line column a base column or a reconciling migration", () => {
    const schemaColumns = lineTableColumns();
    const selected = listSellListLinesSelectColumns();
    expect(selected.length).toBeGreaterThan(5);
    for (const column of selected) {
      expect(schemaColumns, `SELECT column '${column}' has no CREATE TABLE column or ADD COLUMN migration`).toContain(
        column,
      );
    }
  });

  it("reconciles listing_id for long-lived databases with a populated-table-safe migration", () => {
    const listingIdMigration = checkoutSellListSchemaMigrations.find((migration) =>
      migration.statements.some((statement) => /ADD COLUMN IF NOT EXISTS listing_id\b/.test(statement)),
    );
    expect(listingIdMigration, "listing_id drift must be reconciled by an explicit migration").toBeDefined();
    // A nullable ADD COLUMN IF NOT EXISTS is a metadata-only, idempotent change that is
    // safe against an already-populated table under live read traffic (see #4638).
    for (const statement of listingIdMigration?.statements ?? []) {
      expect(statement).toMatch(/ADD COLUMN IF NOT EXISTS/i);
      expect(statement).not.toMatch(/NOT NULL/i);
    }
  });
});
