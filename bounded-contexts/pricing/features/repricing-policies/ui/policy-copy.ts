// Read-only wording for a folded repricing policy: status, scope, budget and
// each rule's directive. Every switch is exhaustive over the domain union, so a
// new scope, anchor, floor, ceiling, tolerance, rounding, terminal behavior or
// condition fails to compile until it has copy here.

import { formatMoney, t } from "@chase-sets/localization";
import type {
  RepricingAnchor,
  RepricingCeiling,
  RepricingFloor,
  RepricingOffset,
  RepricingPolicyScope,
  RepricingPolicyState,
  RepricingRounding,
  RepricingRule,
  RepricingRuleCondition,
  RepricingTerminalBehavior,
  RepricingTolerance,
} from "../domain/domain";

type BadgeTone = "success" | "warning" | "neutral";

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

export function formatRepricingCount(count: number): string {
  return COUNT_FORMAT.format(count);
}

// Directive amounts carry the rule's currency; a historical rule without one
// shows the bare amount rather than guessing a currency.
export function formatRepricingMoney(amount: string, currencyCode: string | null | undefined): string {
  return currencyCode ? formatMoney(amount, currencyCode) : amount;
}

// A halt stops every active policy without changing its stored status, so an
// active policy reads "Paused by halt" while the halt is engaged.
export function repricingStatusBadge(
  status: RepricingPolicyState["status"],
  haltEngaged: boolean,
): { label: string; tone: BadgeTone } {
  switch (status) {
    case "active":
      return haltEngaged
        ? { label: t("pricing.features.repricingPolicies.ui.shared.status.haltPaused"), tone: "warning" }
        : { label: t("pricing.features.repricingPolicies.ui.shared.status.active"), tone: "success" };
    case "paused":
      return { label: t("pricing.features.repricingPolicies.ui.shared.status.paused"), tone: "neutral" };
    case "deleted":
      return { label: t("pricing.features.repricingPolicies.ui.shared.status.deleted"), tone: "neutral" };
  }
}

export function repricingScopeLabel(scope: RepricingPolicyScope | null): string {
  if (!scope) return t("pricing.features.repricingPolicies.ui.shared.scope.allListings");
  switch (scope.kind) {
    case "all-listings":
      return t("pricing.features.repricingPolicies.ui.shared.scope.allListings");
    case "catalog-filter":
      return t("pricing.features.repricingPolicies.ui.shared.scope.catalogFilter", {
        count: formatRepricingCount(scope.categoryIds.length),
      });
    case "listing-set":
      return t("pricing.features.repricingPolicies.ui.shared.scope.listingSet", {
        count: formatRepricingCount(scope.listingIds.length),
      });
  }
}

export function repricingBudgetLabel(changesUsed: number, maxChangesPerDay: number | null): string {
  return maxChangesPerDay === null
    ? t("pricing.features.repricingPolicies.ui.shared.budget.uncapped", { used: formatRepricingCount(changesUsed) })
    : t("pricing.features.repricingPolicies.ui.shared.budget.capped", {
        used: formatRepricingCount(changesUsed),
        cap: formatRepricingCount(maxChangesPerDay),
      });
}

function conditionLabel(condition: RepricingRuleCondition): string {
  switch (condition.type) {
    case "category":
      return t("pricing.features.repricingPolicies.ui.policyBody.condition.category", {
        categoryId: condition.categoryId,
      });
    case "item-grading":
      return condition.grading === "graded"
        ? t("pricing.features.repricingPolicies.ui.policyBody.condition.graded")
        : t("pricing.features.repricingPolicies.ui.policyBody.condition.raw");
    case "quantity-at-least":
      return t("pricing.features.repricingPolicies.ui.policyBody.condition.quantityAtLeast", {
        quantity: condition.quantity,
      });
    case "listing-age-at-least":
      return t("pricing.features.repricingPolicies.ui.policyBody.condition.listingAgeAtLeast", {
        days: condition.days,
      });
    case "cost-basis-present":
      return t("pricing.features.repricingPolicies.ui.policyBody.condition.costBasisPresent");
    case "cost-basis-absent":
      return t("pricing.features.repricingPolicies.ui.policyBody.condition.costBasisAbsent");
    case "competing-listing-count-at-least":
      return t("pricing.features.repricingPolicies.ui.policyBody.condition.competingListingCountAtLeast", {
        count: condition.count,
      });
    case "schedule-window":
      return t("pricing.features.repricingPolicies.ui.policyBody.condition.scheduleWindow", {
        startTime: condition.startTime,
        endTime: condition.endTime,
        dayCount: condition.daysOfWeek.length,
      });
  }
}

function anchorLabel(anchor: RepricingAnchor): string {
  switch (anchor.source) {
    case "market-estimate":
      return t("pricing.features.repricingPolicies.ui.policyBody.anchor.marketEstimate");
    case "lowest-competing-ask":
      return anchor.strata === "any"
        ? t("pricing.features.repricingPolicies.ui.policyBody.anchor.lowestAnyListing", {
            percent: anchor.band.minPercentOfGround,
          })
        : t("pricing.features.repricingPolicies.ui.policyBody.anchor.lowestManualListing");
    case "comp-percentile":
      return t("pricing.features.repricingPolicies.ui.policyBody.anchor.compPercentile", {
        percentile: anchor.percentile,
      });
    case "last-sold":
      return t("pricing.features.repricingPolicies.ui.policyBody.anchor.lastSold");
  }
}

function anchorChainLabel(chain: readonly RepricingAnchor[]): string {
  if (chain.length === 0) return t("pricing.features.repricingPolicies.ui.activity.anchor.none");
  return chain
    .map(anchorLabel)
    .reduceRight((rest, first) => t("pricing.features.repricingPolicies.ui.policyBody.anchor.then", { first, rest }));
}

