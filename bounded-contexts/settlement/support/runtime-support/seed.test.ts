import { describe, expect, it, vi } from "vitest";
import { seedSettlementDatabase } from "./seed";

describe("settlement seed", () => {
  it("waits for captured payment projections instead of failing bootstrap", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("event_store_events")) {
          return { rows: [] };
        }
        if (sql.includes("settlement_payout_pages")) {
          return { rows: [{ count: "0" }] };
        }
        if (sql.includes("settlement_payment_sources")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected seed query: ${sql}`);
      }),
    };

    try {
      await seedSettlementDatabase(pool as never, undefined, {
        enabledDataProfiles: ["scenario-seed"],
        environmentName: "test",
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.join("\n")).toContain(
      "Settlement seed is waiting for captured payment pay_seed_offer_captured. Skipping payouts for this pass.",
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM event_store_events"),
      expect.arrayContaining([expect.stringContaining("settlement.wallet-")]),
    );
  });
});
