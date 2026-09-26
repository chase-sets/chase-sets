// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepricingActivityFilter, RepricingActivityRow } from "../../repricing-engine/api/activity";
import type { RepricingPolicyListingTrace } from "../../repricing-engine/domain/fact";
import { repricingActivityFilterOrder } from "./activity-copy";
import { PricingRepricingActivityPanel, type RepricingActivityPanelPage } from "./policy-activity-panel";

afterEach(cleanup);

function counts(overrides: Partial<Record<RepricingActivityFilter, number>> = {}) {
  return Object.fromEntries(
    repricingActivityFilterOrder.map((filter) => [filter, overrides[filter] ?? 0]),
  ) as Record<RepricingActivityFilter, number>;
}

function row(
  overrides: Partial<Omit<RepricingActivityRow, "trace">> & { trace?: Partial<RepricingPolicyListingTrace> } = {},
): RepricingActivityRow {
  const { trace, ...rest } = overrides;
  return {
    listingId: "lst_1",
    evaluationId: "eval_1",
    policyId: "rpp_1",
    productKey: { catalogItemId: "ci_1", productId: "prod_1" },
    evaluatedAt: "2026-09-26T12:00:00.000Z",
    floorBindingSince: null,
    frozenUntil: null,
    affectedListingCount: 0,
    ...rest,
    trace: {
      listingId: rest.listingId ?? "lst_1",
      currentPriceAmount: "10.00",
      targetPriceAmount: "9.50",
      ruleIndex: 0,
      anchor: { source: "lowest-competing-ask", amount: "9.60", stratum: "hard-ask", contributingListingCount: 3 },
      exhaustedAnchors: [],
      clamps: { floor: false, ceiling: false, maxMove: false },
      flags: [],
      outcome: "changed",
      skipReason: null,
      ...trace,
    },
  };
}

function page(overrides: Partial<RepricingActivityPanelPage> = {}): RepricingActivityPanelPage {
  return { rows: [row()], next: null, filterCounts: counts(), ...overrides };
}

function renderPanel(props: Partial<Parameters<typeof PricingRepricingActivityPanel>[0]> = {}) {
  const onFilterChange = vi.fn();
  const onNext = vi.fn();
  render(
    <PricingRepricingActivityPanel
      page={page()}
      selectedFilter={null}
      ruleCurrencies={["USD"]}
      onFilterChange={onFilterChange}
      onNext={onNext}
      {...props}
    />,
  );
  return { onFilterChange, onNext };
}

