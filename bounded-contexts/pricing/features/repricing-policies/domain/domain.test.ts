import { describe, expect, it } from "vitest";
import {
  decideRepricingPolicy,
  evolveRepricingPolicy,
  initialRepricingPolicyState,
  repricingPolicyScopeSpecificity,
  type CreateRepricingPolicyCommand,
  type RepricingPolicyEvent,
  type RepricingPolicyState,
  type RepricingRule,
} from "./domain";
import { REPRICING_POLICY_RULE_CAP } from "./policy-bounds";

function fold(state: RepricingPolicyState, events: readonly RepricingPolicyEvent[]): RepricingPolicyState {
  return events.reduce(evolveRepricingPolicy, state);
}

const defaultRule: RepricingRule = {
  conditions: [],
  directive: {
    anchorChain: [{ source: "market-estimate" }],
    offset: { mode: "percent", percent: -2 },
    floor: { mode: "absolute", amount: "5.00" },
    ceiling: { mode: "absolute", amount: "500.00" },
    tolerance: { mode: "percent", percent: 3 },
    rounding: { mode: "none" },
    maxMovePercent: 15,
    terminal: { kind: "hold" },
  },
};

const gradedRule: RepricingRule = {
  conditions: [{ type: "item-grading", grading: "graded" }],
  directive: {
    anchorChain: [{ source: "lowest-competing-ask" }, { source: "market-estimate" }],
    offset: { mode: "absolute", amount: "-1.00" },
    floor: { mode: "cost-basis-plus-margin", marginPercent: 20, absoluteFallbackAmount: "10.00" },
    ceiling: null,
    tolerance: { mode: "absolute", amount: "0.50" },
    rounding: { mode: "charm" },
    maxMovePercent: null,
    terminal: { kind: "pause", reason: "no ground anchor available" },
  },
};

const createCommand = {
  type: "CreateRepricingPolicy",
  policyId: "rpp_test" as never,
  accountId: "acc_seller" as never,
  name: "Singles floor+margin",
  scope: { kind: "all-listings" },
  rules: [gradedRule, defaultRule],
  maxChangesPerDay: 50,
  createdAt: "2026-07-11T00:00:00.000Z",
} satisfies CreateRepricingPolicyCommand;

