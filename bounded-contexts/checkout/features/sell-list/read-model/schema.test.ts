import { describe, expect, it } from "vitest";
import { checkoutSellListSchemaSql } from "./schema";

/**
 * Guards the CREATE-TABLE-IF-NOT-EXISTS drift trap that 500'd `/account/sell-list`
 * on the persistent staging projection store: `listing_id` (and other later columns)
 * were added to the `CREATE TABLE` but never to an already-existing table, so read
 * SELECTs referenced a column the live table lacked.
 *
 * Every column that a read query SELECTs from a long-lived sell-list projection table
 * MUST also be reconciled by an idempotent `ADD COLUMN IF NOT EXISTS` self-heal, so
 * databases created before the column existed pick it up on schema apply.
 */

function selfHealedColumns(table: string): Set<string> {
  const alter = new RegExp(
    `ALTER TABLE ${table}\\s+([\\s\\S]*?);`,
    "i",
  ).exec(checkoutSellListSchemaSql);
  const columns = new Set<string>();
  if (!alter) {
    return columns;
  }
  for (const match of alter[1].matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/gi)) {
    columns.add(match[1]);
  }
  return columns;
}

describe("checkout sell-list schema self-heal", () => {
  it("reconciles every drift-prone line-page column, including listing_id", () => {
    const healed = selfHealedColumns("checkout_sell_list_line_pages");
    for (const column of [
      "listing_id",
      "buyer_display_name",
      "offer_price_amount",
      "item_subtitle",
      "selected_options",
      "product_summary",
      "fallback_mode",
      "minimum_listing_price_amount",
    ]) {
      expect(healed, `missing self-heal ADD COLUMN for ${column}`).toContain(column);
    }
  });

  it("self-heals confirmation-page evidence columns", () => {
    const healed = selfHealedColumns("checkout_sell_list_confirmation_pages");
    for (const column of ["readiness_evidence", "seller_evidence", "handoff_summary"]) {
      expect(healed).toContain(column);
    }
  });

  it("self-heals offer-page columns added after initial creation", () => {
    const healed = selfHealedColumns("checkout_sell_offer_pages");
    for (const column of ["item_subtitle", "selected_options", "product_summary", "last_stream_version"]) {
      expect(healed).toContain(column);
    }
  });

  it("uses only idempotent, populated-table-safe self-heal statements", () => {
    const alters = checkoutSellListSchemaSql.match(/ADD COLUMN[^,\n]*/gi) ?? [];
    expect(alters.length).toBeGreaterThan(0);
    for (const alter of alters) {
      // IF NOT EXISTS keeps re-apply idempotent.
      expect(alter).toMatch(/ADD COLUMN IF NOT EXISTS/i);
      // A NOT NULL self-heal against an already-populated table must carry a DEFAULT.
      if (/NOT NULL/i.test(alter)) {
        expect(alter, `NOT NULL self-heal needs DEFAULT: ${alter}`).toMatch(/DEFAULT/i);
      }
    }
  });
});
