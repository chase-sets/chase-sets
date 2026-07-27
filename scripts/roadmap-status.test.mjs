import { describe, expect, it } from "vitest";
import {
  collectRoadmapIssueFacts,
  END_MARKER,
  isEpic,
  mergeRoadmapIssueFacts,
  renderRoadmapStatus,
  RoadmapIssueEnumerationError,
  runRoadmapStatus,
  spliceIntoBody,
  START_MARKER,
  summarizeWaves,
  toBacklogInput,
} from "./roadmap-status.mjs";
import { classified } from "./backlog-classify.mjs";

const NOW = Date.parse("2026-07-26T00:00:00Z");
const RECENT = "2026-07-24T00:00:00Z";
const OLD = "2026-06-01T00:00:00Z";

const WAVE_1 = { title: "Wave 1", due_on: "2026-07-31T00:00:00Z" };
const WAVE_2 = { title: "Wave 2", due_on: "2026-08-12T00:00:00Z" };
const DEFERRED = { title: "Deferred / Incubation", due_on: null };

function slice(number, milestone, state, labels, created_at = OLD, overrides = {}) {
  return {
    number,
    milestone,
    state,
    labels: labels.map((name) => ({ name })),
    created_at,
    issueTypeName: "Slice",
    blockedByCount: 0,
    hasParent: false,
    ...overrides,
  };
}

describe("roadmap status", () => {
  it("identifies epics and delegates classification to the shared predicate", () => {
    expect(isEpic(slice(1, WAVE_1, "open", ["kind:epic"], OLD, { issueTypeName: null }))).toBe(true);
    expect(isEpic(slice(2, WAVE_1, "open", ["kind:product"]))).toBe(false);

    expect(classified(toBacklogInput(slice(3, WAVE_1, "open", ["priority:p1", "area:catalog", "kind:test"])))).toBe(
      true,
    );
    expect(classified(toBacklogInput(slice(4, WAVE_1, "open", ["priority:p1", "area:catalog"])))).toBe(false);
    expect(classified(toBacklogInput(slice(5, null, "open", ["priority:p1", "area:catalog", "kind:test"])))).toBe(
      false,
    );
  });

  it("counts slices per wave and excludes epics from the counts", () => {
    const issues = [
      slice(1, WAVE_1, "closed", ["kind:product"]),
      slice(2, WAVE_1, "open", ["priority:p0", "area:catalog", "kind:test"]),
      slice(3, WAVE_1, "open", ["kind:tech-debt"]),
      slice(10, null, "open", ["kind:epic"], OLD, { issueTypeName: null }),
    ];
    const { rows } = summarizeWaves({ milestones: [WAVE_1], issues, nowMs: NOW });
    expect(rows[0].total).toBe(3);
    expect(rows[0].closed).toBe(1);
    expect(rows[0].open).toBe(2);
    expect(rows[0].percent).toBe(33);
    expect(rows[0].refinedOpen).toBe(1);
  });

  it("surfaces scope growth inside the window", () => {
    const issues = [
      slice(1, WAVE_1, "open", ["kind:product"], OLD),
      slice(2, WAVE_1, "open", ["kind:product"], RECENT),
      slice(3, WAVE_1, "open", ["kind:product"], RECENT),
    ];
    const { rows } = summarizeWaves({ milestones: [WAVE_1], issues, nowMs: NOW });
    expect(rows[0].addedRecently).toBe(2);
  });

  it("assigns an epic to the earliest wave among its children", () => {
    const issues = [
      slice(10, null, "open", ["kind:epic"], OLD, { issueTypeName: null }),
      slice(11, null, "open", ["kind:epic"], OLD, { issueTypeName: null }),
    ];
    const epicChildren = new Map([
      [
        10,
        [
          { state: "closed", milestone: WAVE_2 },
          { state: "closed", milestone: WAVE_1 },
        ],
      ],
      [11, [{ state: "open", milestone: WAVE_2 }]],
    ]);
    const { rows } = summarizeWaves({ milestones: [WAVE_1, WAVE_2], issues, epicChildren, nowMs: NOW });
    expect(rows[0].epicsTotal).toBe(1);
    expect(rows[0].epicsComplete).toBe(1);
    expect(rows[1].epicsTotal).toBe(1);
    expect(rows[1].epicsComplete).toBe(0);
  });

  it("never counts a childless epic as complete", () => {
    const issues = [slice(10, null, "open", ["kind:epic"], OLD, { issueTypeName: null })];
    const epicChildren = new Map([[10, []]]);
    const { rows } = summarizeWaves({ milestones: [WAVE_1], issues, epicChildren, nowMs: NOW });
    expect(rows[0].epicsTotal).toBe(0);
    expect(rows[0].epicsComplete).toBe(0);
  });

  it("marks parked and operational milestones as not executable", () => {
    const issues = [slice(1, DEFERRED, "open", ["kind:product"])];
    const { rows } = summarizeWaves({ milestones: [DEFERRED], issues, nowMs: NOW });
    expect(rows[0].executable).toBe(false);

    const markdown = renderRoadmapStatus({ rows, windowDays: 7 });
    expect(markdown).toContain("not executable");
    // Parked work must not dilute the refined-percentage signal.
    expect(markdown).toContain("**0 open slices**");
  });

  it("renders a marker-delimited block", () => {
    const issues = [slice(1, WAVE_1, "open", ["priority:p0", "area:catalog", "kind:test"])];
    const { rows } = summarizeWaves({ milestones: [WAVE_1], issues, nowMs: NOW });
    const markdown = renderRoadmapStatus({ rows, windowDays: 7 });
    expect(markdown.startsWith(START_MARKER)).toBe(true);
    expect(markdown.trimEnd().endsWith(END_MARKER)).toBe(true);
    expect(markdown).toContain("| Wave 1 | 2026-07-31 |");
    expect(markdown).toContain("Parent attachment (reported, not gating)");
  });

  it("reports parentless classified slices separately from refined and tracking-only counts", () => {
    const issues = [
      slice(1, WAVE_1, "open", ["priority:p0", "area:catalog", "kind:test"], OLD, { hasParent: false }),
      slice(2, WAVE_1, "open", ["priority:p1", "area:catalog", "kind:test"], OLD, { hasParent: true }),
      slice(3, WAVE_1, "open", ["priority:p2", "area:ops", "kind:tech-debt", "status:tracking-only"], RECENT),
    ];
    const { rows } = summarizeWaves({ milestones: [WAVE_1], issues, nowMs: NOW });

    expect(rows[0]).toMatchObject({
      total: 2,
      open: 2,
      refinedOpen: 2,
      parentlessClassified: 1,
      tracking: 1,
      addedRecently: 0,
    });
    const markdown = renderRoadmapStatus({ rows, windowDays: 7 });
    expect(markdown).toContain("| Wave 1 | 2026-07-31 | 2 | 0 (0%) | 2 | 2/2 | 1 | 1 | 0 |");
    expect(markdown).toContain("**1 classified slices have no parent**");
  });

  it("splices into a body that opts in with markers", () => {
    const body = `intro\n${START_MARKER}\nstale\n${END_MARKER}\noutro`;
    const next = spliceIntoBody(body, `${START_MARKER}\nfresh\n${END_MARKER}`);
    expect(next).toBe(`intro\n${START_MARKER}\nfresh\n${END_MARKER}\noutro`);
  });

  it("refuses to rewrite a body without markers", () => {
    expect(spliceIntoBody("no markers here", "block")).toBeNull();
    expect(spliceIntoBody(`${END_MARKER} before ${START_MARKER}`, "block")).toBeNull();
    expect(spliceIntoBody(null, "block")).toBeNull();
  });
});

