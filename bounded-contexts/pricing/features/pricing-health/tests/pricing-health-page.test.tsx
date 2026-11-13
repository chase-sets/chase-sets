import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatDateTime, formatMoney } from "@chase-sets/localization";
import { PricingHealthPage } from "../ui/page";
import { summarizeHealth } from "../../repricing-engine/api/health-summary";
import type { PricingHealthData } from "../api/services";
import { healthNumber } from "../ui/copy";

const health = summarizeHealth(
  [
    {
      listingId: "synthetic-usd",
      quantity: 2,
      currentPriceAmount: "10.00",
      effectivePriceAmount: "12.00",
      currencyCode: "USD",
      modeled: {
        medianDays: 7,
        curveVersion: 1,
        builtAt: "2026-10-18T00:00:00.000Z",
        policyRevisionId: "synthetic",
        forecastStatus: "upper-bound",
      },
      modeledReason: null,
      economics: null,
      economicsReason: "inventory-item-missing",
      risk: "unknown",
    },
    {
      listingId: "synthetic-eur",
      quantity: 1,
      currentPriceAmount: "20.00",
      effectivePriceAmount: "20.00",
      currencyCode: "EUR",
      modeled: null,
      modeledReason: "stale-curve",
      economics: null,
      economicsReason: null,
      risk: "unknown",
    },
  ],
  "2026-10-19T00:00:00.000Z",
);
const data: PricingHealthData = {
  policies: [{ policyId: "pol_synthetic", name: "Synthetic policy" }],
  target: { policyId: "pol_synthetic", name: "Synthetic policy", version: 1 },
  health,
  run: {
    dryRunId: "dry_synthetic",
    bodyHash: "synthetic-hash",
    requestedAt: health.capturedAt,
    completedAt: health.capturedAt,
  },
  grades: [],
  computing: false,
};

describe("Pricing Health page states", () => {
  it("renders an unavailable what-if chart while retaining verdict, comparison and grades (F2)", () => {
    const html = renderToStaticMarkup(<PricingHealthPage data={{ ...data, whatIf: { status: "unavailable" } }} />);
    expect(html).toContain("Chart unavailable");
    expect(html).toContain("S1 ");
    expect(html).toContain("Compare goals");
    expect(html).toContain("Forecast Grade");
    expect(html).not.toContain("[missing:");
  });
  it("renders every S1-S9 field, currencies, unavailable economics, provenance and freshness without missing translations", () => {
    const html = renderToStaticMarkup(<PricingHealthPage data={data} />);
    for (let stat = 1; stat <= 9; stat++) expect(html).toContain(`S${stat} `);
    expect(html).toContain("USD");
    expect(html).toContain("EUR");
    expect(html).toContain("$24.00");
    expect(html).toContain("0.5 listings; $6.00");
    expect(html).toContain("Economics population (E)");
    expect(html).toContain("Unavailable");
    expect(html).toContain("dry_synthetic");
    expect(html).toContain("synthetic-hash");
    expect(html).toContain("Stale curves at capture");
    expect(html).not.toContain("[missing:");
  });

  it("old summaries are absent, not fabricated zero verdicts", () => {
    const html = renderToStaticMarkup(
      <PricingHealthPage
        data={{ ...data, health: null, run: null }}
        computeAction={<button>Compute verdict</button>}
      />,
    );
    expect(html).toContain("No verdict for this policy revision yet");
    expect(html).toContain("Compute verdict");
    expect(html).not.toContain("S1 ");
    expect(html).not.toContain("$0.00");
  });

  it("formats comparison requested times for people instead of exposing raw timestamps", () => {
    const requestedAt = "2026-10-20T01:02:03.000Z";
    const html = renderToStaticMarkup(
      <PricingHealthPage
        data={{
          ...data,
          goals: [],
          comparison: [
            {
              goalId: "fixed-percentile",
              goalVersion: 1,
              dryRunId: "dry_comparison",
              status: "completed",
              requestedAt,
              completedAt: requestedAt,
              bodyHash: "a".repeat(64),
              targetPolicyId: "pol_synthetic",
              targetRevision: 1,
              listingCount: 1,
              raised: 1,
              lowered: 0,
              held: 0,
              heldReasons: {},
              value: { USD: "7525.00" },
              medianWaitDays: { USD: 40 / 3 },
              p90WaitDays: { USD: 4 },
              boundStatusCount: { USD: 0 },
              coverage: { USD: 1 },
              profitPerDay: { USD: 5.5 / 11.7 },
              capitalTurn: { USD: 0.1 },
              economicsSet: { digest: "synthetic", size: 1 },
              flags: {},
            },
          ],
          recommendation: { kind: "compare-goals" },
        }}
      />,
    );
    expect(html).toContain(formatDateTime(requestedAt));
    expect(html).toContain(formatMoney("7525.00", "USD"));
    expect(html).toContain(healthNumber(5.5 / 11.7));
    expect(html).not.toContain("0.47008547008547014");
    expect(html).not.toContain("USD 7525.00");
    expect(html).not.toContain(requestedAt);
  });

  it("distinguishes no policy, explicit selection, loading, empty population, computing and source error", () => {
    expect(
      renderToStaticMarkup(
        <PricingHealthPage data={{ ...data, policies: [], target: null, health: null, run: null, grades: [] }} />,
      ),
    ).toContain("Create repricing policy");
    expect(
      renderToStaticMarkup(<PricingHealthPage data={{ ...data, target: null, health: null, run: null, grades: [] }} />),
    ).toContain("Select an active policy");
    expect(renderToStaticMarkup(<PricingHealthPage data={null} loading />)).toContain('aria-busy="true"');
    expect(
      renderToStaticMarkup(<PricingHealthPage data={{ ...data, health: summarizeHealth([], health.capturedAt) }} />),
    ).toContain("No listings in the captured policy scope");
    expect(renderToStaticMarkup(<PricingHealthPage data={{ ...data, computing: true }} />)).toContain(
      "Computing verdict",
    );
    expect(renderToStaticMarkup(<PricingHealthPage data={null} error="Synthetic source outage" />)).toContain(
      "Synthetic source outage",
    );
  });
});
