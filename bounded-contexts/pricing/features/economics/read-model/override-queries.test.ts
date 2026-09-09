import { describe, expect, it } from "vitest";
import type { PgQueryable, PgQueryFunction } from "@chase-sets/event-core-postgres";
import { readCurrentEconomicsOverrides } from "./override-queries";

const key = {
  accountId: "synthetic-owner-account",
  scopeKey: "channel-connection:synthetic-connection-1",
  currency: "usd",
} as const;

function dbWithRows(rows: readonly Record<string, unknown>[]) {
  const calls: Array<readonly [string, readonly unknown[] | undefined]> = [];
  const query: PgQueryFunction = async <Row>(text: string, values?: readonly unknown[]) => {
    calls.push([text, values]);
    return { rows: rows.map((row) => row as unknown as Row) };
  };
  return { value: { query } satisfies PgQueryable, calls };
}

describe("Economics override projection reader", () => {
  it("distinguishes an active null-cap value from a clear tombstone", async () => {
    const target = dbWithRows([
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
    ]);
    const state = await readCurrentEconomicsOverrides(target.value, key);
    expect(state.entries.platformFeeCapPerUnitAmount).toMatchObject({ kind: "active", value: null, revision: 1 });
    expect(state.entries.turnaroundDays).toMatchObject({ kind: "cleared", revision: 2 });
    expect(state.version).toBe(2);
    expect(target.calls[0]?.[0]).toContain("pricing_economics_overrides.account_id = $1");
    expect(target.calls[0]?.[0]).toContain("pricing_economics_overrides.scope_key = $2");
  });

  it("fails closed on unknown fact names and non-monotonic projection versions", async () => {
    const unknown = dbWithRows([
      {
        fact_name: "turnaroundDayz",
        override_state: "active",
        override_value: 1,
        set_at: "2026-09-07T06:01:00Z",
        cleared_at: null,
        last_stream_version: 1,
      },
    ]).value;
    await expect(readCurrentEconomicsOverrides(unknown, key)).rejects.toThrow(/Unknown Economics fact/);

    const duplicate = dbWithRows([
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
    ]).value;
    await expect(readCurrentEconomicsOverrides(duplicate, key)).rejects.toThrow(/strictly increasing/);
  });
});
