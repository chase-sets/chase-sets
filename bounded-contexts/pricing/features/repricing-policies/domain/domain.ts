import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import { compareMoneyAmounts } from "@chase-sets/primitives/money";
import type { AccountId, RepricingPolicyId } from "@chase-sets/primitives/typed-ids";
import { worstCaseRepricingFloorAmount } from "./floor-resolution";
import {
  REPRICING_POLICY_ANCHOR_CHAIN_CAP,
  REPRICING_POLICY_COMP_PERCENTILE_MAX,
  REPRICING_POLICY_COMP_PERCENTILE_MIN,
  REPRICING_POLICY_MAX_CHANGES_PER_DAY_CAP,
  REPRICING_POLICY_MAX_MOVE_PERCENT_CAP,
  REPRICING_POLICY_MIN_CHANGES_PER_DAY,
  REPRICING_POLICY_PERCENT_MAGNITUDE_CAP,
  REPRICING_POLICY_RULE_CAP,
} from "./policy-bounds";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

function normalizeMoneyAmount(value: string, fieldName: string): string {
  const normalized = value.trim();
  assert(/^\d+(\.\d{1,2})?$/.test(normalized), `${fieldName} must be a valid decimal amount.`);
  assert(Number.parseFloat(normalized) > 0, `${fieldName} must be greater than zero.`);
  return normalized;
}

function normalizePercentMagnitude(value: number, fieldName: string, options: Readonly<{ min?: number }> = {}): number {
  assert(Number.isFinite(value), `${fieldName} must be a finite number.`);
  const min = options.min ?? -REPRICING_POLICY_PERCENT_MAGNITUDE_CAP;
  assert(
    value >= min && value <= REPRICING_POLICY_PERCENT_MAGNITUDE_CAP,
    `${fieldName} must be between ${min} and ${REPRICING_POLICY_PERCENT_MAGNITUDE_CAP}.`,
  );
  return value;
}

function normalizeNonEmptyIdList(values: readonly string[], fieldName: string): readonly string[] {
  const trimmed = values.map((value) => value.trim());
  assert(
    trimmed.every((value) => value.length > 0),
    `${fieldName} entries must not be blank.`,
  );
  const deduped = [...new Set(trimmed)].sort();
  assert(deduped.length > 0, `${fieldName} must include at least one entry.`);
  return deduped;
}

function normalizeIdList(values: readonly string[] | undefined, fieldName: string): readonly string[] {
  if (!values) {
    return [];
  }
  const trimmed = values.map((value) => value.trim());
  assert(
    trimmed.every((value) => value.length > 0),
    `${fieldName} entries must not be blank.`,
  );
  return [...new Set(trimmed)].sort();
}

// -- Scope -------------------------------------------------------------

export type RepricingPolicyScope =
  | Readonly<{ kind: "all-listings" }>
  | Readonly<{ kind: "catalog-filter"; categoryIds: readonly string[] }>
  | Readonly<{ kind: "listing-set"; listingIds: readonly string[] }>;

/**
 * "Most-specific wins" precedence ranking used to resolve overlapping scopes
 * across a seller's active policies. Reused by the read-model's assignment
 * resolution so the ranking is defined exactly once.
 */
export function repricingPolicyScopeSpecificity(scope: RepricingPolicyScope): 0 | 1 | 2 {
  switch (scope.kind) {
    case "all-listings":
      return 0;
    case "catalog-filter":
      return 1;
    case "listing-set":
      return 2;
    default:
      return assertNever(scope);
  }
}

function normalizeScope(scope: RepricingPolicyScope): RepricingPolicyScope {
  switch (scope.kind) {
    case "all-listings":
      return scope;
    case "catalog-filter":
      return {
        kind: "catalog-filter",
        categoryIds: normalizeNonEmptyIdList(scope.categoryIds, "Catalog filter category"),
      };
    case "listing-set":
      return { kind: "listing-set", listingIds: normalizeNonEmptyIdList(scope.listingIds, "Explicit listing set") };
    default:
      return assertNever(scope);
  }
}

// -- Rule pipeline vocabulary -------------------------------------------

export type RepricingAnchor =
  | Readonly<{ source: "market-estimate" }>
  | Readonly<{ source: "lowest-competing-ask" }>
  | Readonly<{ source: "comp-percentile"; percentile: number }>
  | Readonly<{ source: "last-sold" }>;

