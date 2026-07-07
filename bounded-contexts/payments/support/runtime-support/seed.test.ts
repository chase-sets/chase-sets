import { describe, expect, it, vi } from "vitest";
import { seedPaymentsDatabase } from "./seed";

describe("payments seed", () => {
  it("waits for ordering order projections instead of failing bootstrap", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("payments_payment_pages")) {
          return { rows: [{ count: "0" }] };
        }
        if (sql.includes("payments_order_inputs")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    try {
      await seedPaymentsDatabase(pool as never);
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.join("\n")).toContain("Payments seed is waiting for order ord_seed_checkout_pending to be projected.");
  });
});
