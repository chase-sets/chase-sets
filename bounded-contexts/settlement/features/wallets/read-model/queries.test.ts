import { describe, expect, it, vi } from "vitest";
import {
  getAccountActiveSpendHoldAmount,
  getAccountActiveSupportHoldAmount,
  listPendingCreditEntriesMaturedBy,
} from "./queries";

describe.each([
  ["spend", getAccountActiveSpendHoldAmount],
  ["support", getAccountActiveSupportHoldAmount],
] as const)("active %s hold total", (_kind, getAmount) => {
  it.each([
    ["0", "0.00"],
    ["0.00", "0.00"],
    ["12.30", "12.30"],
    ["9999999999.99", "9999999999.99"],
  ])("returns base-identical amounts through the money primitive: %s", async (amount, expected) => {
    const query = vi.fn(async () => ({ rows: [{ amount }] }));
    await expect(getAmount({ query } as never, "acct-1")).resolves.toBe(expected);
    expect(query).toHaveBeenCalledWith(expect.any(String), ["acct-1"]);
  });

  it("returns base-identical amounts through the money primitive: absent row", async () => {
    await expect(getAmount({ query: async () => ({ rows: [] }) } as never, "acct-1")).resolves.toBe("0.00");
  });

  it.each(["12abc", "1e3", "", "10000000000.00"])(
    "rejects non-canonical or out-of-range amounts instead of coercing them: %s",
    async (amount) => {
      await expect(getAmount({ query: async () => ({ rows: [{ amount }] }) } as never, "acct-1")).rejects.toThrow(
        Error,
      );
    },
  );
});

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
