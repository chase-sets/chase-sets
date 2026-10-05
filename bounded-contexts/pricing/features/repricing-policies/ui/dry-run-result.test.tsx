import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepricingDryRun } from "../../repricing-engine/api/dry-run";
import type { RepricingPolicyListingTrace } from "../../repricing-engine/domain/fact";
import { dryRunBody } from "../../repricing-engine/tests/dry-run-fixture";
import { DryRunResult } from "./dry-run-result";

const run: RepricingDryRun = {
  dryRunId: "synthetic",
  body: dryRunBody,
  bodyHash: "synthetic-hash",
  status: "completed",
  replacingPolicyId: null,
  requestedAt: "2026-09-27T00:00:00Z",
  completedAt: "2026-09-27T00:00:01Z",
  updatedAt: "2026-09-27T00:00:01Z",
  consumedAt: null,
  cursor: null,
  summary: {
    listingsEvaluated: 1,
    outcomes: { changed: 1 },
    flags: { "floor-binding": 1 },
    withinTolerance: 0,
    deltaBuckets: { "3": 1 },
    skipReasons: {},
  },
};

describe("dry-run result", () => {
  it("names the stratum and clamps but never renders competing identity or mode for a derived-ask negative control", () => {
    const trace = {
      listingId: "lst_owned",
      currentPriceAmount: "10.00",
      targetPriceAmount: "9.60",
      ruleIndex: 0,
      outcome: "changed",
      skipReason: null,
      exhaustedAnchors: [],
      flags: ["band-binding", "floor-binding"],
      clamps: { floor: true, ceiling: false, maxMove: false },
      anchor: {
        source: "lowest-competing-ask",
        amount: "9.60",
        stratum: "any-ask",
        contributingListingCount: 4,
        competingListingId: "lst_competitor_secret",
        pricingMode: "derived",
        sellerAccountId: "acc_competitor_secret",
      },
      competingListingIds: ["lst_competitor_other"],
    } as unknown as RepricingPolicyListingTrace;
    const html = renderToStaticMarkup(<DryRunResult run={run} traces={[trace]} />);
    expect(html).toContain("Anchored to the lowest listing of any kind, held at the band floor");
    expect(html).toContain("lst_owned");
    for (const secret of [
      "lst_competitor_secret",
      "acc_competitor_secret",
      "lst_competitor_other",
      "derived",
      "algorithmic",
    ])
      expect(html).not.toContain(secret);
  });
  it("distinguishes running, failed and empty completed previews", () => {
    expect(
      renderToStaticMarkup(<DryRunResult run={{ ...run, status: "running", summary: null }} traces={[]} />),
    ).toContain("Preview in progress");
    expect(renderToStaticMarkup(<DryRunResult run={{ ...run, status: "failed" }} traces={[]} />)).toContain(
      "This preview failed",
    );
    expect(
      renderToStaticMarkup(
        <DryRunResult run={{ ...run, summary: { ...run.summary!, listingsEvaluated: 0 } }} traces={[]} />,
      ),
    ).toContain("No listings matched");
  });
});
