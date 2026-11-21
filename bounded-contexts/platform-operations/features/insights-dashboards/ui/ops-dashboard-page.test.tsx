// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OpsDashboardAdminPage } from "./ops-dashboard-page";

afterEach(cleanup);

const summary = {
  from: "2026-10-20T00:00:00.000Z",
  to: "2026-11-19T00:00:00.000Z",
  summary: {
    gmvAmount: "0.00",
    tradeCount: 0,
    orderCount: 0,
    unitVolume: 0,
    verifiedTradeCount: 0,
    activeBuyerCount: 0,
    activeSellerCount: 0,
  },
  liquidity: { asOfDay: "2026-11-19", sellThroughRate: null, medianSpreadAmount: null, spreadSampleCount: 0 },
  topCatalogItems: [],
};

describe("Ops Dashboard", () => {
  it("applies the chosen range and granularity with a submit in the range form", () => {
    render(
      <OpsDashboardAdminPage
        summary={summary}
        series={{ from: summary.from, to: summary.to, granularity: "weekly", series: [] }}
        reconciliationRuns={[]}
        filters={{ rangeDays: "90", granularity: "weekly" }}
      />,
    );

    const apply = screen.getByRole("button", { name: "Apply" });
    const form = apply.closest("form");
    expect(apply.getAttribute("type")).toBe("submit");
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("get");
    expect(form?.querySelector<HTMLSelectElement>('select[name="rangeDays"]')?.value).toBe("90");
    expect(form?.querySelector<HTMLSelectElement>('select[name="granularity"]')?.value).toBe("weekly");
  });
});
