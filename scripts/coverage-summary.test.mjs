import { describe, expect, it } from "vitest";
import {
  buildCoverageSummary,
  coverageWarnings,
  mergeLcovContents,
  parseCoverageSummaryArgs,
  parseLcovTotals,
} from "./coverage-summary.mjs";

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
    expect(summary).toContain("db coverage command reported status 124.");
  });

  it("accepts the package-manager argument separator", () => {
    expect(parseCoverageSummaryArgs(["--", "--status=non-db:0"]).statuses).toEqual([{ name: "non-db", status: "0" }]);
  });

  it("accepts coverage warning thresholds", () => {
    expect(parseCoverageSummaryArgs(["--warning-threshold=lines:85"]).warningThresholds.lines).toBe(85);
  });

  it("accepts explicit LCOV inputs", () => {
    expect(parseCoverageSummaryArgs(["--lcov-file=bounded-contexts/example/coverage/lcov.info"]).lcovFiles).toEqual([
      "bounded-contexts/example/coverage/lcov.info",
    ]);
  });

  it("de-duplicates LCOV records by source file and keeps the stronger record", () => {
    const merged = mergeLcovContents([
      `SF:bounded-contexts/example/index.ts
LF:10
LH:1
end_of_record`,
      `SF:bounded-contexts/example/index.ts
LF:10
LH:8
end_of_record`,
    ]);

    expect(parseLcovTotals(merged)).toMatchObject({
      files: 1,
      linesFound: 10,
      linesHit: 8,
    });
  });

  it("warns when coverage falls below thresholds", () => {
    expect(
      coverageWarnings({
        totals: {
          files: 1,
          linesFound: 10,
          linesHit: 6,
          functionsFound: 0,
          functionsHit: 0,
          branchesFound: 0,
          branchesHit: 0,
        },
        statuses: [{ name: "non-db", status: "0" }],
        warningThresholds: { lines: 70, functions: 70, branches: 50 },
      }),
    ).toEqual(["Lines coverage 60.00% is below the 70.00% warning threshold."]);
  });
});
