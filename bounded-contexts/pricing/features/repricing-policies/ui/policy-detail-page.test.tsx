// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepricingActivityFilter } from "../../repricing-engine/api/activity";
import type { RepricingHaltState } from "../domain/halt";
import type { RepricingPolicyState, RepricingRule } from "../domain/domain";
import { repricingActivityFilterOrder } from "./activity-copy";
import { PricingRepricingPolicyDetailPage } from "./policy-detail-page";

afterEach(cleanup);

const released: RepricingHaltState = { engaged: false, engagedAt: null, releasedAt: null };

const rule = {
  conditions: [{ type: "item-grading", grading: "raw" }],
  directive: {
    currencyCode: "USD",
    anchorChain: [
      { source: "lowest-competing-ask", strata: "hard" },
      { source: "market-estimate" },
    ],
    offset: { mode: "percent", percent: -2 },
    floor: { mode: "absolute", amount: "1.00" },
    ceiling: null,
    tolerance: { mode: "absolute", amount: "0.05" },
    rounding: { mode: "charm" },
    maxMovePercent: 10,
    terminal: { kind: "hold" },
  },
} as unknown as RepricingRule;

const policy = {
  policyId: "rpp_1",
  accountId: "acc_1",
  name: "Undercut raw singles",
  scope: { kind: "listing-set", listingIds: ["lst_1", "lst_2", "lst_3"] },
  excludedListingIds: ["lst_9"],
  rules: [rule],
  maxChangesPerDay: 500,
  status: "active",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
} as RepricingPolicyState;

function renderDetail(props: Partial<Parameters<typeof PricingRepricingPolicyDetailPage>[0]> = {}) {
  const handlers = {
    onHaltChange: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onDelete: vi.fn(),
    onActivityFilterChange: vi.fn(),
    onActivityNext: vi.fn(),
  };
  render(
    <PricingRepricingPolicyDetailPage
      policy={policy}
      halt={released}
      changesUsedToday={42}
      activity={{
        rows: [],
        next: null,
        filterCounts: Object.fromEntries(repricingActivityFilterOrder.map((f) => [f, 0])) as Record<
          RepricingActivityFilter,
          number
        >,
      }}
      activityFilter={null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("PricingRepricingPolicyDetailPage", () => {
  it("renders the folded policy read-only with its budget row", () => {
    renderDetail();
    const settings = screen.getByTestId("repricing-policy-settings").textContent ?? "";
    expect(settings).toContain("Selected listings (3)");
    expect(settings).toContain("Excluded listings1");
    expect(settings).toContain("Daily change cap500");
    expect(settings).toContain("42 of 500 account-wide changes today");

    const rules = screen.getByTestId("repricing-policy-rules").textContent ?? "";
    expect(rules).toContain("Rule 1");
    expect(rules).toContain("-2%");
    expect(rules).toContain("$1.00");
    // Read-only: no form controls for the policy body.
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });

  it("reserves the header slot for the policy editor", () => {
    renderDetail({ editAction: <span data-testid="edit-slot">slot</span> });
    expect(screen.getByTestId("edit-slot")).toBeTruthy();
  });

  it("deletes only after confirmation", () => {
    const handlers = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "Delete policy" }));
    expect(handlers.onDelete).not.toHaveBeenCalled();
    const confirms = screen.getAllByRole("button", { name: "Delete policy" });
    fireEvent.click(confirms[confirms.length - 1]!);
    expect(handlers.onDelete).toHaveBeenCalledWith("rpp_1");
  });

  it("pauses in place and hides delete for a deleted policy", () => {
    const handlers = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(handlers.onPause).toHaveBeenCalledWith("rpp_1");

    cleanup();
    renderDetail({ policy: { ...policy, status: "deleted" } });
    expect(screen.queryByRole("button", { name: "Delete policy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("shows the activity counts even when there is no activity", () => {
    renderDetail();
    expect(screen.getByTestId("repricing-activity-empty")).toBeTruthy();
    expect(screen.getByTestId("repricing-activity-counts").textContent).toContain("Floor-binding0");
  });

  it("marks the settings busy while loading", () => {
    const html = renderToStaticMarkup(
      <PricingRepricingPolicyDetailPage
        policy={policy}
        halt={released}
        changesUsedToday={0}
        activity={null}
        activityFilter={null}
        loading
        onHaltChange={() => undefined}
        onPause={() => undefined}
        onResume={() => undefined}
        onDelete={() => undefined}
        onActivityFilterChange={() => undefined}
        onActivityNext={() => undefined}
      />,
    );
    expect(html).toMatch(/data-testid="repricing-policy-settings"[^>]*aria-busy="true"|aria-busy="true"[^>]*data-testid="repricing-policy-settings"/);
  });
});
