import { describe, expect, it, vi } from "vitest";
import { listPendingCreditEntriesMaturedBy } from "./queries";

describe("settlement wallet release queries", () => {
  it("passes the maturity clock and clamps the unclaimed batch size through parameters", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));

    await listPendingCreditEntriesMaturedBy({ query } as never, {
      now: "2026-05-27T00:00:00.000Z",
      limit: 50_000,
    });

    expect(query).toHaveBeenCalledWith(expect.any(String), ["2026-05-27T00:00:00.000Z", 1000]);
  });

  it("passes claim owner and ttl through parameters for claimed maturity work", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));

    await listPendingCreditEntriesMaturedBy({ query } as never, {
      now: "2026-05-27T00:00:00.000Z",
      limit: 10,
      claimOwnerId: "worker-1",
      claimTtlMs: 5_000,
    });

    expect(query).toHaveBeenCalledWith(expect.any(String), ["2026-05-27T00:00:00.000Z", 10, "worker-1", 5_000]);
  });
});
