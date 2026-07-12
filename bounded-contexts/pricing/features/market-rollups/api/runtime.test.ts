import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { ResolvedPolicy } from "@chase-sets/platform-policy/resolver";
import { MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE } from "../../market-trades/domain/stat-hygiene-policy";
import { MARKET_ANALYTICS_DISPLAY_LAUNCH_POLICY_VALUE } from "../domain/display-policy";
import { createMarketRollupsRuntime } from "./runtime";

/**
 * Exercises the exact seam AC1's staging drill describes: a policy revision
 * changes resolved market-stat behavior without a deploy. This is a
 * runtime-composition unit test (fake `PolicyRuntime`, no Postgres) --
 * `../read-model/queries.ts`'s own SQL-level minimum-sample gating is
 * already covered by `../tests/market-rollups.db.test.ts` against a real
 * sandbox; this test instead proves the resolved policy VALUE actually
 * reaches that gate, which is what #4310 wires up.
 */

function fakePolicyRuntime(overrides: Partial<Record<string, unknown>> = {}): PolicyRuntime {
  return {
    commandHandler: vi.fn() as never,
    createPolicyDocument: vi.fn() as never,
    revisePolicyDocument: vi.fn() as never,
    resolvePolicy: vi.fn(async (definition) => ({
      policyKey: definition.policyKey,
      value: definition.defaultValue,
      source: "fallback",
      documentId: null,
      effectiveFrom: null,
      effectiveUntil: null,
      resolvedAt: "2026-07-12T00:00:00.000Z",
    })) as never,
    getPolicyDocument: vi.fn() as never,
    listPolicyDocumentHistory: vi.fn() as never,
    listPolicyRegistry: vi.fn() as never,
    invalidateCache: vi.fn(),
    projectors: [],
    ...overrides,
  } as unknown as PolicyRuntime;
}

function fakeDb(): PgQueryable {
  return { query: async () => ({ rows: [] }) } as unknown as PgQueryable;
}

describe("pricing market-rollups runtime (#4310 policy consumption)", () => {
  it("resolves the compiled fallback stat-hygiene policy for series/closer calls when no revision exists", async () => {
    const policies = fakePolicyRuntime();
    const runtime = createMarketRollupsRuntime({ db: fakeDb(), policies });

    await runtime.getProductRollupSeries({
      catalogItemId: "cat_1",
      productId: "prod_1",
      from: "2026-06-01",
      to: "2026-07-01",
    });

    expect(policies.resolvePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ policyKey: "pricing.market-stat-hygiene" }),
    );
  });

  it("threads a revised minimumTradeSample into the resolved stats snapshot response (#4310 AC1 drill)", async () => {
    const revisedValue = { ...MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE, minimumTradeSample: 5 };
    const policies = fakePolicyRuntime({
      resolvePolicy: vi.fn(async (definition) => {
        if (definition.policyKey === "pricing.market-stat-hygiene") {
          return {
            policyKey: definition.policyKey,
            value: revisedValue,
            source: "policy",
            documentId: "pol_1",
            effectiveFrom: "2026-07-01T00:00:00.000Z",
            effectiveUntil: null,
            resolvedAt: "2026-07-12T00:00:00.000Z",
          } satisfies ResolvedPolicy<unknown>;
        }
        return {
          policyKey: definition.policyKey,
          value: definition.defaultValue,
          source: "fallback",
          documentId: null,
          effectiveFrom: null,
          effectiveUntil: null,
          resolvedAt: "2026-07-12T00:00:00.000Z",
        } satisfies ResolvedPolicy<unknown>;
      }),
    });
    const runtime = createMarketRollupsRuntime({ db: fakeDb(), policies });

    const snapshot = await runtime.getProductMarketStatsSnapshot({ catalogItemId: "cat_1", productId: "prod_1" });

    expect(snapshot.statHygiene.minimumTradeSample).toBe(5);
  });

  it("threads the display policy's showVerifiedMarkers toggle into the resolved stats snapshot response", async () => {
    const policies = fakePolicyRuntime({
      resolvePolicy: vi.fn(async (definition) => {
        if (definition.policyKey === "pricing.market-analytics-display") {
          return {
            policyKey: definition.policyKey,
            value: { ...MARKET_ANALYTICS_DISPLAY_LAUNCH_POLICY_VALUE, showVerifiedMarkers: false },
            source: "policy",
            documentId: "pol_2",
            effectiveFrom: "2026-07-01T00:00:00.000Z",
            effectiveUntil: null,
            resolvedAt: "2026-07-12T00:00:00.000Z",
          } satisfies ResolvedPolicy<unknown>;
        }
        return {
          policyKey: definition.policyKey,
          value: definition.defaultValue,
          source: "fallback",
          documentId: null,
          effectiveFrom: null,
          effectiveUntil: null,
          resolvedAt: "2026-07-12T00:00:00.000Z",
        } satisfies ResolvedPolicy<unknown>;
      }),
    });
    const runtime = createMarketRollupsRuntime({ db: fakeDb(), policies });

    const snapshot = await runtime.getProductMarketStatsSnapshot({ catalogItemId: "cat_1", productId: "prod_1" });

    expect(snapshot.displayPolicy.showVerifiedMarkers).toBe(false);
  });

  it("threads the resolved rollupCloserTrailingWindowDays into the closer job", async () => {
    const revisedValue = { ...MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE, rollupCloserTrailingWindowDays: 10 };
    const policies = fakePolicyRuntime({
      resolvePolicy: vi.fn(async (definition) => ({
        policyKey: definition.policyKey,
        value: definition.policyKey === "pricing.market-stat-hygiene" ? revisedValue : definition.defaultValue,
        source: "policy",
        documentId: "pol_3",
        effectiveFrom: "2026-07-01T00:00:00.000Z",
        effectiveUntil: null,
        resolvedAt: "2026-07-12T00:00:00.000Z",
      })) as never,
    });
    let queriedSince: string | undefined;
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("SELECT DISTINCT") && params) {
          queriedSince = params[0] as string;
        }
        return { rows: [] };
      },
    } as unknown as PgQueryable;
    const runtime = createMarketRollupsRuntime({ db, policies });

    await runtime.runDailyRollupCloser({ now: "2026-07-15T00:00:00.000Z" });

    // 10-day trailing window from 2026-07-15 -> 2026-07-05, not the 3-day compiled default (2026-07-12).
    expect(queriedSince).toBe("2026-07-05T00:00:00.000Z");
  });
});