export type RepricingOffset =
  | Readonly<{ mode: "percent"; percent: number }>
  | Readonly<{ mode: "absolute"; amount: string }>;

export type RepricingFloor =
  | Readonly<{ mode: "absolute"; amount: string }>
  | Readonly<{ mode: "cost-basis-plus-margin"; marginPercent: number; absoluteFallbackAmount: string }>;

export type RepricingCeiling =
  | Readonly<{ mode: "absolute"; amount: string }>
  | Readonly<{ mode: "percent"; percent: number }>;

export type RepricingTolerance =
  | Readonly<{ mode: "percent"; percent: number }>
  | Readonly<{ mode: "absolute"; amount: string }>;

export type RepricingRounding =
  | Readonly<{ mode: "none" }>
  | Readonly<{ mode: "charm" }>
  | Readonly<{ mode: "increment"; incrementAmount: string }>;

export type RepricingTerminalBehavior =
  | Readonly<{ kind: "hold" }>
  | Readonly<{ kind: "pause"; reason: string }>
  | Readonly<{ kind: "fallback-price"; amount: string }>
  | Readonly<{ kind: "price-at-floor" }>
  | Readonly<{ kind: "notify-only" }>;

export type RepricingRuleCondition =
  | Readonly<{ type: "category"; categoryId: string }>
  | Readonly<{ type: "item-grading"; grading: "graded" | "raw" }>
  | Readonly<{ type: "quantity-at-least"; quantity: number }>
  | Readonly<{ type: "listing-age-at-least"; days: number }>
  | Readonly<{ type: "cost-basis-present" }>
  | Readonly<{ type: "cost-basis-absent" }>
  | Readonly<{ type: "competing-listing-count-at-least"; count: number }>
  | Readonly<{ type: "schedule-window"; daysOfWeek: readonly number[]; startTime: string; endTime: string }>;

export type RepricingRuleDirective = Readonly<{
  anchorChain: readonly RepricingAnchor[];
  offset: RepricingOffset;
  floor: RepricingFloor;
  ceiling: RepricingCeiling | null;
  tolerance: RepricingTolerance;
  rounding: RepricingRounding;
  maxMovePercent: number | null;
  terminal: RepricingTerminalBehavior;
}>;

/** Ordered, first-match-wins. A trailing rule with no conditions is the mandatory default. */
export type RepricingRule = Readonly<{
  conditions: readonly RepricingRuleCondition[];
  directive: RepricingRuleDirective;
}>;

function normalizeAnchorChain(anchorChain: readonly RepricingAnchor[]): readonly RepricingAnchor[] {
  assert(anchorChain.length > 0, "A rule's anchor chain must include at least one anchor.");
  assert(
    anchorChain.length <= REPRICING_POLICY_ANCHOR_CHAIN_CAP,
    `A rule's anchor chain cannot exceed ${REPRICING_POLICY_ANCHOR_CHAIN_CAP} anchors.`,
  );
  return anchorChain.map((anchor) => {
    if (anchor.source === "comp-percentile") {
      assert(
        Number.isFinite(anchor.percentile) &&
          anchor.percentile > REPRICING_POLICY_COMP_PERCENTILE_MIN - 1 &&
          anchor.percentile < REPRICING_POLICY_COMP_PERCENTILE_MAX + 1,
        `comp-percentile anchor percentile must be between ${REPRICING_POLICY_COMP_PERCENTILE_MIN} and ${REPRICING_POLICY_COMP_PERCENTILE_MAX}.`,
      );
      return { source: "comp-percentile", percentile: anchor.percentile };
    }
    return anchor;
  });
}

function normalizeOffset(offset: RepricingOffset): RepricingOffset {
  if (offset.mode === "percent") {
    return { mode: "percent", percent: normalizePercentMagnitude(offset.percent, "Offset percent") };
  }
  return { mode: "absolute", amount: normalizeSignedMoneyAmount(offset.amount, "Offset amount") };
}

function normalizeSignedMoneyAmount(value: string, fieldName: string): string {
  const normalized = value.trim();
  assert(/^-?\d+(\.\d{1,2})?$/.test(normalized), `${fieldName} must be a valid signed decimal amount.`);
  return normalized;
}

