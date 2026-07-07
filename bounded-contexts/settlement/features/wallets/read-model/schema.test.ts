import { describe, expect, it } from "vitest";
import { settlementWalletSchemaMigrations, settlementWalletSchemaSql } from "./schema";

describe("settlement wallet schema", () => {
  it("creates the negative-balance index through a migration after compatibility columns exist", () => {
    const statements = settlementWalletSchemaMigrations.flatMap((migration) => migration.statements).join("\n");
    const addStatusColumn = statements.indexOf("ADD COLUMN IF NOT EXISTS negative_balance_status");
    const addStartedAtColumn = statements.indexOf("ADD COLUMN IF NOT EXISTS negative_balance_started_at");
    const addCollectionsColumn = statements.indexOf("ADD COLUMN IF NOT EXISTS collections_escalated_at");
    const negativeBalanceIndex = statements.indexOf(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_wallet_pages_negative_balance_idx",
    );

    expect(settlementWalletSchemaSql).not.toContain("ADD COLUMN IF NOT EXISTS negative_balance_status");
    expect(settlementWalletSchemaSql).not.toContain("settlement_wallet_pages_negative_balance_idx");
    expect(addStatusColumn).toBeGreaterThan(-1);
    expect(addStartedAtColumn).toBeGreaterThan(-1);
    expect(addCollectionsColumn).toBeGreaterThan(-1);
    expect(negativeBalanceIndex).toBeGreaterThan(-1);
    expect(addStatusColumn).toBeLessThan(negativeBalanceIndex);
    expect(addStartedAtColumn).toBeLessThan(negativeBalanceIndex);
    expect(addCollectionsColumn).toBeLessThan(negativeBalanceIndex);
  });
});
