import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { readCurrentEconomicsOverrides } from "./override-queries";

const key = {
  accountId: "synthetic-owner-account",
  connectionId: "synthetic-connection-1",
  currency: "usd",
} as const;

describe("Economics override projection reader", () => {
  it("distinguishes an active null-cap value from a clear tombstone", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          fact_name: "platformFeeCapPerUnitAmount",
          override_state: "active",
          override_value: null,
          set_at: "2026-09-07T06:01:00Z",
          cleared_at: null,
          last_stream_version: 1,
        },
        {
          fact_name: "turnaroundDays",
          override_state: "cleared",
          override_value: null,
          set_at: null,
          cleared_at: "2026-09-07T06:02:00Z",
          last_stream_version: 2,
        },
      ],
    }));
    const state = await readCurrentEconomicsOverrides({ query } as PgQueryable, key);
    expect(state.entries.platformFeeCapPerUnitAmount).toMatchObject({ kind: "active", value: null, revision: 1 });
    expect(state.entries.turnaroundDays).toMatchObject({ kind: "cleared", revision: 2 });
    expect(state.version).toBe(2);
    expect(query.mock.calls[0]?.[0]).toContain("pricing_economics_overrides.account_id = $1");
  });

  it("fails closed on unknown fact names and non-monotonic projection versions", async () => {
    const unknown = {
      query: async () => ({
        rows: [
          {
            fact_name: "turnaroundDayz",
            override_state: "active",
            override_value: 1,
            set_at: "2026-09-07T06:01:00Z",
            cleared_at: null,
            last_stream_version: 1,
          },
        ],
      }),
    } as PgQueryable;
    await expect(readCurrentEconomicsOverrides(unknown, key)).rejects.toThrow(/Unknown Economics fact/);

    const duplicate = {
      query: async () => ({
        rows: [
          {
            fact_name: "turnaroundDays",
            override_state: "active",
            override_value: 1,
            set_at: "2026-09-07T06:01:00Z",
            cleared_at: null,
            last_stream_version: 1,
          },
          {
            fact_name: "dailyReturnHurdle",
            override_state: "active",
            override_value: 0.01,
            set_at: "2026-09-07T06:01:00Z",
            cleared_at: null,
            last_stream_version: 1,
          },
        ],
      }),
    } as PgQueryable;
    await expect(readCurrentEconomicsOverrides(duplicate, key)).rejects.toThrow(/strictly increasing/);
  });
});
