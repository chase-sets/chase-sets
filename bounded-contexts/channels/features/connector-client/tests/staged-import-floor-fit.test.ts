import { describe, expect, it } from "vitest";
import {
  stagedImportProtocolCost,
  assertStagedImportFit,
  decodeStagedImportCapturePlan,
} from "../domain/staged-import-fit";

describe("synthetic staged-import-floor-protocol-budget (not provider qualification)", () => {
  it("charges initial wait, every hop/read, long requests and overhead without adding the lease margin", () => {
    expect(stagedImportProtocolCost(60000, [1000, 1000, 1000], 60000, 4000)).toBe(185000);
    expect(stagedImportProtocolCost(60000, [70000, 1000], 0, 100)).toBe(71100);
    expect(stagedImportProtocolCost(60000, [], 60000, 4000)).toBe(0);
  });
  it("admits equality, refuses +1ms and requires a strictly separate 30s lease margin", () => {
    expect(() =>
      assertStagedImportFit({
        costMs: 185000,
        remainingMs: 185000,
        dispatchDeadlineMs: 185000,
        now: 0,
        leaseExpiresAt: 215001,
        policyRemainingMs: 185001,
      }),
    ).not.toThrow();
    for (const patch of [
      { costMs: 185001 },
      { leaseExpiresAt: 215000 },
      { policyRemainingMs: 185000 },
      { dispatchDeadlineMs: 600001 },
      { costMs: Infinity },
    ])
      expect(() =>
        assertStagedImportFit({
          costMs: 185000,
          remainingMs: 185000,
          dispatchDeadlineMs: 185000,
          now: 0,
          leaseExpiresAt: 215001,
          policyRemainingMs: 185001,
          ...patch,
        }),
      ).toThrow("staged-import-fit-refused");
  });
  it("refuses missing/partial capture, unknown read duration, polling, count and overflow before send", () => {
    for (const value of [null, {}, { complete: false }, { source: "hypothetical", requests: [] }])
      expect(() => decodeStagedImportCapturePlan(value)).toThrow("staged-import-plan-unavailable");
    for (const durations of [[0], [-1], [NaN], [Number.MAX_SAFE_INTEGER], Array(4097).fill(1)])
      expect(() => stagedImportProtocolCost(60000, durations, 0, 1)).toThrow("staged-import-fit-refused");
  });
});
