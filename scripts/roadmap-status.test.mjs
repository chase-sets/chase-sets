import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { classified } from "./backlog-classify.mjs";
import { releaseQualificationScopeRegistry } from "./release-qualification-scope.mjs";
import {
  collectEpicChildren,
  collectRoadmapIssueFacts,
  collectScopeGrowth,
  END_MARKER,
  isEpic,
  main,
  mergeRoadmapIssueFacts,
  paginate,
  reconcileEpicChildren,
  renderRoadmapStatus,
  resolveCurrentMilestoneEntry,
  RoadmapIssueEnumerationError,
  runRoadmapStatus,
  selectTimelineIssues,
  spliceIntoBody,
  START_MARKER,
  summarizeWaves,
  timelineFetchRequired,
  toBacklogInput,
} from "./roadmap-status.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-07-28T00:00:00Z");
const CUTOFF = Date.parse("2026-07-21T00:00:00Z");
const RECENT = "2026-07-26T00:00:00Z";
const OLD = "2026-06-01T00:00:00Z";
const STALE = "2026-07-20T23:59:59Z";
const WAVE_1 = { title: "Wave 1", due_on: "2026-07-31T00:00:00Z" };
const WAVE_2 = { title: "Wave 2", due_on: "2026-08-12T00:00:00Z" };
const DEFERRED = { title: "Deferred / Incubation", due_on: null };
const OPERATIONS = { title: "Operations", due_on: null };

function slice(number, milestone, state, labels, created_at = OLD, overrides = {}) {
  return {
    number,
    milestone,
    state,
    labels: labels.map((name) => ({ name })),
    created_at,
    updated_at: created_at,
    issueTypeName: "Slice",
    blockedByCount: 0,
    hasParent: false,
    ...overrides,
  };
}

function epic(number, total, overrides = {}) {
  return slice(number, null, "open", ["kind:epic"], OLD, {
    issueTypeName: "Epic",
    sub_issues_summary: { total },
    ...overrides,
  });
}

function knownGrowth(issues, entryByNumber = new Map()) {
  return new Map(
    issues
      .filter((issue) => !isEpic(issue))
      .map((issue) => [
        issue.number,
        {
          status: "known",
          enteredAtMs: entryByNumber.has(issue.number) ? entryByNumber.get(issue.number) : Date.parse(issue.created_at),
          source: "test-fixture",
        },
      ]),
  );
}

function jsonResponse(body, { status = 200, link } = {}) {
  const headers = { "content-type": "application/json" };
  if (link) headers.link = link;
  return new Response(JSON.stringify(body), { status, headers });
}

function issueFactNode(issue) {
  return {
    number: issue.number,
    state: issue.state.toUpperCase(),
    issueType: { name: issue.issueTypeName },
    parent: issue.hasParent ? { number: 999 } : null,
    issueDependenciesSummary: { blockedBy: issue.blockedByCount },
  };
}

function createMainRequest({
  issues = [],
  milestones = [WAVE_1],
  roadmapBody = `${START_MARKER}\nstale\n${END_MARKER}`,
  childrenByEpic = new Map(),
  timelinesByIssue = new Map(),
} = {}) {
  const requests = [];
  const request = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    requests.push({ method, url: parsed.href, body: init.body ?? null });

    if (parsed.pathname === "/graphql") {
      return jsonResponse({
        data: {
          repository: {
            issues: {
              totalCount: issues.length,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: issues.map(issueFactNode),
            },
          },
        },
      });
    }
    if (parsed.pathname === "/repos/chase-sets/chase-sets/milestones") {
      return jsonResponse(milestones);
    }
    if (parsed.pathname === "/repos/chase-sets/chase-sets/issues" && parsed.searchParams.get("state") === "all") {
      return jsonResponse(issues);
    }

    const subIssues = parsed.pathname.match(/^\/repos\/chase-sets\/chase-sets\/issues\/(\d+)\/sub_issues$/);
    if (subIssues) return jsonResponse(childrenByEpic.get(Number(subIssues[1])) ?? []);
    const timeline = parsed.pathname.match(/^\/repos\/chase-sets\/chase-sets\/issues\/(\d+)\/timeline$/);
    if (timeline) return jsonResponse(timelinesByIssue.get(Number(timeline[1])) ?? []);

    if (parsed.pathname === "/repos/chase-sets/chase-sets/issues/4129") {
      return method === "PATCH"
        ? jsonResponse(JSON.parse(init.body))
        : jsonResponse({ number: 4129, body: typeof roadmapBody === "function" ? roadmapBody() : roadmapBody });
    }
    return jsonResponse({ message: `Unhandled test request: ${method} ${parsed.href}` }, { status: 404 });
  };
  return { request, requests };
}

