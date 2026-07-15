import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { getProtectionCoverageMetrics } from "./protection-coverage-queries";

describe("protection coverage recovery metrics", () => {
  it("exposes protection loss and recovery grouped by reason and recovery type", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("status = 'reserved' AND reserved_at")) {
          return { rows: [{ reserved: "0", settled: "1", released: "0", expired: "0", stuck: "0" }] };
        }
        if (sql.includes("settlement_protection_coverage_rejections")) {
          return { rows: [{ rejected: "0" }] };
        }
        if (sql.includes("GROUP BY COALESCE(reason_code")) {
          return {
            rows: [
              {
                reason_code: "fault-indeterminate",
                protection_loss_amount: "40.00",
                recovered_gross_amount: "25.00",
                recovery_cost_amount: "5.00",
                recovered_net_amount: "20.00",
                net_protection_loss_amount: "20.00",
              },
            ],
          };
        }
        if (sql.includes("GROUP BY recovery_type")) {
          return {
            rows: [
              {
                recovery_type: "liquidation-proceeds",
                posting_count: 1,
                gross_amount: "25.00",
                cost_amount: "5.00",
                net_amount: "20.00",
              },
            ],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as PgQueryable;

    const metrics = await getProtectionCoverageMetrics(db, { now: "2026-07-15T00:00:00.000Z" });

    expect(metrics.lossRecoveryByReason).toEqual([
      {
        reasonCode: "fault-indeterminate",
        protectionLossAmount: "40.00",
        recoveredGrossAmount: "25.00",
        recoveryCostAmount: "5.00",
        recoveredNetAmount: "20.00",
        netProtectionLossAmount: "20.00",
      },
    ]);
    expect(metrics.recoveryByType).toEqual([
      {
        recoveryType: "liquidation-proceeds",
        postingCount: 1,
        grossAmount: "25.00",
        costAmount: "5.00",
        netAmount: "20.00",
      },
    ]);
  });
});
