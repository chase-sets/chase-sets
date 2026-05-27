import { describe, expect, it, vi } from "vitest";
import { listPendingCreditEntriesMaturedBy } from "./queries";

describe("settlement wallet release queries", () => {
  it("requires delivered fulfillment and releases both sale proceeds and shipping allowances", async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await listPendingCreditEntriesMaturedBy({ query } as never, {
      now: "2026-05-27T00:00:00.000Z",
    });

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("kind IN ('sale', 'rebate')");
    expect(sql).toContain("settlement_order_fulfillment_sources fulfillment");
    expect(sql).toContain("fulfillment.status = 'delivered'");
    expect(sql).toContain("INTERVAL '7 days'");
    expect(sql).toContain("manual_payout_review");
  });
});
