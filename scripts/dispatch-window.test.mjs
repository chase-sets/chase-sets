import { describe, expect, it } from "vitest";
import { derivePullWindow, isRunnableRefined } from "./dispatch-window.mjs";

const wave1 = { id: "synthetic-wave-1", number: 1, title: "Wave 1", state: "open" };
const wave2 = { id: "synthetic-wave-2", number: 2, title: "Wave 2", state: "open" };
const mobile1 = { id: "synthetic-mobile-1", number: 3, title: "Mobile 1", state: "open" };
const mobile2 = { id: "synthetic-mobile-2", number: 4, title: "Mobile 2", state: "open" };

function issue(number, milestone, labels, overrides = {}) {
  return {
    id: `synthetic-issue-${number}`,
    number,
    state: "open",
    issueTypeName: "Slice",
    milestone,
    labels: labels.map((name, index) => ({ id: `synthetic-label-${number}-${index}`, name })),
    blockedBy: [],
    ...overrides,
  };
}

describe("dispatch pull window", () => {
  it("derives the per-series pull window from runnable refined facts", () => {
    const facts = {
      milestones: [
        wave1,
        wave2,
        mobile1,
        mobile2,
        { id: "synthetic-other", number: 5, title: "Future", state: "open" },
      ],
      issues: [
        issue(1, wave1, ["priority:p1", "area:ops", "kind:ops"]),
        issue(2, wave2, ["priority:p1", "area:ops", "kind:ops"]),
        issue(3, mobile1, ["priority:p1", "area:ops", "kind:ops"], { blockedBy: [{ state: "open" }] }),
        issue(4, mobile2, ["priority:p1", "area:ops", "kind:ops"]),
        issue(5, wave1, ["priority:p1", "area:ops", "kind:ops", "status:tracking-only"]),
      ],
    };

    expect(derivePullWindow(facts)).toEqual([
      { id: "synthetic-mobile-2", number: 4, title: "Mobile 2" },
      { id: "synthetic-wave-1", number: 1, title: "Wave 1" },
    ]);
  });

  it("excludes blocked, unclassified, tracking-only, and nonmatching facts from runnable selection", () => {
    expect(
      derivePullWindow({
        milestones: [
          wave1,
          wave2,
          { id: "synthetic-deferred", number: 6, title: "Deferred / Incubation", state: "open" },
        ],
        issues: [
          issue(1, wave1, ["priority:p1", "area:ops", "kind:ops"], { blockedBy: [{ state: "open" }] }),
          issue(2, wave1, ["priority:p1", "area:ops"]),
          issue(3, wave1, ["priority:p1", "area:ops", "kind:ops", "status:tracking-only"]),
          issue(4, { id: "synthetic-deferred", number: 6, title: "Deferred / Incubation", state: "open" }, [
            "priority:p1",
            "area:ops",
            "kind:ops",
          ]),
        ],
      }),
    ).toEqual([]);
  });

  it("derives runnable status from native open blocker nodes", () => {
    const candidate = issue(1, wave1, ["priority:p1", "area:ops", "kind:ops"]);
    const summaryClaimsBlocked = {
      ...candidate,
      id: "synthetic-summary-claims-blocked",
      issueDependenciesSummary: { blockedBy: 3, totalBlockedBy: 3 },
      blockedBy: [],
    };
    const nativeNodeClaimsBlocked = {
      ...candidate,
      id: "synthetic-native-node-claims-blocked",
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
      blockedBy: [{ id: "synthetic-open-blocker", state: "open" }],
    };
    expect(isRunnableRefined(summaryClaimsBlocked)).toBe(true);
    expect(isRunnableRefined(nativeNodeClaimsBlocked)).toBe(false);
    expect(isRunnableRefined({ ...candidate, blockedBy: [{ state: "closed" }] })).toBe(true);
    expect(isRunnableRefined({ ...candidate, blockedBy: [{ state: "open" }] })).toBe(false);
  });
});