function normalizeFloor(floor: RepricingFloor): RepricingFloor {
  if (floor.mode === "absolute") {
    return { mode: "absolute", amount: normalizeMoneyAmount(floor.amount, "Floor amount") };
  }
  assert(
    Number.isFinite(floor.marginPercent) && floor.marginPercent >= 0,
    "Cost-basis floor margin percent must be zero or greater.",
  );
  assert(
    floor.marginPercent <= REPRICING_POLICY_PERCENT_MAGNITUDE_CAP,
    `Cost-basis floor margin percent must be at most ${REPRICING_POLICY_PERCENT_MAGNITUDE_CAP}.`,
  );
  return {
    mode: "cost-basis-plus-margin",
    marginPercent: floor.marginPercent,
    // Structural invariant for AC "missing cost basis -> absolute floor required for that anchor
    // mode": a cost-basis floor always carries the seller-authored fallback used whenever
    // Inventory has no acquisition_cost_amount fact for the item (see floor-resolution.ts).
    absoluteFallbackAmount: normalizeMoneyAmount(
      floor.absoluteFallbackAmount,
      "Cost-basis floor absolute fallback amount",
    ),
  };
}

function normalizeCeiling(ceiling: RepricingCeiling | null): RepricingCeiling | null {
  if (ceiling === null) {
    return null;
  }
  if (ceiling.mode === "absolute") {
    return { mode: "absolute", amount: normalizeMoneyAmount(ceiling.amount, "Ceiling amount") };
  }
  assert(Number.isFinite(ceiling.percent) && ceiling.percent > 0, "Ceiling percent must be greater than zero.");
  return { mode: "percent", percent: normalizePercentMagnitude(ceiling.percent, "Ceiling percent", { min: 0 }) };
}

function normalizeTolerance(tolerance: RepricingTolerance): RepricingTolerance {
  if (tolerance.mode === "percent") {
    assert(tolerance.percent >= 0, "Tolerance percent must be zero or greater.");
    return { mode: "percent", percent: normalizePercentMagnitude(tolerance.percent, "Tolerance percent", { min: 0 }) };
  }
  const normalized = tolerance.amount.trim();
  assert(/^\d+(\.\d{1,2})?$/.test(normalized), "Tolerance amount must be a valid non-negative decimal amount.");
  return { mode: "absolute", amount: normalized };
}

function normalizeRounding(rounding: RepricingRounding): RepricingRounding {
  if (rounding.mode !== "increment") {
    return rounding;
  }
  return {
    mode: "increment",
    incrementAmount: normalizeMoneyAmount(rounding.incrementAmount, "Rounding increment amount"),
  };
}

function normalizeTerminal(terminal: RepricingTerminalBehavior, floor: RepricingFloor): RepricingTerminalBehavior {
  switch (terminal.kind) {
    case "hold":
    case "price-at-floor":
    case "notify-only":
      return terminal;
    case "pause": {
      const reason = terminal.reason.trim();
      assert(reason.length > 0, "A pause terminal behavior requires a non-empty reason.");
      return { kind: "pause", reason };
    }
    case "fallback-price": {
      const amount = normalizeMoneyAmount(terminal.amount, "Terminal fallback price amount");
      // The floor is a HARD invariant; a terminal fallback price must never undercut it,
      // using the floor spec's worst-case (lowest possible) resolved amount.
      assert(
        compareMoneyAmounts(amount, worstCaseRepricingFloorAmount(floor)) >= 0,
        "Terminal fallback price amount must not be below the rule's floor.",
      );
      return { kind: "fallback-price", amount };
    }
    default:
      return assertNever(terminal);
  }
}

