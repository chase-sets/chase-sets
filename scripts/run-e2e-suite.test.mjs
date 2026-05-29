import { describe, expect, it } from "vitest";
import { batchE2eSuiteIds, e2eSuiteIdsForChangedFile } from "./e2e-suites.mjs";
import { buildSuiteGrep, parseSuiteArgs } from "./run-e2e-suite.mjs";

describe("run e2e suite", () => {
  it("accepts comma-separated and positional suite ids", () => {
    const suites = parseSuiteArgs([
      "marketplace_browse,marketplace_account",
      "marketplace_checkout marketplace_seller",
    ]);

    expect(suites.map((suite) => suite.id)).toEqual([
      "marketplace_browse",
      "marketplace_account",
      "marketplace_checkout",
      "marketplace_seller",
    ]);
  });

  it("builds one Playwright grep expression for selected suites", () => {
    const suites = parseSuiteArgs(["marketplace_checkout,marketplace_seller"]);

    expect(buildSuiteGrep(suites)).toBe("@marketplace-checkout|@marketplace-seller");
  });

  it("batches selected suites for CI without changing suite order", () => {
    expect(
      batchE2eSuiteIds(["marketplace_seller", "marketplace_browse", "marketplace_checkout", "marketplace_account"]),
    ).toEqual(["marketplace_browse,marketplace_account", "marketplace_checkout,marketplace_seller"]);
  });

  it("routes the marketplace index route to browse coverage", () => {
    expect(e2eSuiteIdsForChangedFile("deployables/marketplace/app/routes/index.tsx")).toEqual(["marketplace_browse"]);
  });
});
