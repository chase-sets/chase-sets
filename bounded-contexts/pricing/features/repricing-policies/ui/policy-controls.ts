import type {
  RepricingAnchor,
  RepricingCeiling,
  RepricingFloor,
  RepricingOffset,
  RepricingPolicyScope,
  RepricingRounding,
  RepricingRuleCondition,
  RepricingTerminalBehavior,
  RepricingTolerance,
} from "../domain/domain";

type Option = Readonly<{ copyKey: string; control: string }>;
export const policyControls = {
  scope: {
    "all-listings": { copyKey: "pricing.features.repricingPolicies.ui.editor.scope.all", control: "select" },
    "catalog-filter": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.scope.categories",
      control: "checkbox-group",
    },
    "listing-set": { copyKey: "pricing.features.repricingPolicies.ui.editor.scope.listings", control: "text-input" },
  } satisfies Record<RepricingPolicyScope["kind"], Option>,
  condition: {
    category: {
      copyKey: "pricing.features.repricingPolicies.ui.editor.condition.category",
      control: "category-select",
    },
    "item-grading": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.condition.grading",
      control: "segmented-control",
    },
    "quantity-at-least": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.condition.quantity",
      control: "number-input",
    },
    "listing-age-at-least": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.condition.age",
      control: "number-input",
    },
    "cost-basis-present": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.condition.costPresent",
      control: "toggle-pair",
    },
    "cost-basis-absent": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.condition.costAbsent",
      control: "toggle-pair",
    },
    "competing-listing-count-at-least": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.condition.count",
      control: "number-input",
    },
    "schedule-window": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.condition.schedule",
      control: "weekdays-times",
    },
  } satisfies Record<RepricingRuleCondition["type"], Option>,
  anchor: {
    "market-estimate": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.anchor.market",
      control: "chain-picker",
    },
    "lowest-competing-ask": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.anchor.lowest",
      control: "chain-picker-band",
    },
    "comp-percentile": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.anchor.percentile",
      control: "percentile-input",
    },
    "last-sold": { copyKey: "pricing.features.repricingPolicies.ui.editor.anchor.lastSold", control: "chain-picker" },
  } satisfies Record<RepricingAnchor["source"], Option>,
  offset: {
    percent: { copyKey: "pricing.features.repricingPolicies.ui.editor.mode.percent", control: "percent-input" },
    absolute: { copyKey: "pricing.features.repricingPolicies.ui.editor.mode.absolute", control: "amount-input" },
  } satisfies Record<RepricingOffset["mode"], Option>,
  floor: {
    absolute: { copyKey: "pricing.features.repricingPolicies.ui.editor.floor.absolute", control: "amount-input" },
    "cost-basis-plus-margin": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.floor.cost",
      control: "margin-fallback",
    },
  } satisfies Record<RepricingFloor["mode"], Option>,
  ceiling: {
    none: { copyKey: "pricing.features.repricingPolicies.ui.editor.mode.none", control: "none" },
    percent: { copyKey: "pricing.features.repricingPolicies.ui.editor.mode.percent", control: "percent-input" },
    absolute: { copyKey: "pricing.features.repricingPolicies.ui.editor.mode.absolute", control: "amount-input" },
  } satisfies Record<RepricingCeiling["mode"] | "none", Option>,
  tolerance: {
    percent: { copyKey: "pricing.features.repricingPolicies.ui.editor.mode.percent", control: "percent-input" },
    absolute: { copyKey: "pricing.features.repricingPolicies.ui.editor.mode.absolute", control: "amount-input" },
  } satisfies Record<RepricingTolerance["mode"], Option>,
  rounding: {
    none: { copyKey: "pricing.features.repricingPolicies.ui.editor.rounding.none", control: "select" },
    charm: { copyKey: "pricing.features.repricingPolicies.ui.editor.rounding.charm", control: "select" },
    increment: {
      copyKey: "pricing.features.repricingPolicies.ui.editor.rounding.increment",
      control: "increment-input",
    },
  } satisfies Record<RepricingRounding["mode"], Option>,
  terminal: {
    hold: { copyKey: "pricing.features.repricingPolicies.ui.editor.terminal.hold", control: "select" },
    pause: { copyKey: "pricing.features.repricingPolicies.ui.editor.terminal.pause", control: "reason-input" },
    "fallback-price": {
      copyKey: "pricing.features.repricingPolicies.ui.editor.terminal.fallback",
      control: "amount-input",
    },
    "price-at-floor": { copyKey: "pricing.features.repricingPolicies.ui.editor.terminal.floor", control: "select" },
    "notify-only": { copyKey: "pricing.features.repricingPolicies.ui.editor.terminal.notify", control: "select" },
  } satisfies Record<RepricingTerminalBehavior["kind"], Option>,
} as const;