function signedPercent(percent: number): string {
  return percent > 0 ? `+${percent}` : String(percent);
}

function offsetLabel(offset: RepricingOffset, currency: string | null | undefined): string {
  switch (offset.mode) {
    case "percent":
      return t("pricing.features.repricingPolicies.ui.policyBody.offset.percent", {
        percent: signedPercent(offset.percent),
      });
    case "absolute":
      return t("pricing.features.repricingPolicies.ui.policyBody.offset.absolute", {
        amount: formatRepricingMoney(offset.amount, currency),
      });
  }
}

function floorLabel(floor: RepricingFloor, currency: string | null | undefined): string {
  switch (floor.mode) {
    case "absolute":
      return formatRepricingMoney(floor.amount, currency);
    case "cost-basis-plus-margin":
      return t("pricing.features.repricingPolicies.ui.policyBody.floor.costBasisPlusMargin", {
        percent: floor.marginPercent,
        amount: formatRepricingMoney(floor.absoluteFallbackAmount, currency),
      });
  }
}

function ceilingLabel(ceiling: RepricingCeiling | null, currency: string | null | undefined): string {
  if (ceiling === null) return t("pricing.features.repricingPolicies.ui.policyBody.ceiling.none");
  switch (ceiling.mode) {
    case "absolute":
      return formatRepricingMoney(ceiling.amount, currency);
    case "percent":
      return t("pricing.features.repricingPolicies.ui.policyBody.ceiling.percent", { percent: ceiling.percent });
  }
}

function toleranceLabel(tolerance: RepricingTolerance, currency: string | null | undefined): string {
  switch (tolerance.mode) {
    case "percent":
      return t("pricing.features.repricingPolicies.ui.policyBody.tolerance.percent", { percent: tolerance.percent });
    case "absolute":
      return t("pricing.features.repricingPolicies.ui.policyBody.tolerance.absolute", {
        amount: formatRepricingMoney(tolerance.amount, currency),
      });
  }
}

function roundingLabel(rounding: RepricingRounding, currency: string | null | undefined): string {
  switch (rounding.mode) {
    case "none":
      return t("pricing.features.repricingPolicies.ui.policyBody.rounding.none");
    case "charm":
      return t("pricing.features.repricingPolicies.ui.policyBody.rounding.charm");
    case "increment":
      return t("pricing.features.repricingPolicies.ui.policyBody.rounding.increment", {
        amount: formatRepricingMoney(rounding.incrementAmount, currency),
      });
  }
}

// The pause reason is seller-authored free text and stays out of the summary.
function terminalLabel(terminal: RepricingTerminalBehavior, currency: string | null | undefined): string {
  switch (terminal.kind) {
    case "hold":
      return t("pricing.features.repricingPolicies.ui.policyBody.terminal.hold");
    case "pause":
      return t("pricing.features.repricingPolicies.ui.policyBody.terminal.pause");
    case "fallback-price":
      return t("pricing.features.repricingPolicies.ui.policyBody.terminal.fallbackPrice", {
        amount: formatRepricingMoney(terminal.amount, currency),
      });
    case "price-at-floor":
      return t("pricing.features.repricingPolicies.ui.policyBody.terminal.priceAtFloor");
    case "notify-only":
      return t("pricing.features.repricingPolicies.ui.policyBody.terminal.notifyOnly");
  }
}

export type RepricingRuleSummary = Readonly<{
  title: string;
  items: readonly Readonly<{ key: string; value: string }>[];
}>;

export function summarizeRepricingRule(rule: RepricingRule, index: number): RepricingRuleSummary {
  const { directive } = rule;
  const currency = directive.currencyCode;
  return {
    title: t("pricing.features.repricingPolicies.ui.policyBody.rule", { index: index + 1 }),
    items: [
      {
        key: t("pricing.features.repricingPolicies.ui.policyBody.rule.when"),
        value:
          rule.conditions.length === 0
            ? t("pricing.features.repricingPolicies.ui.policyBody.condition.none")
            : rule.conditions.map(conditionLabel).join(" · "),
      },
      { key: t("pricing.features.repricingPolicies.ui.policyBody.rule.anchor"), value: anchorChainLabel(directive.anchorChain) },
      { key: t("pricing.features.repricingPolicies.ui.policyBody.rule.offset"), value: offsetLabel(directive.offset, currency) },
      { key: t("pricing.features.repricingPolicies.ui.policyBody.rule.floor"), value: floorLabel(directive.floor, currency) },
      {
        key: t("pricing.features.repricingPolicies.ui.policyBody.rule.ceiling"),
        value: ceilingLabel(directive.ceiling, currency),
      },
      {
        key: t("pricing.features.repricingPolicies.ui.policyBody.rule.tolerance"),
        value: toleranceLabel(directive.tolerance, currency),
      },
      {
        key: t("pricing.features.repricingPolicies.ui.policyBody.rule.rounding"),
        value: roundingLabel(directive.rounding, currency),
      },
      {
        key: t("pricing.features.repricingPolicies.ui.policyBody.rule.maxMove"),
        value:
          directive.maxMovePercent === null
            ? t("pricing.features.repricingPolicies.ui.policyBody.maxMove.none")
            : t("pricing.features.repricingPolicies.ui.policyBody.maxMove.percent", {
                percent: directive.maxMovePercent,
              }),
      },
      {
        key: t("pricing.features.repricingPolicies.ui.policyBody.rule.terminal"),
        value: terminalLabel(directive.terminal, currency),
      },
    ],
  };
}