function mainEnv(overrides = {}) {
  return {
    ...process.env,
    GITHUB_REPOSITORY: "chase-sets/chase-sets",
    GITHUB_TOKEN: "test-token",
    ROADMAP_ISSUE: "4129",
    GITHUB_STEP_SUMMARY: "",
    ...overrides,
  };
}

describe("roadmap status classification and preserved rollups", () => {
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

  it("preserves slice burn-up, classifier, parentless, and tracking counts", () => {
    const issues = [
      slice(1, WAVE_1, "closed", ["kind:product"]),
      slice(2, WAVE_1, "open", ["priority:p0", "area:catalog", "kind:test"], OLD, { hasParent: false }),
      slice(3, WAVE_1, "open", ["priority:p1", "area:catalog", "kind:test"], OLD, { hasParent: true }),
      slice(4, WAVE_1, "open", ["kind:tech-debt"]),
      slice(5, WAVE_1, "open", ["priority:p2", "area:ops", "kind:tech-debt", "status:tracking-only"]),
      epic(10, 0),
    ];
    const { rows } = summarizeWaves({
      milestones: [WAVE_1],
      issues,
      scopeGrowthByIssue: knownGrowth(issues),
      nowMs: NOW,
    });
    expect(rows[0]).toMatchObject({
      total: 4,
      closed: 1,
      open: 3,
      percent: 25,
      refinedOpen: 2,
      parentlessClassified: 1,
      tracking: 1,
    });
  });

  it("assigns an epic to the earliest wave among its reconciled children", () => {
    const issues = [epic(10, 2), epic(11, 1)];
    const epicChildren = new Map([
      [
        10,
        [
          { number: 20, state: "closed", milestone: WAVE_2 },
          { number: 21, state: "closed", milestone: WAVE_1 },
        ],
      ],
      [11, [{ number: 22, state: "open", milestone: WAVE_2 }]],
    ]);
    const { rows } = summarizeWaves({
      milestones: [WAVE_1, WAVE_2],
      issues,
      epicChildren,
      scopeGrowthByIssue: new Map(),
      nowMs: NOW,
    });
    expect(rows[0]).toMatchObject({ epicsTotal: 1, epicsComplete: 1 });
    expect(rows[1]).toMatchObject({ epicsTotal: 1, epicsComplete: 0 });
  });

  it("never counts a childless epic as complete", () => {
    const issues = [epic(10, 0)];
    const { rows } = summarizeWaves({
      milestones: [WAVE_1],
      issues,
      epicChildren: new Map([[10, []]]),
      scopeGrowthByIssue: new Map(),
      nowMs: NOW,
    });
    expect(rows[0]).toMatchObject({ epicsTotal: 0, epicsComplete: 0 });
  });

  it("keeps Deferred and Operations non-executable and outside executable totals", () => {
    const issues = [slice(1, DEFERRED, "open", ["kind:product"]), slice(2, OPERATIONS, "open", ["kind:ops"])];
    const { rows } = summarizeWaves({
      milestones: [DEFERRED, OPERATIONS],
      issues,
      scopeGrowthByIssue: new Map(),
      nowMs: NOW,
    });
    expect(rows.every((row) => !row.executable)).toBe(true);
    const markdown = renderRoadmapStatus({ rows, windowDays: 7 });
    expect(markdown).toContain("**0 open slices**");
    expect(markdown).toContain("| Deferred / Incubation _(not executable)_ | — | 1 |");
    expect(markdown).toContain("| Operations _(not executable)_ | — | 1 |");
    expect(markdown.match(/\| — \| — \|$/gm)).toHaveLength(2);
  });

  it("renders exactly one ordered roadmap marker pair", () => {
    const markdown = renderRoadmapStatus({
      rows: [],
      windowDays: 7,
    });
    expect(markdown.split(START_MARKER)).toHaveLength(2);
    expect(markdown.split(END_MARKER)).toHaveLength(2);
    expect(markdown.indexOf(START_MARKER)).toBeLessThan(markdown.indexOf(END_MARKER));
  });
});

