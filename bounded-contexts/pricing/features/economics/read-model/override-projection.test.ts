import { describe, expect, it } from "vitest";
import type { PgQueryable, PgQueryFunction } from "@chase-sets/event-core-postgres";
import { buildEconomicsOverrideProjectionHandlers } from "./override-projection";

function recordingDb() {
  const calls: Array<readonly [string, readonly unknown[] | undefined]> = [];
  const query: PgQueryFunction = async <Row>(text: string, values?: readonly unknown[]) => {
    calls.push([text, values]);
    return { rows: [] as Row[] };
  };
  return { value: { query } satisfies PgQueryable, calls };
}

function event(type: string, streamVersion: number, value: unknown) {
  return {
    id: `evt_${streamVersion}`,
    type,
    streamId: "pricing.economics-overrides-synthetic",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tenant",
    data: {
      accountId: "synthetic-owner-account",
      scopeKey: "synthetic-connection-1",
      currency: "usd",
      factName: "platformFeeCapPerUnitAmount",
      value,
      occurredAt: `2026-09-07T06:0${streamVersion}:00Z`,
    },
    metadata: {},
    audit: { performedByUserId: "synthetic-user", forAccountId: "synthetic-owner-account" },
    trace: {},
    timing: { occurredAt: `2026-09-07T06:0${streamVersion}:00Z`, recordedAt: "2026-09-07T07:00:00Z" },
  } as never;
}

describe("Economics override projection", () => {
  it("persists an active null cap distinctly and fences stale delivery by stream version", async () => {
    const target = recordingDb();
    const handlers = buildEconomicsOverrideProjectionHandlers(target.value);
    await handlers["pricing.economics-fact-override-set"]!(event("pricing.economics-fact-override-set", 1, null));

    expect(target.calls).toHaveLength(1);
    const [sql, values] = target.calls[0]!;
    expect(sql).toContain("pricing_economics_overrides.last_stream_version < EXCLUDED.last_stream_version");
    expect(sql).toContain("stream_watermark.last_stream_version >= $9");
    expect(values).toEqual([
      "synthetic-owner-account",
      "synthetic-connection-1",
      "usd",
      "platformFeeCapPerUnitAmount",
      "active",
      "null",
      "2026-09-07T06:01:00Z",
      null,
      1,
      "evt_1",
      "2026-09-07T07:00:00Z",
    ]);
  });

  it("persists clear tombstones without deleting the row", async () => {
    const target = recordingDb();
    const handlers = buildEconomicsOverrideProjectionHandlers(target.value);
    await handlers["pricing.economics-fact-override-cleared"]!(
      event("pricing.economics-fact-override-cleared", 2, null),
    );
    const [sql, values] = target.calls[0]!;
    expect(sql).not.toMatch(/DELETE FROM pricing_economics_overrides/);
    expect(values?.slice(4, 8)).toEqual(["cleared", null, null, "2026-09-07T06:02:00Z"]);
  });
});
