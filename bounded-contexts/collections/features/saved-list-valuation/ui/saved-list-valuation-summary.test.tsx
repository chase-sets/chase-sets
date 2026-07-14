import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SavedListValuationSummary } from "./saved-list-valuation-summary";

describe("SavedListValuationSummary", () => {
  it("renders localized estimate, coverage, confidence, freshness, and disclaimer copy", () => {
    const markup = renderToString(
      <SavedListValuationSummary
        valuation={{
          estimatedTotalAmount: "25.00",
          estimatedTotalBand: { lowAmount: "20.00", highAmount: "30.00" },
          currencyCode: "usd",
          coverage: {
            priced: { lines: 2, units: 4 },
            total: { lines: 4, units: 9 },
            missing: { lines: 1, units: 2 },
            stale: { lines: 1, units: 3 },
            lowConfidence: { lines: 1, units: 1 },
          },
          estimateAsOf: "2026-07-13T10:00:00.000Z",
          valuedAt: "2026-07-13T12:00:00.000Z",
        }}
      />,
    );

    expect(markup).toContain("Estimated market value");
    expect(markup).toContain("$25.00");
    expect(markup).toContain("2 of 4");
    expect(markup).toContain("1 stale");
    expect(markup).toContain("may differ from an eventual sale price");
  });
});
