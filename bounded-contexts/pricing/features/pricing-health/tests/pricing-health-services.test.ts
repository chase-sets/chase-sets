import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { RepricingPolicyServices } from "../../repricing-policies/api/runtime";
import type { RepricingEngineServices } from "../../repricing-engine/api/runtime";
import { initialRepricingPolicyState, type RepricingPolicyScope } from "../../repricing-policies/domain/domain";
import { FORECAST_LEDGER_LAUNCH_POLICY_VALUE } from "../../forecast-ledger/domain/policy";
import { hashRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import { dryRunBody } from "../../repricing-engine/tests/dry-run-fixture";
import { createPricingHealthServices } from "../api/services";

describe("Pricing Health current revision authority", () => {
  function setup(
    status: "active" | "paused" = "active",
    whatIfFails = false,
    corruptGrade = false,
    scope: RepricingPolicyScope = { kind: "all-listings" },
    excludedListingIds: readonly string[] = [],
    goalAdoptions: readonly unknown[] = [],
  ) {
    const calls: { sql: string; values?: readonly unknown[] }[] = [];
    const state = {
      ...initialRepricingPolicyState,
      policyId: "rpp_owned",
      accountId: "acc_owned",
      name: "Current policy",
      scope,
      excludedListingIds,
      maxChangesPerDay: 101,
      status,
      rules: corruptGrade
        ? [
            {
              ...dryRunBody.rules[0]!,
              directive: {
                ...dryRunBody.rules[0]!.directive,
                anchorChain: [
                  {
                    source: "curve-objective" as const,
                    goalId: "fixed-percentile",
                    goalVersion: 1,
                    parameters: { percentile: 50 },
                  },
                ],
              },
            },
          ]
        : dryRunBody.rules,
    };
    const db: PgQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values });
        if (whatIfFails && sql.includes("FROM pricing_market_listing_inputs"))
          throw new Error("synthetic what-if outage");
        if (corruptGrade && sql.includes("FROM pricing_forecast_grades"))
          return {
            rows: [
              {
                closed_on: "2026-10-18",
                forecast_kind: "curve",
                model: "synthetic-corrupt",
                horizon_days: 21,
                grade: null,
              },
            ] as Row[],
          };
        const rows = sql.includes("FROM pricing_repricing_policies")
          ? [
              {
                policy_id: "rpp_owned",
                seller_account_id: "acc_owned",
                name: "Stale projected policy",
                status: "active",
                scope_kind: "all-listings",
                scope_category_ids: null,
                scope_listing_ids: null,
                excluded_listing_ids: excludedListingIds,
                rules: state.rules,
                max_changes_per_day: 100,
                created_at: "2026-10-18",
                updated_at: "2026-10-18",
              },
            ]
          : [];
        return { rows: rows as Row[] };
      },
    };
    const loadOwnedRepricingPolicy = vi
      .fn<RepricingPolicyServices["loadOwnedRepricingPolicy"]>()
      .mockResolvedValue({ state, version: 1 } as never);
    const enqueueDryRun = vi.fn<RepricingEngineServices["enqueueDryRun"]>().mockResolvedValue(null);
    const resolvePolicy = vi
      .fn<PolicyRuntime["resolvePolicy"]>()
      .mockResolvedValue({ value: FORECAST_LEDGER_LAUNCH_POLICY_VALUE } as never);
    const services = createPricingHealthServices({
      db,
      policies: { resolvePolicy: resolvePolicy as never },
      repricingPolicies: {
        loadOwnedRepricingPolicy,
        getHalt: vi.fn<RepricingPolicyServices["getHalt"]>().mockResolvedValue({ engaged: false } as never),
        executeOwnedRepricingPolicy: vi.fn<RepricingPolicyServices["executeOwnedRepricingPolicy"]>(),
      },
      repricingEngine: { enqueueDryRun, getDryRun: vi.fn<RepricingEngineServices["getDryRun"]>() },
      forecastLedger: { listGoalAdoptions: async () => goalAdoptions as never },
      economics: {
        resolve: async () => {
          if (whatIfFails) throw new Error("must not reach Economics");
          throw new Error("Synthetic service fixture does not resolve Economics.");
        },
      },
    });
    return { state, calls, services, loadOwnedRepricingPolicy, enqueueDryRun };
  }

  it("hashes and computes the folded current body, never the lagging projected body", async () => {
    const { services, calls, state, loadOwnedRepricingPolicy, enqueueDryRun } = setup();
    expect(await services.getHealth("acc_owned", "rpp_owned", "2026-10-19T00:00:00.000Z")).toMatchObject({
      target: { name: "Current policy" },
      health: null,
    });
    expect(loadOwnedRepricingPolicy).toHaveBeenCalledWith("rpp_owned", "acc_owned");
    const currentBody = { scope: state.scope, rules: state.rules, excludedListingIds: [], maxChangesPerDay: 101 };
    expect(calls.find(({ sql }) => sql.includes("AND health IS NOT NULL"))?.values).toEqual([
      "acc_owned",
      "rpp_owned",
      hashRepricingDryRunBody(currentBody),
    ]);
    await services.compute("acc_owned", "rpp_owned", {} as never);
    expect(enqueueDryRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_owned",
        replacingPolicyId: "rpp_owned",
        body: expect.objectContaining(currentBody),
      }),
      {},
    );
  });

  it("refuses a currently paused target even if its projection still says active", async () => {
    const { services, enqueueDryRun } = setup("paused");
    expect(await services.getHealth("acc_owned", "rpp_owned", "2026-10-19T00:00:00.000Z")).toBeNull();
    expect(await services.compute("acc_owned", "rpp_owned", {} as never)).toBeNull();
    expect(enqueueDryRun).not.toHaveBeenCalled();
  });

  it("contains an adapter rejection without losing the verdict, comparison or grades (F2)", async () => {
    const { services } = setup("active", true);
    expect(await services.getHealth("acc_owned", "rpp_owned", "2026-10-19T00:00:00.000Z")).toMatchObject({
      target: { name: "Current policy" },
      health: null,
      comparison: [],
      grades: [],
      whatIf: { status: "unavailable" },
    });
  });

  it.each([undefined, "rpp_owned"])(
    "rejects corrupt grades for both implicit and explicit selectors: %s (F5)",
    async (selector) => {
      const { services } = setup("active", false, true);
      await expect(services.getHealth("acc_owned", selector, "2026-10-19T00:00:00.000Z")).rejects.toThrow();
    },
  );

  it("passes catalog categories and policy exclusions to the provenance listing query", async () => {
    const { services, calls } = setup(
      "active",
      false,
      false,
      { kind: "catalog-filter", categoryIds: ["cat_synthetic_a"] },
      ["lst_excluded"],
      [
        {
          goalId: "profit-per-day",
          goalVersion: 1,
          lifecycle: "selectable",
          incumbentVersion: null,
          selectable: true,
          promotable: true,
          reason: null,
          grades: null,
        },
      ],
    );
    await services.getHealth("acc_owned", "rpp_owned", "2026-10-19T00:00:00.000Z");
    const provenanceQuery = calls.find(({ sql }) => sql.includes("category_ids && $4::text[]"));
    expect(provenanceQuery?.sql).toContain("AND NOT (listing_id = ANY($5::text[]))");
    expect(provenanceQuery?.values).toEqual(["acc_owned", "catalog-filter", [], ["cat_synthetic_a"], ["lst_excluded"]]);
  });
});
