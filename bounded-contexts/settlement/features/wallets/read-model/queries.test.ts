import { describe, expect, it, vi } from "vitest";
import { listPendingCreditEntriesMaturedBy } from "./queries";

describe("settlement wallet release queries", () => {
  it("passes the maturity clock, the resolved clearance policy, and clamps the unclaimed batch size through parameters", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));

    await listPendingCreditEntriesMaturedBy({ query } as never, {
      now: "2026-05-27T00:00:00.000Z",
      baseClearanceDays: 2,
      extendedClearanceDays: 7,
      highValueThresholdAmount: "250.00",
      limit: 50_000,
    });

    expect(query).toHaveBeenCalledWith(expect.any(String), ["2026-05-27T00:00:00.000Z", 2, 7, "250.00", 1000]);
  });

  it("passes claim owner and ttl through parameters for claimed maturity work", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));

    await listPendingCreditEntriesMaturedBy({ query } as never, {
      now: "2026-05-27T00:00:00.000Z",
      baseClearanceDays: 2,
      extendedClearanceDays: 7,
      highValueThresholdAmount: "250.00",
      limit: 10,
      claimOwnerId: "worker-1",
      claimTtlMs: 5_000,
    });

    expect(query).toHaveBeenCalledWith(expect.any(String), [
      "2026-05-27T00:00:00.000Z",
      2,
      7,
      "250.00",
      10,
      "worker-1",
      5_000,
    ]);
  });

  it("reads windows and the high-value threshold from the resolved policy instead of a compiled default", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));

    await listPendingCreditEntriesMaturedBy({ query } as never, {
      now: "2026-05-27T00:00:00.000Z",
      baseClearanceDays: 1,
      extendedClearanceDays: 3,
      highValueThresholdAmount: "500.00",
      limit: 25,
    });

    expect(query).toHaveBeenCalledWith(expect.any(String), ["2026-05-27T00:00:00.000Z", 1, 3, "500.00", 25]);
  });
});
