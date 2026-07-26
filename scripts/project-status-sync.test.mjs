import { describe, expect, it } from "vitest";
import { deriveStatus, planStatusUpdates } from "./project-status-sync.mjs";

function issue(overrides = {}) {
  return {
    number: 1,
    milestone: { title: "Wave 2" },
    labels: [{ name: "priority:p1" }, { name: "area:catalog" }, { name: "kind:product" }],
    blockedBy: 0,
    ...overrides,
  };
}

describe("project status sync", () => {
  it("derives Refined when placed and fully classified", () => {
    expect(deriveStatus(issue())).toBe("Refined");
  });

  it("derives Backlog when any classification is missing", () => {
    expect(deriveStatus(issue({ labels: [{ name: "area:catalog" }, { name: "kind:product" }] }))).toBe("Backlog");
    expect(deriveStatus(issue({ labels: [{ name: "priority:p1" }, { name: "kind:product" }] }))).toBe("Backlog");
    expect(deriveStatus(issue({ milestone: null }))).toBe("Backlog");
  });

  it("treats parked and operational milestones as Backlog even when classified", () => {
    expect(deriveStatus(issue({ milestone: { title: "Deferred / Incubation" } }))).toBe("Backlog");
    expect(deriveStatus(issue({ milestone: { title: "Operations" } }))).toBe("Backlog");
  });

  it("Blocked outranks everything", () => {
    expect(deriveStatus(issue({ blockedBy: 1 }))).toBe("Blocked");
    expect(deriveStatus(issue({ blockedBy: 2, milestone: null }))).toBe("Blocked");
  });

  it("leaves epics alone", () => {
    expect(deriveStatus(issue({ labels: [{ name: "kind:epic" }] }))).toBeNull();
  });

  it("plans only real transitions", () => {
    const items = [
      { itemId: "a", status: "Backlog", issue: issue({ number: 10 }) },
      { itemId: "b", status: "Refined", issue: issue({ number: 11 }) },
    ];
    expect(planStatusUpdates(items)).toEqual([{ itemId: "a", number: 10, from: "Backlog", to: "Refined" }]);
  });

  it("unblocks an item whose blocker closed", () => {
    const items = [{ itemId: "a", status: "Blocked", issue: issue({ number: 12, blockedBy: 0 }) }];
    expect(planStatusUpdates(items)).toEqual([{ itemId: "a", number: 12, from: "Blocked", to: "Refined" }]);
  });

  it("never clobbers a lane-owned state", () => {
    for (const status of ["In lane", "In review", "Landed"]) {
      const items = [{ itemId: "a", status, issue: issue({ blockedBy: 5 }) }];
      expect(planStatusUpdates(items)).toEqual([]);
    }
  });

  it("fills an unset status", () => {
    const items = [{ itemId: "a", status: null, issue: issue({ number: 13 }) }];
    expect(planStatusUpdates(items)).toEqual([{ itemId: "a", number: 13, from: "(none)", to: "Refined" }]);
  });

  it("skips epics entirely", () => {
    const items = [{ itemId: "a", status: null, issue: issue({ labels: [{ name: "kind:epic" }] }) }];
    expect(planStatusUpdates(items)).toEqual([]);
  });
});