function normalizeCondition(condition: RepricingRuleCondition): RepricingRuleCondition {
  switch (condition.type) {
    case "category": {
      const categoryId = condition.categoryId.trim();
      assert(categoryId.length > 0, "A category condition requires a non-empty category id.");
      return { type: "category", categoryId };
    }
    case "item-grading":
      return condition;
    case "quantity-at-least":
      assert(
        Number.isInteger(condition.quantity) && condition.quantity > 0,
        "A quantity-at-least condition requires a positive whole number.",
      );
      return condition;
    case "listing-age-at-least":
      assert(
        Number.isInteger(condition.days) && condition.days > 0,
        "A listing-age-at-least condition requires a positive whole number of days.",
      );
      return condition;
    case "cost-basis-present":
    case "cost-basis-absent":
      return condition;
    case "competing-listing-count-at-least":
      assert(
        Number.isInteger(condition.count) && condition.count > 0,
        "A competing-listing-count-at-least condition requires a positive whole number.",
      );
      return condition;
    case "schedule-window": {
      assert(condition.daysOfWeek.length > 0, "A schedule-window condition requires at least one day of week.");
      assert(
        condition.daysOfWeek.every((day) => Number.isInteger(day) && day >= 0 && day <= 6),
        "A schedule-window condition's days of week must be integers between 0 (Sunday) and 6 (Saturday).",
      );
      const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
      assert(timePattern.test(condition.startTime), "A schedule-window condition's start time must be HH:MM.");
      assert(timePattern.test(condition.endTime), "A schedule-window condition's end time must be HH:MM.");
      return condition;
    }
    default:
      return assertNever(condition);
  }
}

function normalizeDirective(directive: RepricingRuleDirective): RepricingRuleDirective {
  const floor = normalizeFloor(directive.floor);
  const ceiling = normalizeCeiling(directive.ceiling);

  if (floor.mode === "absolute" && ceiling?.mode === "absolute") {
    assert(compareMoneyAmounts(floor.amount, ceiling.amount) < 0, "A rule's floor must be less than its ceiling.");
  } else if (floor.mode === "cost-basis-plus-margin" && ceiling?.mode === "absolute") {
    assert(
      compareMoneyAmounts(floor.absoluteFallbackAmount, ceiling.amount) < 0,
      "A rule's cost-basis floor's absolute fallback must be less than its ceiling.",
    );
  }

  const maxMovePercent = directive.maxMovePercent;
  if (maxMovePercent !== null) {
    assert(
      Number.isFinite(maxMovePercent) && maxMovePercent > 0 && maxMovePercent <= REPRICING_POLICY_MAX_MOVE_PERCENT_CAP,
      `A rule's max move percent must be greater than zero and at most ${REPRICING_POLICY_MAX_MOVE_PERCENT_CAP}.`,
    );
  }

  return {
    anchorChain: normalizeAnchorChain(directive.anchorChain),
    offset: normalizeOffset(directive.offset),
    floor,
    ceiling,
    tolerance: normalizeTolerance(directive.tolerance),
    rounding: normalizeRounding(directive.rounding),
    maxMovePercent,
    terminal: normalizeTerminal(directive.terminal, floor),
  };
}

function normalizeRules(rules: readonly RepricingRule[]): readonly RepricingRule[] {
  assert(rules.length > 0, "A repricing policy must define at least one rule.");
  assert(
    rules.length <= REPRICING_POLICY_RULE_CAP,
    `A repricing policy cannot define more than ${REPRICING_POLICY_RULE_CAP} rules.`,
  );

  const normalized = rules.map((rule) => ({
    conditions: rule.conditions.map(normalizeCondition),
    directive: normalizeDirective(rule.directive),
  }));

  normalized.forEach((rule, index) => {
    const isLast = index === normalized.length - 1;
    if (isLast) {
      assert(
        rule.conditions.length === 0,
        "The last rule in a repricing policy's pipeline must be the unconditional default rule.",
      );
    } else {
      assert(
        rule.conditions.length > 0,
        "Only the last rule in a repricing policy's pipeline may be unconditional (the default rule).",
      );
    }
  });

  return normalized;
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  assert(normalized.length > 0, "Repricing policy name must not be blank.");
  return normalized;
}

function normalizeMaxChangesPerDay(maxChangesPerDay: number): number {
  assert(
    Number.isInteger(maxChangesPerDay) &&
      maxChangesPerDay >= REPRICING_POLICY_MIN_CHANGES_PER_DAY &&
      maxChangesPerDay <= REPRICING_POLICY_MAX_CHANGES_PER_DAY_CAP,
    `Max changes per day must be a whole number between ${REPRICING_POLICY_MIN_CHANGES_PER_DAY} and ${REPRICING_POLICY_MAX_CHANGES_PER_DAY_CAP}.`,
  );
  return maxChangesPerDay;
}

