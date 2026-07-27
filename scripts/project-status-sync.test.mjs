import { describe, expect, it } from "vitest";
import { classified } from "./backlog-classify.mjs";
import {
  deriveStatus,
  deriveTargetDate,
  isEpic,
  ITEMS_QUERY,
  planDateUpdates,
  planStatusUpdates,
  projectItemFromNode,
  toBacklogInput,
} from "./project-status-sync.mjs";

function issue(overrides = {}) {
  return {
    number: 1,
    state: "open",
    milestone: { title: "Wave 2" },
    labels: [{ name: "priority:p1" }, { name: "area:catalog" }, { name: "kind:product" }],
    blockedBy: 0,
    hasParent: false,
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

  it("prefers the native issue type over the legacy label", () => {
    expect(isEpic(issue({ issueType: { name: "Epic" }, labels: [] }))).toBe(true);
    // A typed Slice still carrying a stale kind:epic label is not an epic.
    expect(isEpic(issue({ issueType: { name: "Slice" }, labels: [{ name: "kind:epic" }] }))).toBe(false);
    // Untyped issues fall back to the label.
    expect(isEpic(issue({ labels: [{ name: "kind:epic" }] }))).toBe(true);
    expect(isEpic(issue())).toBe(false);
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

  it("does not rewrite a closed item's terminal board snapshot to Backlog", () => {
    const items = [{ itemId: "a", status: "Refined", issue: issue({ number: 6150, state: "closed" }) }];
    expect(planStatusUpdates(items)).toEqual([]);
  });

  it("skips tracking-only items instead of silently moving them to Backlog", () => {
    // Live counterexample #6058 is fully classified, parentless, and tracking-only.
    const trackingOnly = issue({
      number: 6058,
      blockedBy: 1,
      labels: [
        { name: "priority:p1" },
        { name: "area:identity" },
        { name: "kind:test" },
        { name: "status:tracking-only" },
      ],
    });
    expect(deriveStatus(trackingOnly)).toBeNull();
    expect(planStatusUpdates([{ itemId: "a", status: "Refined", issue: trackingOnly }])).toEqual([]);
  });

  it("derives truthful parent state from the board query path even when the parent is a Slice", () => {
    expect(ITEMS_QUERY).toContain("parent { number }");
    const item = projectItemFromNode({
      id: "item-1",
      status: { name: "Backlog" },
      targetDate: null,
      content: {
        number: 6169,
        state: "OPEN",
        issueType: { name: "Slice" },
        parent: { number: 6100 },
        milestone: { title: "Wave 1" },
        labels: { nodes: [{ name: "priority:p1" }, { name: "area:ops" }, { name: "kind:tech-debt" }] },
        issueDependenciesSummary: { blockedBy: 0 },
      },
    });

    expect(item.issue.hasParent).toBe(true);
    expect(toBacklogInput(item.issue).hasParent).toBe(true);
    expect(classified(toBacklogInput(item.issue))).toBe(true);
  });

  it("fails closed when the board query path omits parent state", () => {
    const item = projectItemFromNode({
      id: "item-1",
      content: {
        number: 6169,
        state: "OPEN",
        issueType: { name: "Slice" },
        milestone: { title: "Wave 1" },
        labels: { nodes: [{ name: "priority:p1" }, { name: "area:ops" }, { name: "kind:tech-debt" }] },
        issueDependenciesSummary: { blockedBy: 0 },
      },
    });
    expect(() => classified(toBacklogInput(item.issue))).toThrowError(
      expect.objectContaining({ name: "BacklogClassificationInputError", field: "hasParent" }),
    );
  });

  it("fails closed when the board query path omits native issue type state", () => {
    const item = projectItemFromNode({
      id: "item-1",
      content: {
        number: 6169,
        state: "OPEN",
        parent: null,
        milestone: { title: "Wave 1" },
        labels: { nodes: [{ name: "priority:p1" }, { name: "area:ops" }, { name: "kind:tech-debt" }] },
        issueDependenciesSummary: { blockedBy: 0 },
      },
    });
    expect(() => classified(toBacklogInput(item.issue))).toThrowError(
      expect.objectContaining({ name: "BacklogClassificationInputError", field: "issueTypeName" }),
    );
  });
});

describe("target date", () => {
  it("derives the date from the milestone due date", () => {
    expect(deriveTargetDate(issue({ milestone: { title: "Wave 2", dueOn: "2026-08-12T00:00:00Z" } }))).toBe(
      "2026-08-12",
    );
    expect(deriveTargetDate(issue({ milestone: { title: "Wave 2", due_on: "2026-08-12T00:00:00Z" } }))).toBe(
      "2026-08-12",
    );
  });

  it("is null for undated and absent milestones", () => {
    expect(deriveTargetDate(issue({ milestone: { title: "Operations" } }))).toBeNull();
    expect(deriveTargetDate(issue({ milestone: null }))).toBeNull();
  });

  it("re-dates every item when its milestone moves", () => {
    const items = [
      { itemId: "a", targetDate: "2026-08-12", issue: issue({ number: 1, milestone: { dueOn: "2026-08-19" } }) },
      { itemId: "b", targetDate: "2026-08-19", issue: issue({ number: 2, milestone: { dueOn: "2026-08-19" } }) },
    ];
    expect(planDateUpdates(items)).toEqual([{ itemId: "a", number: 1, from: "2026-08-12", to: "2026-08-19" }]);
  });

  it("leaves undated milestones blank rather than guessing", () => {
    const items = [{ itemId: "a", targetDate: null, issue: issue({ milestone: { title: "Deferred / Incubation" } }) }];
    expect(planDateUpdates(items)).toEqual([]);
  });

  it("fills an unset date", () => {
    const items = [{ itemId: "a", targetDate: null, issue: issue({ number: 3, milestone: { dueOn: "2026-09-30" } }) }];
    expect(planDateUpdates(items)).toEqual([{ itemId: "a", number: 3, from: "(none)", to: "2026-09-30" }]);
  });
});
