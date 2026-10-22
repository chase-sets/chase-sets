// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpsDashboardAdminPage } from "./ops-dashboard-page";
import type { OpsRepricingSourceShare, OpsRepricingSourceShareWeek } from "../api/ops-contracts";
import type { OpsDashboardSummaryResponse } from "../api/ops-dashboard-client";

const week: OpsRepricingSourceShareWeek = {
  weekStart: "2026-10-04",
  status: "complete",
  reason: null,
  eventCount: 0,
  counts: { bulk: 0, policy: 0, manual: 0, unattributed: 0 },
  shares: { bulk: 0, policy: 0, manual: 0 },
  topSellers: [],
};
function render(report: OpsRepricingSourceShare) {
  const summary: OpsDashboardSummaryResponse = {
    from: "2026-10-04",
    to: "2026-10-10",
    summary: {
      gmvAmount: "0.00",
      tradeCount: 0,
      orderCount: 0,
      unitVolume: 0,
      verifiedTradeCount: 0,
      activeBuyerCount: 0,
      activeSellerCount: 0,
    },
    liquidity: { asOfDay: "2026-10-10", sellThroughRate: null, medianSpreadAmount: null, spreadSampleCount: 0 },
    topCatalogItems: [],
    repricingSourceShare: report,
  };
  return renderToStaticMarkup(
    <OpsDashboardAdminPage
      summary={summary}
      series={{ from: summary.from, to: summary.to, granularity: "weekly", series: [] }}
      reconciliationRuns={[]}
      filters={{ rangeDays: "7", granularity: "weekly" }}
    />,
  );
}
describe("ops source-share panel", () => {
  it("renders unavailable distinctly from zero", () => {
    const html = render({ status: "unavailable", weeks: [], reason: "port-unavailable" });
    expect(html).toContain("Source-share instrumentation is unavailable");
    expect(html).not.toContain("0.0% (0)");
  });
  it("renders complete zero-activity weeks", () => {
    const html = render({ status: "available", weeks: [week] });
    expect(html).toContain("No repricing activity");
    expect(html).toContain("0.0% (0)");
    expect(html).toContain(">Complete<");
  });
  it("renders incompleteness reasons, shares, top sellers and eligibility", () => {
    const html = render({
      status: "available",
      weeks: [
        {
          ...week,
          status: "incomplete",
          reason: "unattributed-event",
          eventCount: 2,
          counts: { bulk: 1, policy: 0, manual: 0, unattributed: 1 },
          shares: { bulk: 0.5, policy: 0, manual: 0 },
          topSellers: [{ accountId: "synthetic-seller", bulkShare: 1, bulkListingCount: 1 }],
        },
      ],
      decision: { status: "unknown", reasons: ["2026-10-04:incomplete"] },
    });
    for (const text of [
      ">Incomplete<",
      "Unattributed event",
      "Week 2026-10-04 is incomplete.",
      "50.0% (1)",
      "synthetic-seller",
      "Bulk sunset eligibility: Unknown",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("unattributed-event");
    expect(html).not.toContain("2026-10-04:incomplete");
  });
  it.each([
    ["policy-not-configured", "Sunset policy is not configured."],
    ["insufficient-weeks", "Not enough complete weeks are available."],
    ["nonconsecutive-or-stale-weeks", "The measured weeks are not consecutive or are stale."],
    ["2026-10-04:bulk-share-over-limit", "Week 2026-10-04 exceeds the allowed bulk share."],
    ["2026-10-04:bulk-reliance", "Week 2026-10-04 shows reliance on bulk repricing."],
  ])("localizes the decision reason %s", (reason, message) => {
    const html = render({ status: "available", weeks: [week], decision: { status: "ineligible", reasons: [reason] } });
    expect(html).toContain(message);
    expect(html).toContain("Bulk sunset eligibility: Ineligible");
    expect(html).not.toContain(reason);
  });
  it("localizes eligible status and checkpoint lag without raw tokens", () => {
    const html = render({
      status: "available",
      weeks: [{ ...week, status: "incomplete", reason: "checkpoint-lag" }],
      decision: { status: "eligible", reasons: [] },
    });
    expect(html).toContain("Bulk sunset eligibility: Eligible");
    expect(html).toContain("Checkpoint lag");
    expect(html).not.toContain("checkpoint-lag");
  });
});