describe("roadmap issue parent enumeration", () => {
  const issueNode = (number, parent) => ({
    number,
    state: "OPEN",
    issueType: { name: "Slice" },
    parent,
    issueDependenciesSummary: { blockedBy: 0 },
  });

  it("paginates to exhaustion and preserves a decisive non-Epic parent on page two", async () => {
    const pages = new Map([
      [
        null,
        {
          totalCount: 2,
          pageInfo: { hasNextPage: true, endCursor: "page-2" },
          nodes: [issueNode(1, null)],
        },
      ],
      [
        "page-2",
        {
          totalCount: 2,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [issueNode(2, { number: 99 })],
        },
      ],
    ]);
    const facts = await collectRoadmapIssueFacts(async (after) => pages.get(after));
    const issue = mergeRoadmapIssueFacts(
      slice(2, WAVE_1, "open", ["priority:p1", "area:ops", "kind:test"]),
      facts.get(2),
    );

    expect(toBacklogInput(issue).hasParent).toBe(true);
    expect(classified(toBacklogInput(issue))).toBe(true);
  });

  it("fails closed when the parent source is omitted from the real collector path", async () => {
    const node = issueNode(1, null);
    delete node.parent;
    await expect(
      collectRoadmapIssueFacts(async () => ({
        totalCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [node],
      })),
    ).rejects.toMatchObject({
      name: "RoadmapIssueEnumerationError",
      code: "ROADMAP_ISSUE_NODE_INVALID",
    });
  });

  it("names a count mismatch and makes the production entry wrapper return non-zero", async () => {
    const run = () =>
      collectRoadmapIssueFacts(async () => ({
        totalCount: 2,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [issueNode(1, null)],
      }));
    await expect(run()).rejects.toMatchObject({
      name: "RoadmapIssueEnumerationError",
      code: "ROADMAP_ISSUE_COUNT_MISMATCH",
    });

    const diagnostics = [];
    expect(await runRoadmapStatus(run, (message) => diagnostics.push(message))).toBe(1);
    expect(diagnostics).toEqual([
      expect.stringContaining("RoadmapIssueEnumerationError: Repository issue enumeration collected 1 rows"),
    ]);
  });

  it("fails closed when pagination claims another page without a cursor", async () => {
    await expect(
      collectRoadmapIssueFacts(async () => ({
        totalCount: 2,
        pageInfo: { hasNextPage: true, endCursor: null },
        nodes: [issueNode(1, null)],
      })),
    ).rejects.toBeInstanceOf(RoadmapIssueEnumerationError);
  });
});