describe("RepricingPolicy lifecycle", () => {
  it("creates a policy with normalized fields", () => {
    const events = decideRepricingPolicy(initialRepricingPolicyState, createCommand);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "pricing.repricing-policy.created",
      data: { policyId: "rpp_test", accountId: "acc_seller", name: "Singles floor+margin", maxChangesPerDay: 50 },
    });

    const state = fold(initialRepricingPolicyState, events);
    expect(state.status).toBe("active");
    expect(state.rules).toHaveLength(2);
    expect(state.scope).toEqual({ kind: "all-listings" });
  });

  it("rejects creating a policy twice", () => {
    const created = fold(
      initialRepricingPolicyState,
      decideRepricingPolicy(initialRepricingPolicyState, createCommand),
    );
    expect(() => decideRepricingPolicy(created, createCommand)).toThrow("already been created");
  });

  it("rejects revising a policy that has not been created", () => {
    expect(() =>
      decideRepricingPolicy(initialRepricingPolicyState, {
        type: "ReviseRepricingPolicy",
        name: "x",
        scope: { kind: "all-listings" },
        rules: [defaultRule],
        maxChangesPerDay: 5,
        revisedAt: "2026-07-11T00:00:00.000Z",
      }),
    ).toThrow("has not been created");
  });

  it("revises scope, rules, and budget, recording a new event", () => {
    const created = fold(
      initialRepricingPolicyState,
      decideRepricingPolicy(initialRepricingPolicyState, createCommand),
    );
    const revised = decideRepricingPolicy(created, {
      type: "ReviseRepricingPolicy",
      name: "Singles floor+margin v2",
      scope: { kind: "listing-set", listingIds: ["lst_1", "lst_2"] },
      rules: [defaultRule],
      maxChangesPerDay: 10,
      revisedAt: "2026-07-12T00:00:00.000Z",
    });
    expect(revised).toHaveLength(1);
    expect(revised[0]?.type).toBe("pricing.repricing-policy.revised");

    const state = fold(created, revised);
    expect(state.scope).toEqual({ kind: "listing-set", listingIds: ["lst_1", "lst_2"] });
    expect(state.maxChangesPerDay).toBe(10);
    expect(state.updatedAt).toBe("2026-07-12T00:00:00.000Z");
  });

  it("suppresses a no-op revision (unchanged body)", () => {
    const created = fold(
      initialRepricingPolicyState,
      decideRepricingPolicy(initialRepricingPolicyState, createCommand),
    );
    const revised = decideRepricingPolicy(created, {
      type: "ReviseRepricingPolicy",
      name: createCommand.name,
      scope: createCommand.scope,
      excludedListingIds: [],
      rules: createCommand.rules,
      maxChangesPerDay: createCommand.maxChangesPerDay,
      revisedAt: "2026-07-12T00:00:00.000Z",
    });
    expect(revised).toEqual([]);
  });

  it("pauses an active policy and is idempotent when already paused", () => {
    const created = fold(
      initialRepricingPolicyState,
      decideRepricingPolicy(initialRepricingPolicyState, createCommand),
    );
    const pausedEvents = decideRepricingPolicy(created, {
      type: "PauseRepricingPolicy",
      pausedAt: "2026-07-12T00:00:00.000Z",
    });
    expect(pausedEvents).toHaveLength(1);
    const paused = fold(created, pausedEvents);
    expect(paused.status).toBe("paused");

    expect(
      decideRepricingPolicy(paused, { type: "PauseRepricingPolicy", pausedAt: "2026-07-13T00:00:00.000Z" }),
    ).toEqual([]);
  });

  it("resumes a paused policy and is idempotent when already active", () => {
    const created = fold(
      initialRepricingPolicyState,
      decideRepricingPolicy(initialRepricingPolicyState, createCommand),
    );
    expect(
      decideRepricingPolicy(created, { type: "ResumeRepricingPolicy", resumedAt: "2026-07-12T00:00:00.000Z" }),
    ).toEqual([]);

    const paused = fold(
      created,
      decideRepricingPolicy(created, { type: "PauseRepricingPolicy", pausedAt: "2026-07-12T00:00:00.000Z" }),
    );
    const resumedEvents = decideRepricingPolicy(paused, {
      type: "ResumeRepricingPolicy",
      resumedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(resumedEvents).toHaveLength(1);
    expect(fold(paused, resumedEvents).status).toBe("active");
  });

  it("deletes a policy terminally and rejects further lifecycle commands", () => {
    const created = fold(
      initialRepricingPolicyState,
      decideRepricingPolicy(initialRepricingPolicyState, createCommand),
    );
    const deletedEvents = decideRepricingPolicy(created, {
      type: "DeleteRepricingPolicy",
      deletedAt: "2026-07-12T00:00:00.000Z",
    });
    expect(deletedEvents).toHaveLength(1);
    const deleted = fold(created, deletedEvents);
    expect(deleted.status).toBe("deleted");

    // Idempotent re-delete.
    expect(
      decideRepricingPolicy(deleted, { type: "DeleteRepricingPolicy", deletedAt: "2026-07-13T00:00:00.000Z" }),
    ).toEqual([]);

    expect(() =>
      decideRepricingPolicy(deleted, {
        type: "ReviseRepricingPolicy",
        name: "x",
        scope: { kind: "all-listings" },
        rules: [defaultRule],
        maxChangesPerDay: 5,
        revisedAt: "2026-07-13T00:00:00.000Z",
      }),
    ).toThrow("deleted repricing policy cannot be revised");
    expect(() =>
      decideRepricingPolicy(deleted, { type: "PauseRepricingPolicy", pausedAt: "2026-07-13T00:00:00.000Z" }),
    ).toThrow("deleted repricing policy cannot be paused");
    expect(() =>
      decideRepricingPolicy(deleted, { type: "ResumeRepricingPolicy", resumedAt: "2026-07-13T00:00:00.000Z" }),
    ).toThrow("deleted repricing policy cannot be resumed");
  });
});