describe("latest-entry scope growth", () => {
  it("counts an old issue milestoned into its current wave two days ago", async () => {
    const issue = slice(1, WAVE_1, "open", ["kind:product"], OLD, { updated_at: RECENT });
    const growth = await collectScopeGrowth({
      issues: [issue],
      nowMs: NOW,
      loadTimeline: async () => [{ event: "milestoned", milestone: { title: WAVE_1.title }, created_at: RECENT }],
    });
    const { rows } = summarizeWaves({
      milestones: [WAVE_1],
      issues: [issue],
      scopeGrowthByIssue: growth.byIssue,
      nowMs: NOW,
    });
    expect(rows[0]).toMatchObject({ addedRecently: 1, growthUnknown: 0 });
  });

  it("counts an in then demilestoned-out issue in no wave", async () => {
    const issue = slice(2, null, "open", ["kind:product"], OLD, { updated_at: RECENT });
    const timeline = [
      { event: "milestoned", milestone: { title: WAVE_1.title }, created_at: "2026-07-25T00:00:00Z" },
      { event: "demilestoned", milestone: { title: WAVE_1.title }, created_at: RECENT },
    ];
    let fetches = 0;
    const growth = await collectScopeGrowth({
      issues: [issue],
      nowMs: NOW,
      loadTimeline: async () => {
        fetches += 1;
        return timeline;
      },
    });
    const { rows } = summarizeWaves({
      milestones: [WAVE_1],
      issues: [issue],
      scopeGrowthByIssue: growth.byIssue,
      nowMs: NOW,
    });
    expect(fetches).toBe(0);
    expect(rows[0]).toMatchObject({ total: 0, addedRecently: 0, growthUnknown: 0 });
  });

  it("counts in then out then in once by the latest matching entry", () => {
    const issue = slice(3, WAVE_1, "open", ["kind:product"], OLD, { updated_at: RECENT });
    const entry = resolveCurrentMilestoneEntry(issue, [
      { event: "milestoned", milestone: { title: WAVE_1.title }, created_at: "2026-06-02T00:00:00Z" },
      { event: "demilestoned", milestone: { title: WAVE_1.title }, created_at: "2026-07-25T00:00:00Z" },
      { event: "milestoned", milestone: { title: WAVE_1.title }, created_at: RECENT },
    ]);
    expect(entry).toEqual({
      status: "known",
      enteredAtMs: Date.parse(RECENT),
      source: "latest-milestoned-event",
    });
    const { rows } = summarizeWaves({
      milestones: [WAVE_1],
      issues: [issue],
      scopeGrowthByIssue: new Map([[issue.number, entry]]),
      nowMs: NOW,
    });
    expect(rows[0].addedRecently).toBe(1);
  });

  it("makes a renamed milestone bounded-unknown and never falls back to created_at", () => {
    const issue = slice(4, WAVE_1, "open", ["kind:product"], OLD, { updated_at: RECENT });
    const entry = resolveCurrentMilestoneEntry(issue, [
      { event: "milestoned", milestone: { title: "Wave One (old title)" }, created_at: RECENT },
    ]);
    expect(entry).toEqual({
      status: "unknown",
      reason: `milestone history has no entry titled "${WAVE_1.title}"`,
    });
    expect(entry.source).toBeUndefined();

    const { rows } = summarizeWaves({
      milestones: [WAVE_1],
      issues: [issue],
      scopeGrowthByIssue: new Map([[issue.number, entry]]),
      nowMs: NOW,
    });
    const markdown = renderRoadmapStatus({ rows, windowDays: 7 });
    expect(rows[0]).toMatchObject({ addedRecently: 0, growthUnknown: 1 });
    expect(markdown).toContain("| Wave 1 | 2026-07-31 | 1 | 0 (0%) | 1 | 0/1 | 0 | 0 | ? |");
    expect(markdown).toContain("scope growth is **?** (1 issue has bounded-unknown entry history)");
    expect(markdown).toContain("Scope-growth diagnostics (bounded unknown): Wave 1: 1 issue.");
    expect(markdown).not.toContain("0 entered current scope");
  });

  it("uses created_at only when a fetched timeline has zero milestone events", () => {
    const issue = slice(5, WAVE_1, "open", ["kind:product"], OLD, { updated_at: RECENT });
    expect(resolveCurrentMilestoneEntry(issue, [])).toEqual({
      status: "known",
      enteredAtMs: Date.parse(OLD),
      source: "created-at-with-zero-milestone-events",
    });
    expect(
      resolveCurrentMilestoneEntry(issue, [
        { event: "milestoned", milestone: { title: "Renamed Wave" }, created_at: RECENT },
      ]),
    ).toMatchObject({ status: "unknown" });
  });

  it("counts a recently created current member without fetching its timeline", async () => {
    const issue = slice(6, WAVE_1, "open", ["kind:product"], RECENT, { updated_at: RECENT });
    const growth = await collectScopeGrowth({
      issues: [issue],
      nowMs: NOW,
      loadTimeline: async () => {
        throw new Error("D4 must not fetch a recently created issue");
      },
    });
    expect(growth.selectedIssues).toEqual([]);
    expect(growth.byIssue.get(issue.number)).toEqual({
      status: "known",
      enteredAtMs: Date.parse(RECENT),
      source: "created-in-window",
    });
  });

  it("selects timelines only with D4's exact executable current-scope predicate", () => {
    const selected = slice(1, WAVE_1, "open", ["kind:product"], OLD, { updated_at: RECENT });
    const fixtures = [
      selected,
      slice(2, WAVE_1, "open", ["kind:product"], RECENT, { updated_at: RECENT }),
      slice(3, WAVE_1, "open", ["kind:product"], OLD, { updated_at: STALE }),
      slice(4, DEFERRED, "open", ["kind:product"], OLD, { updated_at: RECENT }),
      slice(5, OPERATIONS, "open", ["kind:ops"], OLD, { updated_at: RECENT }),
      slice(6, WAVE_1, "open", ["kind:product", "status:tracking-only"], OLD, { updated_at: RECENT }),
      epic(7, 0, { milestone: WAVE_1, updated_at: RECENT }),
      slice(8, null, "open", ["kind:product"], OLD, { updated_at: RECENT }),
    ];
    expect(timelineFetchRequired(selected, CUTOFF)).toBe(true);
    expect(selectTimelineIssues({ issues: fixtures, nowMs: NOW }).map((issue) => issue.number)).toEqual([1]);
  });

  it("paginates every selected timeline to exhaustion with each decisive entry on page two", async () => {
    const issues = [
      slice(10, WAVE_1, "open", ["kind:product"], OLD, { updated_at: RECENT }),
      slice(11, WAVE_2, "open", ["kind:product"], OLD, { updated_at: RECENT }),
    ];
    const requests = [];
    const request = async (url) => {
      const parsed = new URL(url);
      const issueNumber = Number(parsed.pathname.match(/issues\/(\d+)\/timeline$/)?.[1]);
      const page = parsed.searchParams.get("page");
      requests.push(`${issueNumber}:${page ?? "1"}`);
      if (!page) {
        return jsonResponse([{ event: "demilestoned", milestone: { title: `Old ${issueNumber}` }, created_at: OLD }], {
          link: `<https://api.github.com/repos/chase-sets/chase-sets/issues/${issueNumber}/timeline?per_page=100&page=2>; rel="next"`,
        });
      }
      return jsonResponse([
        {
          event: "milestoned",
          milestone: { title: issueNumber === 10 ? WAVE_1.title : WAVE_2.title },
          created_at: RECENT,
        },
      ]);
    };
    const growth = await collectScopeGrowth({
      issues,
      nowMs: NOW,
      concurrency: 2,
      loadTimeline: (issue) =>
        paginate(`/repos/chase-sets/chase-sets/issues/${issue.number}/timeline?per_page=100`, "token", request),
    });
    expect(requests.sort()).toEqual(["10:1", "10:2", "11:1", "11:2"]);
    expect(growth.byIssue.get(10)).toMatchObject({ status: "known", enteredAtMs: Date.parse(RECENT) });
    expect(growth.byIssue.get(11)).toMatchObject({ status: "known", enteredAtMs: Date.parse(RECENT) });
  });

  it("locks every intentional delta from the landed created-at classifier", () => {
    const corpus = [
      {
        number: 1,
        createdAt: OLD,
        entry: { status: "known", enteredAtMs: Date.parse(OLD) },
        expected: "not-added",
      },
      {
        number: 2,
        createdAt: RECENT,
        entry: { status: "known", enteredAtMs: Date.parse(RECENT) },
        expected: "added",
      },
      {
        number: 3,
        createdAt: OLD,
        entry: { status: "known", enteredAtMs: Date.parse(RECENT) },
        expected: "added",
      },
      {
        number: 4,
        createdAt: OLD,
        entry: { status: "unknown", reason: "renamed" },
        expected: "unknown",
      },
    ];
    const predecessor = (item) => (Date.parse(item.createdAt) >= CUTOFF ? "added" : "not-added");
    const candidate = (item) =>
      item.entry.status === "unknown"
        ? "unknown"
        : item.entry.enteredAtMs !== null && item.entry.enteredAtMs >= CUTOFF
          ? "added"
          : "not-added";
    expect(corpus.map(candidate)).toEqual(corpus.map((item) => item.expected));
    expect(corpus.filter((item) => predecessor(item) !== candidate(item)).map((item) => item.number)).toEqual([3, 4]);
  });
});