// -- Aggregate state ------------------------------------------------------

export type RepricingPolicyStatus = "active" | "paused" | "deleted";

export type RepricingPolicyState = Readonly<{
  policyId: RepricingPolicyId | null;
  accountId: AccountId | null;
  name: string | null;
  scope: RepricingPolicyScope | null;
  excludedListingIds: readonly string[];
  rules: readonly RepricingRule[];
  maxChangesPerDay: number | null;
  status: RepricingPolicyStatus;
  createdAt: string | null;
  updatedAt: string | null;
}>;

export const initialRepricingPolicyState: RepricingPolicyState = {
  policyId: null,
  accountId: null,
  name: null,
  scope: null,
  excludedListingIds: [],
  rules: [],
  maxChangesPerDay: null,
  status: "active",
  createdAt: null,
  updatedAt: null,
};

type RepricingPolicyBodyFields = Readonly<{
  name: string;
  scope: RepricingPolicyScope;
  excludedListingIds: readonly string[];
  rules: readonly RepricingRule[];
  maxChangesPerDay: number;
}>;

function isPolicyBodyUnchanged(state: RepricingPolicyState, next: RepricingPolicyBodyFields): boolean {
  return (
    state.name === next.name &&
    state.maxChangesPerDay === next.maxChangesPerDay &&
    JSON.stringify(state.scope) === JSON.stringify(next.scope) &&
    JSON.stringify(state.excludedListingIds) === JSON.stringify(next.excludedListingIds) &&
    JSON.stringify(state.rules) === JSON.stringify(next.rules)
  );
}

// -- Commands ---------------------------------------------------------

export type CreateRepricingPolicyCommand = Readonly<{
  type: "CreateRepricingPolicy";
  policyId: RepricingPolicyId;
  accountId: AccountId;
  name: string;
  scope: RepricingPolicyScope;
  excludedListingIds?: readonly string[];
  rules: readonly RepricingRule[];
  maxChangesPerDay: number;
  createdAt: string;
}>;

export type ReviseRepricingPolicyCommand = Readonly<{
  type: "ReviseRepricingPolicy";
  name: string;
  scope: RepricingPolicyScope;
  excludedListingIds?: readonly string[];
  rules: readonly RepricingRule[];
  maxChangesPerDay: number;
  revisedAt: string;
}>;

export type PauseRepricingPolicyCommand = Readonly<{ type: "PauseRepricingPolicy"; pausedAt: string }>;
export type ResumeRepricingPolicyCommand = Readonly<{ type: "ResumeRepricingPolicy"; resumedAt: string }>;
export type DeleteRepricingPolicyCommand = Readonly<{ type: "DeleteRepricingPolicy"; deletedAt: string }>;

export type RepricingPolicyCommand =
  | CreateRepricingPolicyCommand
  | ReviseRepricingPolicyCommand
  | PauseRepricingPolicyCommand
  | ResumeRepricingPolicyCommand
  | DeleteRepricingPolicyCommand;

// -- Events -------------------------------------------------------------

export type RepricingPolicyCreatedEvent = DomainEvent<
  "pricing.repricing-policy.created",
  Readonly<{
    policyId: RepricingPolicyId;
    accountId: AccountId;
    name: string;
    scope: RepricingPolicyScope;
    excludedListingIds: readonly string[];
    rules: readonly RepricingRule[];
    maxChangesPerDay: number;
    createdAt: string;
  }>
>;

export type RepricingPolicyRevisedEvent = DomainEvent<
  "pricing.repricing-policy.revised",
  Readonly<{
    name: string;
    scope: RepricingPolicyScope;
    excludedListingIds: readonly string[];
    rules: readonly RepricingRule[];
    maxChangesPerDay: number;
    revisedAt: string;
  }>
>;

export type RepricingPolicyPausedEvent = DomainEvent<"pricing.repricing-policy.paused", Readonly<{ pausedAt: string }>>;
export type RepricingPolicyResumedEvent = DomainEvent<
  "pricing.repricing-policy.resumed",
  Readonly<{ resumedAt: string }>
>;
export type RepricingPolicyDeletedEvent = DomainEvent<
  "pricing.repricing-policy.deleted",
  Readonly<{ deletedAt: string }>
>;

