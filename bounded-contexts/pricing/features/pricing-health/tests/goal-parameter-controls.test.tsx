// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { pricingGoalDefinitions } from "../../repricing-policies/domain/domain";
import { GoalPicker } from "../ui/goal-comparison";
import { selectableGoalChoices, type GoalChoice } from "../api/goal-comparison";

afterEach(cleanup);

const goals = selectableGoalChoices(pricingGoalDefinitions(), [
  {
    goalId: "fixed-percentile",
    goalVersion: 1,
    lifecycle: "selectable",
    incumbentVersion: null,
    selectable: true,
    promotable: true,
    reason: null,
    grades: null,
  },
]);

function Harness() {
  const location = useLocation();
  return (
    <>
      <GoalPicker goals={goals} navigate={useNavigate()} />
      <output data-testid="location-search">{location.search}</output>
    </>
  );
}

describe("Pricing Health goal parameter controls", () => {
  it("starts collapsed, keeps invalid values out of the URL, and navigates valid edits", async () => {
    const user = userEvent.setup();
    const Stub = createRoutesStub([{ path: "/pricing-health", Component: Harness }]);
    window.history.replaceState({}, "", "/pricing-health?policyId=pol_synthetic");
    render(<Stub initialEntries={["/pricing-health?policyId=pol_synthetic"]} />);
    const disclosure = screen.getByRole("button", { name: "Advanced controls and provenance" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await user.click(disclosure);
    const input = screen.getByLabelText("Market percentile");
    fireEvent.change(input, { target: { value: "101" } });
    expect(screen.getByTestId("location-search").textContent).toBe("?policyId=pol_synthetic");
    expect(screen.getByText("Enter a value within the allowed range.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "70" } });
    await waitFor(() => expect(screen.getByTestId("location-search").textContent).toContain("goals="));
    const search = screen.getByTestId("location-search").textContent ?? "";
    expect(search).toContain("goals=");
    expect(decodeURIComponent(search)).toContain('"percentile":70');
  });

  it("gives every open same-titled goal disclosure a unique region name", async () => {
    cleanup();
    const user = userEvent.setup();
    const [goal] = goals;
    const sameTitledGoals = [1, 2, 3].map((goalVersion) => ({ ...goal!, goalVersion }));
    render(<GoalPicker goals={sameTitledGoals} />);

    const picker = screen.getByTestId("pricing-health-goal-picker");
    const disclosures = screen.getAllByRole("button", { name: "Advanced controls and provenance" });
    expect(disclosures.every((trigger) => trigger.getAttribute("aria-expanded") === "false")).toBe(true);
    for (const disclosure of disclosures) await user.click(disclosure);
    const regions = Array.from(picker.querySelectorAll('[role="region"]'));
    expect(regions).toHaveLength(disclosures.length);
    expect(new Set(regions.map((region) => region.getAttribute("aria-label"))).size).toBe(regions.length);
    expect(regions.every((region) => !region.getAttribute("aria-label")?.includes("fixed-percentile@"))).toBe(true);
    expect(disclosures.every((trigger) => trigger.getAttribute("aria-expanded") === "true")).toBe(true);
  });

  it("shows the localized unavailable reason and formats resolved Economics facts", () => {
    const economicsGoal: GoalChoice = {
      ...goals[0]!,
      goalId: "profit-per-day",
      requiresEconomics: true,
      economics: {
        availability: "unavailable",
        currency: "USD",
        effectiveAt: "2026-10-20T00:00:00.000Z",
        reason: "terms-unavailable",
        facts: {
          platformFeeRelativeBps: {
            effectiveValue: 1075,
            observedAt: "2026-10-20T00:00:00.000Z",
            source: "commercial-terms",
            sourceReason: null,
            override: { value: 1075, revision: 1, setAt: "2026-10-19T00:00:00.000Z" },
          },
          platformFeeCapPerUnitAmount: {
            effectiveValue: null,
            observedAt: "2026-10-20T00:00:00.000Z",
            source: "commercial-terms",
            sourceReason: null,
            override: null,
          },
          dailyReturnHurdle: {
            effectiveValue: 0.0125,
            observedAt: "2026-10-20T00:00:00.000Z",
            source: "policy-default",
            sourceReason: "provider-unavailable",
            override: null,
          },
          turnaroundDays: {
            effectiveValue: 14,
            observedAt: "2026-10-20T00:00:00.000Z",
            source: "pricing-observation",
            sourceReason: null,
            override: null,
          },
        },
      },
    };
    render(<GoalPicker goals={[economicsGoal]} />);
    expect(screen.getByText("Economics is unavailable for this scope: Terms unavailable")).toBeTruthy();
    expect(screen.getByText(/10\.75%/)).toBeTruthy();
    expect(screen.getByText(/1\.25%/)).toBeTruthy();
    expect(screen.getByText(/14/)).toBeTruthy();
    expect(screen.getByText(/Unavailable/)).toBeTruthy();
    expect(screen.getAllByText(/Overridden/)).toHaveLength(1);
    expect(screen.getByText(/Provider unavailable/)).toBeTruthy();
    expect(screen.queryByText(/null/)).toBeNull();
  });
});