describe("fail-closed marker splice", () => {
  const block = `${START_MARKER}\nfresh\n${END_MARKER}`;

  it("splices a valid single ordered pair", () => {
    const body = `intro\n${START_MARKER}\nstale\n${END_MARKER}\noutro`;
    expect(spliceIntoBody(body, block)).toBe(`intro\n${block}\noutro`);
  });

  it("splices a valid CRLF single pair without changing prose outside it", () => {
    const body = `intro\r\n${START_MARKER}\r\nstale\r\n${END_MARKER}\r\noutro`;
    expect(spliceIntoBody(body, block)).toBe(`intro\r\n${block}\r\noutro`);
  });

  it.each([
    ["missing start", `intro\n${END_MARKER}`],
    ["missing end", `${START_MARKER}\noutro`],
    ["reordered end before start", `${END_MARKER}\n${START_MARKER}`],
    ["duplicate start", `${START_MARKER}\n${START_MARKER}\n${END_MARKER}`],
    ["duplicate end", `${START_MARKER}\n${END_MARKER}\n${END_MARKER}`],
    ["duplicate pair", `${START_MARKER}\none\n${END_MARKER}\n${START_MARKER}\ntwo\n${END_MARKER}`],
    ["quoted marker above the real pair", `> quote ${START_MARKER}\n${START_MARKER}\nold\n${END_MARKER}`],
    ["nested pair", `${START_MARKER}\n${START_MARKER}\nnested\n${END_MARKER}\n${END_MARKER}`],
    [
      "marker in a fenced block above the real pair",
      `\`\`\`\n${START_MARKER}\n\`\`\`\n${START_MARKER}\nold\n${END_MARKER}`,
    ],
  ])("refuses %s", (_name, body) => {
    expect(spliceIntoBody(body, block)).toBeNull();
  });

  it("keeps the no-marker opt-in path null", () => {
    expect(spliceIntoBody("no markers here", block)).toBeNull();
    expect(spliceIntoBody(null, block)).toBeNull();
  });
});

