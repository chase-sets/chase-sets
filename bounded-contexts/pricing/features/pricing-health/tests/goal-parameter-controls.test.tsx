// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation, useNavigate } from "react-router";
import { describe, expect, it } from "vitest";
import { pricingGoalDefinitions } from "../../repricing-policies/domain/domain";
import { GoalPicker } from "../ui/goal-comparison";
import { selectableGoalChoices } from "../api/goal-comparison";

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
    const search = screen.getByTestId("location-search").textContent ?? "";
    expect(search).toContain("goals=");
    expect(decodeURIComponent(search)).toContain('"percentile":70');
  });
});
