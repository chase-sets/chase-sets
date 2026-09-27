import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@chase-sets/localization";
import type { RepricingRuleCondition } from "../domain/domain";
import { dryRunBody } from "../../repricing-engine/tests/dry-run-fixture";
import { policyControls } from "./policy-controls";
import { newPolicyCondition, PolicyConditionFields, PolicyDirectiveFields } from "./policy-controls-fields";

describe("policy union control rendering", () => {
  it.each(Object.keys(policyControls.condition) as RepricingRuleCondition["type"][])(
    "renders the %s condition's actual control and copy",
    (type) => {
      const value = newPolicyCondition(type);
      const html = renderToStaticMarkup(
        <PolicyConditionFields
          value={value}
          categories={[{ id: "cat_a", name: "Trading cards" }]}
          onChange={() => undefined}
        />,
      );
      expect(html).toContain(t(policyControls.condition[type].copyKey));
      if (type === "schedule-window")
        for (const text of ["Sunday", "Saturday", "Start time (UTC)", "End time (UTC)"]) expect(html).toContain(text);
      if (type === "item-grading") expect(html).toContain('role="radiogroup"');
      if (type.endsWith("at-least")) expect(html).toContain('type="number"');
    },
  );
  it("renders the optional amount, reason, increment, percentile, margin and fallback inputs", () => {
    const html = renderToStaticMarkup(
      <PolicyDirectiveFields
        advanced
        value={{
          ...dryRunBody.rules[0]!.directive,
          anchorChain: [{ source: "comp-percentile", percentile: 75 }],
          offset: { mode: "absolute", amount: "-1" },
          floor: { mode: "cost-basis-plus-margin", marginPercent: 10, absoluteFallbackAmount: "4" },
          ceiling: { mode: "absolute", amount: "99" },
          tolerance: { mode: "absolute", amount: "1" },
          rounding: { mode: "increment", incrementAmount: "0.05" },
          terminal: { kind: "pause", reason: "No usable anchor" },
        }}
        onChange={() => undefined}
      />,
    );
    for (const label of [
      "Percentile (1-99)",
      "Adjustment amount",
      "Margin above cost (%)",
      "Minimum price when cost is unavailable",
      "Maximum price",
      "Tolerance amount",
      "Rounding increment",
      "Pause reason",
    ])
      expect(html).toContain(label);
  });
});