describe("epic child reconciliation", () => {
  it("reconciles a complete child collection and preserves a decisive page-two child", async () => {
    const target = epic(100, 2);
    const requests = [];
    const request = async (url) => {
      const parsed = new URL(url);
      requests.push(parsed.searchParams.get("page") ?? "1");
      if (!parsed.searchParams.has("page")) {
        return jsonResponse([{ number: 101, state: "open", milestone: WAVE_2 }], {
          link: '<https://api.github.com/repos/chase-sets/chase-sets/issues/100/sub_issues?per_page=100&page=2>; rel="next"',
        });
      }
      return jsonResponse([{ number: 102, state: "closed", milestone: WAVE_1 }]);
    };
    const byEpic = await collectEpicChildren({
      epics: [target],
      loadChildren: async () =>
        paginate("/repos/chase-sets/chase-sets/issues/100/sub_issues?per_page=100", "token", request),
    });
    expect(requests).toEqual(["1", "2"]);
    expect(byEpic.get(100)).toEqual([
      { number: 101, state: "open", milestone: WAVE_2 },
      { number: 102, state: "closed", milestone: WAVE_1 },
    ]);
  });

  it("fails closed on a missing, truncated, or duplicate independent total", () => {
    expect(() => reconcileEpicChildren(epic(1, 2), [{ number: 10 }, { number: 11 }])).not.toThrow();
    expect(() => reconcileEpicChildren(epic(2, 2), [{ number: 10 }])).toThrowError(
      expect.objectContaining({ code: "ROADMAP_EPIC_CHILD_COUNT_MISMATCH" }),
    );
    expect(() => reconcileEpicChildren(epic(3, 2), [{ number: 10 }, { number: 10 }])).toThrowError(
      expect.objectContaining({ code: "ROADMAP_EPIC_CHILD_COUNT_MISMATCH" }),
    );
    expect(() => reconcileEpicChildren({ number: 4 }, [])).toThrowError(
      expect.objectContaining({ code: "ROADMAP_EPIC_CHILD_TOTAL_INVALID" }),
    );
  });

  it("fails closed on an unsafe pagination continuation", async () => {
    await expect(
      paginate("/repos/chase-sets/chase-sets/issues/100/sub_issues?per_page=100", "token", async () =>
        jsonResponse([], { link: '<https://attacker.invalid/page/2>; rel="next"' }),
      ),
    ).rejects.toMatchObject({
      name: "RoadmapIssueEnumerationError",
      code: "ROADMAP_PAGINATION_LINK_INVALID",
    });
  });
});

