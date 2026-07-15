import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import { getRecoveredItemMetrics } from "./queries";

describe("recovered item metrics", () => {
  it("exposes aging, recovery rate, gross value, cost, and net value", async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [
        {
          total_count: 4,
          unidentified_count: 1,
          quarantined_count: 2,
          sellable_count: 1,
          terminal_count: 1,
          recovered_count: 1,
          recovery_rate: 0.5,
          average_age_hours: 18,
          gross_value: "30.00",
          disposition_cost: "6.00",
          net_recovered_value: "24.00",
        },
      ],
    }));

    const metrics = await getRecoveredItemMetrics({ query } as unknown as PgQueryable);

    expect(metrics).toMatchObject({
      unidentified_count: 1,
      recovery_rate: 0.5,
      gross_value: "30.00",
      disposition_cost: "6.00",
      net_recovered_value: "24.00",
    });
    expect(query.mock.calls[0]?.[0]).toContain("COUNT(DISTINCT recovered_item_id)");
  });
});
