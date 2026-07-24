import { describe, expect, it } from "vitest";
import { partitionAxeViolations, type AxeViolation } from "./accessibility";

describe("partitionAxeViolations", () => {
  it("does not mask a violation that shares a rule id with an exclusion but has an unrelated node target", () => {
    const violations: AxeViolation[] = [
      {
        id: "label",
        nodes: [{ target: ["#facet-min-price"] }, { target: ["#unrelated-new-field"] }],
      },
    ];

    const { unexpectedViolations, staleExclusions } = partitionAxeViolations(violations, [
      { ruleId: "label", targets: ["#facet-min-price"], reason: "declared DS exclusion" },
    ]);

    expect(unexpectedViolations).toEqual(violations);
    expect(staleExclusions).toHaveLength(1);
  });

  it("reports a stale exclusion when no violation matches its rule id and targets", () => {
    const { unexpectedViolations, staleExclusions } = partitionAxeViolations(
      [],
      [{ ruleId: "heading-order", targets: ["h3.result-title"], reason: "no longer produced" }],
    );

    expect(unexpectedViolations).toEqual([]);
    expect(staleExclusions).toEqual([
      { ruleId: "heading-order", targets: ["h3.result-title"], reason: "no longer produced" },
    ]);
  });

  it("masks a violation whose rule id and exact node target set match a declared exclusion", () => {
    const violations: AxeViolation[] = [
      {
        id: "landmark-unique",
        nodes: [{ target: ["#facet-categories"] }, { target: ["#facet-tags"] }],
      },
    ];

    const { unexpectedViolations, staleExclusions } = partitionAxeViolations(violations, [
      {
        ruleId: "landmark-unique",
        targets: ["#facet-categories", "#facet-tags"],
        reason: "Facet accordion regions share an accessible name",
      },
    ]);

    expect(unexpectedViolations).toEqual([]);
    expect(staleExclusions).toEqual([]);
  });
});