describe("PricingRepricingActivityPanel", () => {
  it("filter counts: renders each server filterCounts value beside its label, never recounting rows", () => {
    renderPanel({
      page: page({
        // One visible row, but the server says thousands: the label must show the server count.
        filterCounts: counts({ "floor-binding": 2341, "budget-exhausted": 12, "paused-for-missing-input": 7, changed: 1 }),
      }),
    });

    const filters = screen.getByRole("group", { name: "Filter activity" });
    expect(within(filters).getByRole("button", { name: "Floor-binding · 2,341" })).toBeTruthy();
    expect(within(filters).getByRole("button", { name: "Budget-exhausted · 12" })).toBeTruthy();
    expect(within(filters).getByRole("button", { name: "Paused for missing input · 7" })).toBeTruthy();
    expect(within(filters).getByRole("button", { name: "Spiral-breaker freezes · 0" })).toBeTruthy();
    // "All activity" plus one toggle per filter, in the API's order.
    expect(within(filters).getAllByRole("button")).toHaveLength(repricingActivityFilterOrder.length + 1);

    const always = screen.getByTestId("repricing-activity-counts");
    expect(always.textContent).toContain("Paused for missing input7");
    expect(always.textContent).toContain("Floor-binding2,341");
    expect(always.textContent).toContain("Budget-exhausted12");
  });

  it("keeps the always-visible counts at zero on an empty page", () => {
    renderPanel({ page: page({ rows: [] }) });

    expect(screen.getByTestId("repricing-activity-empty")).toBeTruthy();
    const always = screen.getByTestId("repricing-activity-counts");
    expect(always.textContent).toContain("Paused for missing input0");
    expect(always.textContent).toContain("Floor-binding0");
    expect(always.textContent).toContain("Budget-exhausted0");
  });

  it("selects and clears a filter through the toggle strip", () => {
    const { onFilterChange } = renderPanel({ page: page({ filterCounts: counts({ "floor-binding": 4 }) }) });
    fireEvent.click(screen.getByRole("button", { name: "Floor-binding · 4" }));
    expect(onFilterChange).toHaveBeenLastCalledWith("floor-binding");

    cleanup();
    const selected = renderPanel({ selectedFilter: "floor-binding", page: page({ filterCounts: counts({ "floor-binding": 4 }) }) });
    fireEvent.click(screen.getByRole("button", { name: "All activity" }));
    expect(selected.onFilterChange).toHaveBeenLastCalledWith(null);
  });

  it("renders the stratum wording, price move and clamp badges for each row", () => {
    renderPanel({
      page: page({
        rows: [
          row({ listingId: "lst_manual" }),
          row({
            listingId: "lst_band",
            evaluationId: "eval_2",
            trace: {
              anchor: { source: "lowest-competing-ask", amount: "8.00", stratum: "any-ask", contributingListingCount: 5 },
              flags: ["band-binding"],
              clamps: { floor: true, ceiling: false, maxMove: true },
            },
          }),
          row({
            listingId: "lst_estimate",
            evaluationId: "eval_3",
            trace: {
              anchor: { source: "market-estimate", amount: "11.00", stratum: "market-estimate", contributingListingCount: 0 },
              exhaustedAnchors: [{ source: "lowest-competing-ask", state: "absent" }],
              outcome: "skipped",
              skipReason: "budget-exhausted",
              targetPriceAmount: null,
            },
          }),
        ],
      }),
    });

    const table = screen.getByTestId("repricing-activity");
    const text = table.textContent ?? "";
    expect(text).toContain("Anchored to the lowest manual listing");
    expect(text).toContain("Anchored to the lowest listing of any kind, held at the band floor");
    expect(text).toContain("No manual listings — using the market estimate");
    expect(text).toContain("$10.00 → $9.50");
    expect(text).toContain("Budget-exhausted");
    expect(within(table).getAllByText("Floor").length).toBeGreaterThan(0);
    expect(within(table).getAllByText("Max move").length).toBeGreaterThan(0);
    expect(within(table).queryAllByText("Ceiling")).toEqual([]);
  });

  it("shows a spiral-breaker freeze as a distinct state with its affected count", () => {
    renderPanel({
      page: page({
        rows: [
          row({
            affectedListingCount: 1204,
            frozenUntil: "2026-09-27T12:00:00.000Z",
            trace: { outcome: "skipped", skipReason: "spiral-breaker-frozen", targetPriceAmount: null },
          }),
        ],
      }),
    });

    // DataTable renders each row as a table row and as a stacked mobile card.
    for (const frozen of screen.getAllByTestId("repricing-activity-frozen")) {
      expect(frozen.textContent).toBe("Frozen · 1,204 listings");
    }
    expect(screen.getByTestId("repricing-activity").textContent).toContain("Resumes ");
  });

  it("pages forward with the server cursor", () => {
    const { onNext } = renderPanel({ page: page({ next: "cursor_2" }) });
    fireEvent.click(screen.getByRole("button", { name: "Show more activity" }));
    expect(onNext).toHaveBeenCalledWith("cursor_2");
  });

  it("marks the table busy while loading and shows a danger banner when loading fails", () => {
    const loading = renderToStaticMarkup(
      <PricingRepricingActivityPanel
        page={page()}
        selectedFilter={null}
        ruleCurrencies={["USD"]}
        loading
        onFilterChange={() => undefined}
        onNext={() => undefined}
      />,
    );
    expect(loading).toContain('aria-busy="true"');

    renderPanel({ loadFailed: true });
    expect(screen.getByText("Activity couldn't load")).toBeTruthy();
    expect(screen.queryByTestId("repricing-activity")).toBeNull();
  });

  it("never renders competing listing identity or pricing mode for a derived-ask anchor", () => {
    // A trace as stored can carry more than the UI type declares. Plant the
    // identifying fields an anchor could leak and assert none reach the markup.
    const leakyTrace = {
      anchor: {
        source: "lowest-competing-ask",
        amount: "9.60",
        stratum: "any-ask",
        contributingListingCount: 4,
        competingListingId: "lst_competitor_secret",
        pricingMode: "derived",
        sellerAccountId: "acct_competitor_secret",
      },
      flags: ["band-binding"],
      competingListingIds: ["lst_competitor_other"],
    } as unknown as Partial<RepricingPolicyListingTrace>;
    const html = renderToStaticMarkup(
      <PricingRepricingActivityPanel
        page={page({ rows: [row({ trace: leakyTrace })] })}
        selectedFilter={null}
        ruleCurrencies={["USD"]}
        onFilterChange={() => undefined}
        onNext={() => undefined}
      />,
    );

    expect(html).toContain("Anchored to the lowest listing of any kind, held at the band floor");
    for (const leaked of ["lst_competitor_secret", "lst_competitor_other", "acct_competitor_secret", "derived", "algorithmic"]) {
      expect(html.toLowerCase()).not.toContain(leaked);
    }
  });
});
