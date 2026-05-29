import { describe, expect, it } from "vitest";
import { buildCoverageSummary, parseCoverageSummaryArgs, parseLcovTotals } from "./coverage-summary.mjs";

describe("coverage summary", () => {
  it("aggregates LCOV totals", () => {
    const totals = parseLcovTotals(`
SF:bounded-contexts/example/index.ts
FNF:2
FNH:1
BRF:4
BRH:3
LF:10
LH:8
end_of_record
SF:contracts/example/index.ts
LF:5
LH:5
end_of_record
`);

    expect(totals).toEqual({
      files: 2,
      linesFound: 15,
      linesHit: 13,
      functionsFound: 2,
      functionsHit: 1,
      branchesFound: 4,
      branchesHit: 3,
    });
  });

  it("includes command status rows in the Markdown summary", () => {
    const summary = buildCoverageSummary({
      lcovFiles: ["one/lcov.info"],
      totals: {
        files: 1,
        linesFound: 4,
        linesHit: 3,
        functionsFound: 0,
        functionsHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      },
      statuses: [{ name: "db", status: "124" }],
    });

    expect(summary).toContain("LCOV files merged: 1");
    expect(summary).toContain("| Lines | 3 | 4 | 75.00% |");
    expect(summary).toContain("| db | 124 |");
  });

  it("accepts the package-manager argument separator", () => {
    expect(parseCoverageSummaryArgs(["--", "--status=non-db:0"]).statuses).toEqual([{ name: "non-db", status: "0" }]);
  });
});
