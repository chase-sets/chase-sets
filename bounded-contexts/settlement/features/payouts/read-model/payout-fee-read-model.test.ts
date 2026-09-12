import { describe, expect, it, vi } from "vitest";
import { buildPayoutProjectionHandlers } from "./projection";
import { listPayouts } from "./queries";
import { settlementPayoutSchemaMigrations, settlementPayoutSchemaSql } from "./schema";

describe("payout-fee-reader-inventory read model", () => {
  it("projects requested, fee, and net and maps a historical request to zero fee", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [], rowCount: 1 }));
    const handler = buildPayoutProjectionHandlers({ query } as never)["settlement.payout.requested"]!;

    await handler({
      id: "evt_current" as never,
      streamVersion: 1,
      data: {
        payoutId: "pyo_current",
        accountId: "acc_current",
        amount: "12.50",
        requestedAmount: "12.50",
        feeAmount: "0.29",
        netAmount: "12.21",
        currencyCode: "usd",
        destinationReference: null,
        note: null,
        requestedAt: "2026-09-11T00:00:00.000Z",
      },
    } as never);
    expect(query.mock.calls[0]?.[0]).toContain("requested_amount");
    expect(query.mock.calls[0]?.[0]).toContain("fee_amount");
    expect(query.mock.calls[0]?.[0]).toContain("net_amount");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "pyo_current",
      "acc_current",
      "12.50",
      "0.29",
      "12.21",
      "usd",
      null,
      null,
      expect.any(String),
      "2026-09-11T00:00:00.000Z",
      1,
    ]);

    query.mockClear();
    await handler({
      id: "evt_legacy" as never,
      streamVersion: 1,
      data: {
        payoutId: "pyo_legacy",
        accountId: "acc_legacy",
        amount: "42.00",
        currencyCode: "usd",
        destinationReference: null,
        note: null,
        requestedAt: "2026-08-01T00:00:00.000Z",
      },
    } as never);
    expect(query.mock.calls[0]?.[1]).toEqual([
      "pyo_legacy",
      "acc_legacy",
      "42.00",
      "0.00",
      "42.00",
      "usd",
      null,
      null,
      expect.any(String),
      "2026-08-01T00:00:00.000Z",
      1,
    ]);
  });

  it("selects all three amounts for list readers", async () => {
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string, _values?: readonly unknown[]) => {
        queries.push(sql);
        if (sql.includes("COUNT(*) AS count")) return { rows: [{ count: "0" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };

    await listPayouts(db as never, { accountId: "acc_reader" });

    expect(queries.join("\n")).toContain("requested_amount::text AS requested_amount");
    expect(queries.join("\n")).toContain("fee_amount::text AS fee_amount");
    expect(queries.join("\n")).toContain("net_amount::text AS net_amount");
  });

  it("owns an additive schema and ledgered historical backfill", () => {
    expect(settlementPayoutSchemaSql).toContain("requested_amount numeric(12, 2) NOT NULL DEFAULT 0.00");
    expect(settlementPayoutSchemaSql).toContain("fee_amount numeric(12, 2) NOT NULL DEFAULT 0.00");
    expect(settlementPayoutSchemaSql).toContain("net_amount numeric(12, 2) NOT NULL DEFAULT 0.00");
    const migration = settlementPayoutSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20260911_settlement_payout_fee_amounts",
    );
    expect(migration?.statements.join("\n")).toContain("ADD COLUMN IF NOT EXISTS requested_amount");
    expect(migration?.statements.join("\n")).toContain("ADD COLUMN IF NOT EXISTS fee_amount");
    expect(migration?.statements.join("\n")).toContain("ADD COLUMN IF NOT EXISTS net_amount");
    expect(migration?.statements.join("\n")).toContain("SET requested_amount = amount");
    expect(migration?.statements.join("\n")).toContain("fee_amount = 0.00");
    expect(migration?.statements.join("\n")).toContain("net_amount = amount");
    expect(migration?.statements.join("\n")).toContain("settlement_payout_pages_normalize_legacy_amounts");
  });
});
