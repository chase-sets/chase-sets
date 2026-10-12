import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { getProtectionCoverageAvailability, getProtectionCoverageMetrics } from "./protection-coverage-queries";

describe("protection coverage availability", () => {
  function availabilityDb(
    overrides: Partial<Record<"funded" | "outstanding_reserved" | "consumed" | "recovered_net", string>> = {},
  ) {
    const { funded = "100.00", ...amounts } = overrides;
    return {
      query: async (sql: string) => ({
        rows: sql.includes("settlement_protection_reserve_facts")
          ? [{ funded_amount: funded }]
          : [
              {
                outstanding_reserved: "12.30",
                consumed: "150.00",
                released: "0.00",
                recovered_gross: "0.00",
                recovery_cost: "0.00",
                recovered_net: "0",
                ...amounts,
              },
            ],
      }),
    } as unknown as PgQueryable;
  }

  it.each([
    { recovered_net: "0", expected: "-62.30" },
    { recovered_net: "20.00", expected: "-42.30" },
  ])(
    "returns base-identical amounts through the money primitive: $recovered_net",
    async ({ recovered_net, expected }) => {
      const result = await getProtectionCoverageAvailability(availabilityDb({ recovered_net }));
      expect(result).toEqual({
        fundedAmount: "100.00",
        outstandingReservedAmount: "12.30",
        consumedAmount: "150.00",
        releasedAmount: "0.00",
        recoveredGrossAmount: "0.00",
        recoveryCostAmount: "0.00",
        recoveredNetAmount: recovered_net,
        availableAmount: expected,
      });
    },
  );

  describe.each(["funded", "outstanding_reserved", "consumed", "recovered_net"] as const)("%s operand", (operand) => {
    it.each(["12abc", "1e3", "", "10000000000.00"])(
      "rejects non-canonical or out-of-range amounts instead of coercing them: %s",
      async (amount) => {
        await expect(getProtectionCoverageAvailability(availabilityDb({ [operand]: amount }))).rejects.toThrow(Error);
      },
    );
  });

  it("rejects non-canonical or out-of-range amounts instead of coercing them: result overflow", async () => {
    await expect(
      getProtectionCoverageAvailability(
        availabilityDb({
          funded: "9999999999.99",
          outstanding_reserved: "0",
          consumed: "0",
          recovered_net: "9999999999.99",
        }),
      ),
    ).rejects.toThrow(Error);
  });
});

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
