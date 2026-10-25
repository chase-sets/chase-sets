import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { initialRepricingPolicyState, pricingGoalDefinitions } from "../../repricing-policies/domain/domain";
import type { RepricingPolicyServices } from "../../repricing-policies/api/runtime";
import type { RepricingEngineServices } from "../../repricing-engine/api/runtime";
import { hashRepricingDryRunBody, type RepricingDryRun } from "../../repricing-engine/api/dry-run";
import { dryRunBody, dryRunContext } from "../../repricing-engine/tests/dry-run-fixture";
import { createPricingHealthServices } from "../api/services";
import { buildCandidateBody, selectableGoalChoices } from "../api/goal-comparison";

const now = "2026-10-20T00:00:00.000Z";
const adoption = {
  goalId: "fixed-percentile",
  goalVersion: 1,
  lifecycle: "selectable" as const,
  incumbentVersion: null,
  selectable: true,
  promotable: true,
  reason: null,
  grades: null,
};
const choice = selectableGoalChoices(pricingGoalDefinitions(), [adoption])[0]!;

function setup(rules = dryRunBody.rules, hasPolicy = true) {
  let latestRun: RepricingDryRun | null = null;
  const state = {
    ...initialRepricingPolicyState,
    ...dryRunBody,
    rules,
    policyId: "rpp_owned",
    accountId: "acc_owned",
    name: "Current policy",
    status: "active" as const,
  };
  const db: PgQueryable = {
    query: async <Row>(sql: string) => ({
      rows: (hasPolicy && sql.includes("FROM pricing_repricing_policies")
        ? [
            {
              policy_id: state.policyId,
              seller_account_id: state.accountId,
              name: state.name,
              status: "active",
              scope_kind: "all-listings",
              scope_category_ids: null,
              scope_listing_ids: null,
              excluded_listing_ids: [],
              rules,
              max_changes_per_day: 100,
              created_at: now,
              updated_at: now,
            },
          ]
        : sql.includes("ORDER BY requested_at DESC") && latestRun
          ? [{ dryRunId: latestRun.dryRunId }]
          : []) as Row[],
    }),
  };
  const loadOwnedRepricingPolicy = vi
    .fn<RepricingPolicyServices["loadOwnedRepricingPolicy"]>()
    .mockResolvedValue(hasPolicy ? ({ state, version: 7 } as never) : null);
  const enqueueDryRun = vi.fn<RepricingEngineServices["enqueueDryRun"]>().mockResolvedValue(null);
  const getDryRun = vi.fn<RepricingEngineServices["getDryRun"]>().mockImplementation(async () => latestRun);
  const getHalt = vi.fn<RepricingPolicyServices["getHalt"]>().mockResolvedValue({ engaged: false } as never);
  const executeOwnedRepricingPolicy = vi.fn<RepricingPolicyServices["executeOwnedRepricingPolicy"]>();
  const resolvePolicy: PolicyRuntime["resolvePolicy"] = async (definition) => ({
    policyKey: definition.policyKey,
    value: definition.defaultValue,
    source: "fallback",
    documentId: null,
    effectiveFrom: null,
    effectiveUntil: null,
    resolvedAt: now,
  });
  const services = createPricingHealthServices({
    db,
    policies: { resolvePolicy },
    repricingPolicies: { loadOwnedRepricingPolicy, getHalt, executeOwnedRepricingPolicy },
    repricingEngine: { enqueueDryRun, getDryRun },
    forecastLedger: { listGoalAdoptions: async () => [adoption] },
  });
  return {
    state,
    services,
    enqueueDryRun,
    getDryRun,
    setLatestRun: (run: RepricingDryRun) => {
      latestRun = run;
    },
  };
}

function run(id: string, body = buildCandidateBody(dryRunBody, choice)): RepricingDryRun {
  return {
    dryRunId: id,
    body,
    bodyHash: hashRepricingDryRunBody(body),
    replacingPolicyId: "rpp_owned",
    status: "queued",
    requestedAt: now,
    completedAt: null,
    consumedAt: null,
    summary: null,
    health: null,
    cursor: null,
    updatedAt: now,
  };
}

describe("Pricing Health candidate orchestration", () => {
  it.each([
    ["multi-rule", [...dryRunBody.rules, ...dryRunBody.rules]],
    ["conditional", [{ ...dryRunBody.rules[0]!, conditions: [{ type: "quantity-at-least" as const, quantity: 2 }] }]],
  ])("returns only the advanced-editor branch for %s targets without recommendation or enqueue", async (_, rules) => {
    const { services, enqueueDryRun } = setup(rules);
    const result = await services.getHealth("acc_owned", "rpp_owned", now);
    expect(result).toMatchObject({ branch: "advanced-editor", comparison: [], goals: [] });
    expect(result?.recommendation).toBeUndefined();
    expect(await services.compare("acc_owned", "rpp_owned", dryRunContext)).toBeNull();
    expect(enqueueDryRun).not.toHaveBeenCalled();
  });

  it("returns the create branch without a recommendation or enqueue for zero policies", async () => {
    const { services, enqueueDryRun } = setup([], false);
    const result = await services.getHealth("acc_owned", undefined, now);
    expect(result).toMatchObject({ branch: "create-editor", comparison: [], goals: [] });
    expect(result?.recommendation).toBeUndefined();
    expect(await services.compare("acc_owned", "rpp_owned", dryRunContext)).toBeNull();
    expect(enqueueDryRun).not.toHaveBeenCalled();
  });

  it("rejects a candidate for a stale body and a corrupted hash before reading traces", async () => {
    const { services, getDryRun, setLatestRun } = setup();
    const stale = run("stale", { ...buildCandidateBody(dryRunBody, choice), maxChangesPerDay: 99 });
    setLatestRun(stale);
    expect((await services.getHealth("acc_owned", "rpp_owned", now))?.comparison).toEqual([]);
    setLatestRun({ ...run("corrupt"), bodyHash: "wrong" });
    expect((await services.getHealth("acc_owned", "rpp_owned", now))?.comparison).toEqual([]);
    expect(getDryRun).toHaveBeenCalledTimes(2);
  });

  it("selects only the newest run per goal and keeps pending comparison visibly computing", async () => {
    const { services, setLatestRun } = setup();
    setLatestRun(run("new"));
    const result = await services.getHealth("acc_owned", "rpp_owned", now);
    expect(result?.comparison?.map((candidate) => candidate.dryRunId)).toEqual(["new"]);
    expect(result?.computing).toBe(true);
  });

  it("enqueues the exact body-preserving candidate against the selected target without changing it", async () => {
    const { services, state, enqueueDryRun } = setup();
    enqueueDryRun.mockResolvedValue(run("accepted"));
    const before = structuredClone(state);
    await services.compare("acc_owned", "rpp_owned", dryRunContext);
    expect(enqueueDryRun).toHaveBeenCalledExactlyOnceWith(
      {
        sellerAccountId: "acc_owned",
        replacingPolicyId: "rpp_owned",
        body: buildCandidateBody(dryRunBody, choice),
      },
      dryRunContext,
    );
    expect(state).toEqual(before);
  });

  it("fails the request visibly when a candidate enqueue is refused", async () => {
    const { services, enqueueDryRun } = setup();
    await expect(services.compare("acc_owned", "rpp_owned", dryRunContext)).rejects.toThrow(
      "candidate_enqueue_refused",
    );
    expect(enqueueDryRun).toHaveBeenCalledTimes(1);
  });
});
