import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import * as acquisition from "../domain/count-acquisition";
import { scrydexBillingPeriodSchema } from "../domain/scrydex-billing-period";
import { guardDisabledMutant } from "../tests/count-capture-mutants";
import { periodAt, syntheticPeriod } from "../tests/scrydex-period-fixture";
import { createCountStore } from "./count-store";

describe("count billing-period ledger query", () => {
  it("bounds unresolved usage to the snapshot billing period without narrowing the lag arm", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            payload: {
              remainingCredits: 100_000,
              totalCredits: 100_000,
              observedAt: periodAt,
              attemptState: "checked",
              billingPeriod: syntheticPeriod,
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ debits: "0", reserved: "0" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ credits: "2", uncertain: "0" }] });
    const pool: PgTransactionalPool = { query: query as PgTransactionalPool["query"], connect: vi.fn() };
    const createStore =
      process.env.SCRYDEX_PERIOD_MUTANT === "unbounded-unresolved-usage"
        ? guardDisabledMutant<typeof createCountStore>(
            "../read-model/count-store.ts",
            ["s->>'status' IS NULL AND (s->>'debitedAt')::timestamptz >= $4::timestamptz", "s->>'status' IS NULL"],
            "createCountStore",
            { randomUUID, z, withPgTransaction, ...acquisition, scrydexBillingPeriodSchema },
          )
        : createCountStore;
    const ledger = await createStore(pool, "synthetic-slot", () => periodAt).periodLedger("synthetic-current-run");
    const [sql, values] = query.mock.calls[3]!;
    expect(sql.replace(/\s+/g, " ")).toContain(
      "((s->>'debitedAt')::timestamptz > $2::timestamptz OR (s->>'status' IS NULL AND (s->>'debitedAt')::timestamptz >= $4::timestamptz))",
    );
    expect(values).toEqual([
      "synthetic-current-run",
      "2026-10-13T07:32:00.000Z",
      "synthetic-slot",
      syntheticPeriod.startsAt,
    ]);
    expect(ledger.durableCredits).toBe(2);
    expect(query).toHaveBeenCalledTimes(4);
  });
});