describe("RepricingPolicy scope precedence", () => {
  it("ranks listing-set as most specific and all-listings as least specific", () => {
    expect(repricingPolicyScopeSpecificity({ kind: "all-listings" })).toBe(0);
    expect(repricingPolicyScopeSpecificity({ kind: "catalog-filter", categoryIds: ["cat_a"] })).toBe(1);
    expect(repricingPolicyScopeSpecificity({ kind: "listing-set", listingIds: ["lst_1"] })).toBe(2);
  });
});

describe("RepricingPolicy validation matrix", () => {
  function createWith(overrides: Partial<CreateRepricingPolicyCommand>): () => unknown {
    return () => decideRepricingPolicy(initialRepricingPolicyState, { ...createCommand, ...overrides });
  }

  it("rejects a blank name", () => {
    expect(createWith({ name: "   " })).toThrow("must not be blank");
  });

  it("rejects an empty rule pipeline", () => {
    expect(createWith({ rules: [] })).toThrow("at least one rule");
  });

  it("rejects a rule pipeline exceeding the cap", () => {
    const tooMany: RepricingRule[] = Array.from({ length: REPRICING_POLICY_RULE_CAP }, () => ({
      conditions: [{ type: "quantity-at-least", quantity: 1 }],
      directive: defaultRule.directive,
    }));
    tooMany.push(defaultRule);
    expect(createWith({ rules: tooMany })).toThrow(`cannot define more than ${REPRICING_POLICY_RULE_CAP} rules`);
  });

  it("accepts a rule pipeline exactly at the cap", () => {
    const atCap: RepricingRule[] = Array.from({ length: REPRICING_POLICY_RULE_CAP - 1 }, () => ({
      conditions: [{ type: "quantity-at-least", quantity: 1 }],
      directive: defaultRule.directive,
    }));
    atCap.push(defaultRule);
    expect(createWith({ rules: atCap })()).toBeTruthy();
  });

  it("rejects a non-default final rule (missing trailing catch-all)", () => {
    expect(createWith({ rules: [gradedRule] })).toThrow("must be the unconditional default rule");
  });

  it("rejects a non-final rule with no conditions", () => {
    expect(createWith({ rules: [defaultRule, defaultRule] })).toThrow("may be unconditional");
  });

  it("rejects an empty anchor chain", () => {
    expect(
      createWith({
        rules: [{ ...defaultRule, directive: { ...defaultRule.directive, anchorChain: [] } }],
      }),
    ).toThrow("at least one anchor");
  });

  it("rejects an out-of-range comp-percentile", () => {
    expect(
      createWith({
        rules: [
          {
            ...defaultRule,
            directive: { ...defaultRule.directive, anchorChain: [{ source: "comp-percentile", percentile: 100 }] },
          },
        ],
      }),
    ).toThrow("comp-percentile anchor percentile");
  });

  it("rejects a non-positive absolute floor", () => {
    expect(
      createWith({
        rules: [
          { ...defaultRule, directive: { ...defaultRule.directive, floor: { mode: "absolute", amount: "0.00" } } },
        ],
      }),
    ).toThrow("greater than zero");
  });

  it("rejects a negative cost-basis margin percent", () => {
    expect(
      createWith({
        rules: [
          {
            ...defaultRule,
            directive: {
              ...defaultRule.directive,
              floor: { mode: "cost-basis-plus-margin", marginPercent: -5, absoluteFallbackAmount: "5.00" },
            },
          },
        ],
      }),
    ).toThrow("zero or greater");
  });

  it("rejects a floor that is not less than the ceiling", () => {
    expect(
      createWith({
        rules: [
          {
            ...defaultRule,
            directive: {
              ...defaultRule.directive,
              floor: { mode: "absolute", amount: "50.00" },
              ceiling: { mode: "absolute", amount: "50.00" },
            },
          },
        ],
      }),
    ).toThrow("floor must be less than its ceiling");
  });

  it("rejects a cost-basis floor fallback that is not less than an absolute ceiling", () => {
    expect(
      createWith({
        rules: [
          {
            ...defaultRule,
            directive: {
              ...defaultRule.directive,
              floor: { mode: "cost-basis-plus-margin", marginPercent: 10, absoluteFallbackAmount: "100.00" },
              ceiling: { mode: "absolute", amount: "50.00" },
            },
          },
        ],
      }),
    ).toThrow("absolute fallback must be less than its ceiling");
  });

  it("rejects a negative tolerance percent", () => {
    expect(
      createWith({
        rules: [
          { ...defaultRule, directive: { ...defaultRule.directive, tolerance: { mode: "percent", percent: -1 } } },
        ],
      }),
    ).toThrow("zero or greater");
  });

  it("rejects a max move percent of zero", () => {
    expect(
      createWith({
        rules: [{ ...defaultRule, directive: { ...defaultRule.directive, maxMovePercent: 0 } }],
      }),
    ).toThrow("max move percent must be greater than zero");
  });

  it("rejects a max move percent above the cap", () => {
    expect(
      createWith({
        rules: [{ ...defaultRule, directive: { ...defaultRule.directive, maxMovePercent: 150 } }],
      }),
    ).toThrow("at most 100");
  });

  it("rejects a pause terminal with a blank reason", () => {
    expect(
      createWith({
        rules: [{ ...defaultRule, directive: { ...defaultRule.directive, terminal: { kind: "pause", reason: "  " } } }],
      }),
    ).toThrow("non-empty reason");
  });

  it("rejects a fallback-price terminal below the rule's floor", () => {
    expect(
      createWith({
        rules: [
          {
            ...defaultRule,
            directive: {
              ...defaultRule.directive,
              floor: { mode: "absolute", amount: "10.00" },
              terminal: { kind: "fallback-price", amount: "5.00" },
            },
          },
        ],
      }),
    ).toThrow("must not be below the rule's floor");
  });

  it("rejects an invalid schedule-window time format", () => {
    expect(
      createWith({
        rules: [
          {
            ...defaultRule,
            conditions: [{ type: "schedule-window", daysOfWeek: [1, 2], startTime: "9:00", endTime: "17:00" }],
          },
        ],
      }),
    ).toThrow("start time must be HH:MM");
  });

  it("rejects a catalog-filter scope with no categories", () => {
    expect(createWith({ scope: { kind: "catalog-filter", categoryIds: [] } })).toThrow("at least one entry");
  });

  it("rejects a listing-set scope with no listings", () => {
    expect(createWith({ scope: { kind: "listing-set", listingIds: [] } })).toThrow("at least one entry");
  });

  it("rejects a max-changes-per-day of zero", () => {
    expect(createWith({ maxChangesPerDay: 0 })).toThrow("whole number between");
  });

  it("rejects a max-changes-per-day above the cap", () => {
    expect(createWith({ maxChangesPerDay: 10_000 })).toThrow("whole number between");
  });

  it("deduplicates excluded listing ids", () => {
    const events = decideRepricingPolicy(initialRepricingPolicyState, {
      ...createCommand,
      excludedListingIds: ["lst_9", "lst_9", "lst_1"],
    });
    expect(events[0]?.data).toMatchObject({ excludedListingIds: ["lst_1", "lst_9"] });
  });
});
