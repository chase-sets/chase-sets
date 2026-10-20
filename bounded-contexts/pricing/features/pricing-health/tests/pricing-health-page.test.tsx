import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PricingHealthPage } from "../ui/page";
import { summarizeHealth } from "../../repricing-engine/api/health-summary";
import type { PricingHealthData } from "../api/services";

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
