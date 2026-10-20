// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { pricingGoalDefinitions } from "../../repricing-policies/domain/domain";
import { selectableGoalChoices } from "../api/goal-comparison";
import { GoalPicker } from "../ui/goal-comparison";

const adoption = (goalId: string, selectable: boolean, lifecycle: "selectable" | "shadow" | "retired" = "selectable") =>
  ({
    goalId,
    goalVersion: 1,
    lifecycle,
    incumbentVersion: null,
    selectable,
    promotable: selectable,
    reason: selectable ? null : "gate-refused",
    grades: null,
  }) as const;

describe("Pricing Health goal registry-driven surface", () => {
  it("renders only Adoption Gate-selectable registry versions and excludes shadow/retired/refused entries", () => {
    const goals = selectableGoalChoices(pricingGoalDefinitions(), [
      adoption("fixed-percentile", true),
      adoption("target-horizon", false),
      adoption("profit-per-day", false, "shadow"),
    ]);
    expect(goals.every(({ goalId }) => goalId === "fixed-percentile")).toBe(true);
    render(
      <MemoryRouter>
        <GoalPicker goals={goals} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Price at the 65th market percentile/)).toBeTruthy();
    expect(screen.queryByText(/Sell steadily/)).toBeNull();
  });

  it("renders validated editable controls and resolved Economics provenance", () => {
    const [goal] = selectableGoalChoices(pricingGoalDefinitions(), [adoption("profit-per-day", true)]);
    if (!goal) throw new Error("real registry did not expose the adopted goal");
    render(
      <MemoryRouter>
        <GoalPicker
          goals={[
            {
              ...goal,
              economics: {
                availability: "resolved",
                currency: "USD",
                effectiveAt: "2026-10-20T00:00:00.000Z",
                reason: null,
                facts: {
                  dailyReturnHurdle: {
                    effectiveValue: 0.01,
                    observedAt: "2026-10-19T00:00:00.000Z",
                    source: "policy-owned",
                    override: null,
                  },
                },
              },
            },
          ]}
        />
      </MemoryRouter>,
    );
    expect(document.querySelector('input[type="number"]')).toBeTruthy();
    expect(screen.getByText(/Policy-owned/)).toBeTruthy();
    expect(screen.getByText(/2026-10-19/)).toBeTruthy();
  });
});
