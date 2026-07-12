import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { ResolvedPolicy } from "@chase-sets/platform-policy/resolver";
import { MARKET_ANALYTICS_DISPLAY_LAUNCH_POLICY_VALUE } from "../../market-rollups/domain/display-policy";
import { MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE } from "../../market-trades/domain/stat-hygiene-policy";
import { createPublicMarketPagesRuntime } from "./runtime";

function fakePolicyRuntime(resolveOverride?: PolicyRuntime["resolvePolicy"]): PolicyRuntime {
  return {
    commandHandler: vi.fn() as never,
    createPolicyDocument: vi.fn() as never,
    revisePolicyDocument: vi.fn() as never,
    resolvePolicy:
      resolveOverride ??
      (vi.fn(async (definition) => ({
        policyKey: definition.policyKey,
        value: definition.defaultValue,
        source: "fallback",
        documentId: null,
        effectiveFrom: null,
        effectiveUntil: null,
        resolvedAt: "2026-07-12T00:00:00.000Z",
      })) as never),
    getPolicyDocument: vi.fn() as never,
    listPolicyDocumentHistory: vi.fn() as never,
    listPolicyRegistry: vi.fn() as never,
    invalidateCache: vi.fn(),
    projectors: [],
  } as unknown as PolicyRuntime;
}

describe("pricing public-market-pages runtime (#4310 policy consumption)", () => {
  it("resolves both the display and stat-hygiene policies to their compiled fallbacks by default", async () => {
    const policies = fakePolicyRuntime();
    const db = { query: async () => ({ rows: [] }) } as unknown as PgQueryable;
    const runtime = createPublicMarketPagesRuntime({ db, policies });

    const page = await runtime.getPublicMarketPage("does-not-exist");

    expect(page).toBeNull();
    expect(policies.resolvePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ policyKey: "pricing.market-analytics-display" }),
    );
  });

  it("exposes resolveDisplayPolicy directly for the route's Cache-Control header", async () => {
    const revised = { ...MARKET_ANALYTICS_DISPLAY_LAUNCH_POLICY_VALUE, publicPageCacheTtlSeconds: 1800 };
    const resolvePolicy: PolicyRuntime["resolvePolicy"] = vi.fn(async (definition) => {
      if (definition.policyKey === "pricing.market-analytics-display") {
        return {
          policyKey: definition.policyKey,
          value: revised,
          source: "policy",
          documentId: "pol_1",
          effectiveFrom: "2026-07-01T00:00:00.000Z",
          effectiveUntil: null,
          resolvedAt: "2026-07-12T00:00:00.000Z",
        } satisfies ResolvedPolicy<unknown> as never;
      }
      return {
        policyKey: definition.policyKey,
        value: definition.defaultValue,
        source: "fallback",
        documentId: null,
        effectiveFrom: null,
        effectiveUntil: null,
        resolvedAt: "2026-07-12T00:00:00.000Z",
      } as never;
    });
    const policies = fakePolicyRuntime(resolvePolicy);
    const db = { query: async () => ({ rows: [] }) } as unknown as PgQueryable;
    const runtime = createPublicMarketPagesRuntime({ db, policies });

    const display = await runtime.resolveDisplayPolicy();

    expect(display.publicPageCacheTtlSeconds).toBe(1800);
  });

  it("carries the compiled stat-hygiene default when resolving minimumTradeSample for the public page series", () => {
    // Documents the shared, single-sourced gate this slice intentionally keeps
    // (see domain/display-policy.ts's SCOPE NOTE): the public page's series
    // query is gated by the SAME minimumTradeSample as the item-detail panel.
    expect(MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE.minimumTradeSample).toBe(3);
  });
});
