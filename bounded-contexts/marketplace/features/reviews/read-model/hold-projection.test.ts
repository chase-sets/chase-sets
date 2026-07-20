import { describe, expect, it, vi } from "vitest";
import { buildReviewHoldProjectionHandlers } from "./hold-projection";

describe("marketplace review hold projection", () => {
  it("stops a stale hold event after its versioned hold-page upsert", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        return { rows: [] };
      }),
    };
    const handler = buildReviewHoldProjectionHandlers(db as never)["marketplace.review-hold.placed"];

    await handler?.({
      streamVersion: 2,
      globalPosition: "2",
      data: {
        orderId: "ord_1",
        activeSupportRequestIds: ["sup_1"],
        heldDirections: ["buyer-to-seller"],
        holdStartedAt: "2026-07-20T00:00:00.000Z",
        lifecycleAt: "2026-07-20T00:00:00.000Z",
      },
    } as never);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("last_stream_version <= EXCLUDED.last_stream_version");
    expect(queries[0]?.params).toEqual(expect.arrayContaining(["2"]));
  });
});
