import { describe, expect, it, vi } from "vitest";
import { seedFulfillmentDatabase } from "./seed";

describe("fulfillment seed", () => {
  it("waits for ready order projections instead of failing bootstrap", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("event_store_events")) {
          return { rows: [] };
        }
        if (sql.includes("fulfillment_shipment_pages")) {
          return { rows: [{ count: "0" }] };
        }
        if (sql.includes("fulfillment_order_sources")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected seed query: ${sql}`);
      }),
    };

    try {
      await seedFulfillmentDatabase(pool as never);
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.join("\n")).toContain(
      "Fulfillment seed is waiting for two ready-for-fulfillment orders. Skipping shipments for this pass.",
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM event_store_events"),
      expect.arrayContaining([expect.stringContaining("fulfillment.shipment-")]),
    );
  });
});