export type RepricingPolicyEvent =
  | RepricingPolicyCreatedEvent
  | RepricingPolicyRevisedEvent
  | RepricingPolicyPausedEvent
  | RepricingPolicyResumedEvent
  | RepricingPolicyDeletedEvent;

// -- decide / evolve ------------------------------------------------------

export const decideRepricingPolicy: AggregateDecider<
  RepricingPolicyState,
  RepricingPolicyCommand,
  RepricingPolicyEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateRepricingPolicy": {
      assert(state.policyId === null, "Repricing policy has already been created.");
      const rules = normalizeRules(command.rules);
      return [
        {
          type: "pricing.repricing-policy.created",
          data: {
            policyId: command.policyId,
            accountId: command.accountId,
            name: normalizeName(command.name),
            scope: normalizeScope(command.scope),
            excludedListingIds: normalizeIdList(command.excludedListingIds, "Excluded listing id"),
            rules,
            maxChangesPerDay: normalizeMaxChangesPerDay(command.maxChangesPerDay),
            createdAt: command.createdAt,
          },
        },
      ];
    }
    case "ReviseRepricingPolicy": {
      assert(state.policyId !== null, "Repricing policy has not been created.");
      assert(state.status !== "deleted", "A deleted repricing policy cannot be revised.");
      const next: RepricingPolicyBodyFields = {
        name: normalizeName(command.name),
        scope: normalizeScope(command.scope),
        excludedListingIds: normalizeIdList(command.excludedListingIds, "Excluded listing id"),
        rules: normalizeRules(command.rules),
        maxChangesPerDay: normalizeMaxChangesPerDay(command.maxChangesPerDay),
      };
      if (isPolicyBodyUnchanged(state, next)) {
        return [];
      }
      return [
        {
          type: "pricing.repricing-policy.revised",
          data: { ...next, revisedAt: command.revisedAt },
        },
      ];
    }
    case "PauseRepricingPolicy": {
      assert(state.policyId !== null, "Repricing policy has not been created.");
      assert(state.status !== "deleted", "A deleted repricing policy cannot be paused.");
      if (state.status === "paused") {
        return [];
      }
      return [{ type: "pricing.repricing-policy.paused", data: { pausedAt: command.pausedAt } }];
    }
    case "ResumeRepricingPolicy": {
      assert(state.policyId !== null, "Repricing policy has not been created.");
      assert(state.status !== "deleted", "A deleted repricing policy cannot be resumed.");
      if (state.status === "active") {
        return [];
      }
      return [{ type: "pricing.repricing-policy.resumed", data: { resumedAt: command.resumedAt } }];
    }
    case "DeleteRepricingPolicy": {
      assert(state.policyId !== null, "Repricing policy has not been created.");
      if (state.status === "deleted") {
        return [];
      }
      return [{ type: "pricing.repricing-policy.deleted", data: { deletedAt: command.deletedAt } }];
    }
    default:
      return assertNever(command);
  }
};

export const evolveRepricingPolicy: AggregateEvolver<RepricingPolicyState, RepricingPolicyEvent> = (state, event) => {
  switch (event.type) {
    case "pricing.repricing-policy.created":
      return {
        ...state,
        policyId: event.data.policyId,
        accountId: event.data.accountId,
        name: event.data.name,
        scope: event.data.scope,
        excludedListingIds: event.data.excludedListingIds,
        rules: event.data.rules,
        maxChangesPerDay: event.data.maxChangesPerDay,
        status: "active",
        createdAt: event.data.createdAt,
        updatedAt: event.data.createdAt,
      };
    case "pricing.repricing-policy.revised":
      return {
        ...state,
        name: event.data.name,
        scope: event.data.scope,
        excludedListingIds: event.data.excludedListingIds,
        rules: event.data.rules,
        maxChangesPerDay: event.data.maxChangesPerDay,
        updatedAt: event.data.revisedAt,
      };
    case "pricing.repricing-policy.paused":
      return { ...state, status: "paused", updatedAt: event.data.pausedAt };
    case "pricing.repricing-policy.resumed":
      return { ...state, status: "active", updatedAt: event.data.resumedAt };
    case "pricing.repricing-policy.deleted":
      return { ...state, status: "deleted", updatedAt: event.data.deletedAt };
    default:
      return assertNever(event);
  }
};
