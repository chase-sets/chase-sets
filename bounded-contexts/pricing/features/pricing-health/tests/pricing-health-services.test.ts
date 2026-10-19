import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { RepricingPolicyServices } from "../../repricing-policies/api/runtime";
import type { RepricingEngineServices } from "../../repricing-engine/api/runtime";
import { initialRepricingPolicyState } from "../../repricing-policies/domain/domain";
import { FORECAST_LEDGER_LAUNCH_POLICY_VALUE } from "../../forecast-ledger/domain/policy";
import { hashRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import { createPricingHealthServices } from "../api/services";

describe("Pricing Health current revision authority", () => {
  function setup(status: "active" | "paused" = "active") {
    const calls: { sql: string; values?: readonly unknown[] }[] = [];
    const state = {
      ...initialRepricingPolicyState,
      policyId: "rpp_owned",
      accountId: "acc_owned",
      name: "Current policy",
      scope: { kind: "all-listings" as const },
      maxChangesPerDay: 101,
      status,
    };
    const db: PgQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values });
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
                excluded_listing_ids: [],
                rules: [],
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
      policies: { resolvePolicy },
      repricingPolicies: { loadOwnedRepricingPolicy },
      repricingEngine: { enqueueDryRun },
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
});