describe("real main composition", () => {
  it("returns 1 with a named marker diagnostic and zero PATCH requests for a marker anomaly", async () => {
    const { request, requests } = createMainRequest({
      roadmapBody: `${START_MARKER}\n${START_MARKER}\nstale\n${END_MARKER}`,
    });
    const diagnostics = [];
    const code = await main({
      env: mainEnv(),
      request,
      nowMs: NOW,
      writeOutput: () => {},
      writeError: (message) => diagnostics.push(message),
    });
    expect(code).toBe(1);
    expect(diagnostics).toEqual([expect.stringContaining("ROADMAP_MARKERS_INVALID")]);
    expect(requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it("returns 1 with the epic mismatch diagnostic and zero PATCH requests before mutation", async () => {
    const target = epic(100, 2);
    const { request, requests } = createMainRequest({
      issues: [target],
      childrenByEpic: new Map([[100, [{ number: 101, state: "closed", milestone: WAVE_1 }]]]),
    });
    const diagnostics = [];
    const generated = [];
    const code = await runRoadmapStatus(
      () =>
        main({
          env: mainEnv(),
          request,
          nowMs: NOW,
          writeOutput: (message) => generated.push(message),
          writeError: (message) => diagnostics.push(message),
        }),
      (message) => diagnostics.push(message),
    );
    expect(code).toBe(1);
    expect(diagnostics).toEqual([expect.stringContaining("Epic #100 collected 1 children")]);
    expect(generated).toEqual([]);
    expect(requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it("writes counted bounded-unknown diagnostics to stdout and the step summary", async () => {
    const issue = slice(200, WAVE_1, "open", ["kind:product"], OLD, { updated_at: RECENT });
    const { request } = createMainRequest({
      issues: [issue],
      timelinesByIssue: new Map([
        [200, [{ event: "milestoned", milestone: { title: "Wave 1 (old title)" }, created_at: RECENT }]],
      ]),
    });
    let output = "";
    let stepSummary = "";
    const code = await main({
      env: mainEnv({ ROADMAP_ISSUE: "" }),
      request,
      nowMs: NOW,
      writeOutput: (message) => {
        output = message;
      },
      writeError: () => {},
      appendSummary: async (_env, block) => {
        stepSummary = block;
      },
    });
    expect(code).toBe(0);
    expect(output).toContain("Scope-growth diagnostics (bounded unknown): Wave 1: 1 issue.");
    expect(stepSummary).toBe(output);
  });

  it("issues no PATCH when the generated body is unchanged", async () => {
    let generated = "";
    const { request, requests } = createMainRequest({ roadmapBody: () => generated });
    const code = await main({
      env: mainEnv(),
      request,
      nowMs: NOW,
      writeOutput: (message) => {
        generated = message;
      },
      writeError: () => {},
    });
    expect(code).toBe(0);
    expect(generated).toContain("## Generated status");
    expect(requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it("clears all ambient roadmap variables and reaches the intended named env failure", async () => {
    const diagnostics = [];
    const code = await main({
      env: mainEnv({ GITHUB_TOKEN: "", GITHUB_REPOSITORY: "", ROADMAP_ISSUE: "" }),
      request: async () => {
        throw new Error("the env guard must fail before any request");
      },
      writeError: (message) => diagnostics.push(message),
    });
    expect(code).toBe(2);
    expect(diagnostics).toEqual(["ROADMAP_ENV_REQUIRED: GITHUB_REPOSITORY and GITHUB_TOKEN are required."]);
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

describe("scheduled workflow enforcement and registration", () => {
  it("keeps the default-branch scheduled generator enforcing with required permissions", () => {
    const workflowText = readFileSync(
      path.join(repoRoot, ".github", "workflows", "backlog-roadmap-status.yml"),
      "utf8",
    );
    const workflow = parseYaml(workflowText);
    const job = workflow.jobs.status;
    const checkout = job.steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    const generate = job.steps.find((step) => step.name === "Generate roadmap status");

    expect(workflow.on.schedule).toEqual([{ cron: "0 13 * * *" }]);
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read", issues: "write" });
    expect(job["continue-on-error"]).toBeUndefined();
    expect(checkout.with?.ref).toBeUndefined();
    expect(generate.run.trim()).toBe("node ./scripts/roadmap-status.mjs");
    expect(generate["continue-on-error"]).toBeUndefined();
    expect(generate.run).not.toMatch(/(?:^|\n)\s*exit\s+0\s*$/m);
    expect(releaseQualificationScopeRegistry.workflows["backlog-roadmap-status.yml"]).toBe("ci");
  });
});
