import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { classified } from "./backlog-classify.mjs";
import {
  collectEpicChildren,
  collectRoadmapIssueFacts,
  collectRoadmapWindowAuthority,
  collectMonthlyRefinedInventory,
  canonicalRefinedInventoryProbeBytes,
  collectScopeGrowth,
  deriveMonthlyRefinedInventoryWindow,
  END_MARKER,
  isEpic,
  main,
  mergeRoadmapIssueFacts,
  paginate,
  reducePriorRefinedInventoryAuthority,
  reconcileForecastIssueSources,
  reconcileEpicChildren,
  renderRoadmapStatus,
  renderRefinedInventoryCapMarker,
  resolveCurrentMilestoneEntry,
  RoadmapIssueEnumerationError,
  runRoadmapStatus,
  selectTimelineIssues,
  spliceIntoBody,
  START_MARKER,
  summarizeWaves,
  summarizePrioritizationHygiene,
  stabilizeRoadmapWindowAuthority,
  stabilizeMonthlyRefinedInventory,
  timelineFetchRequired,
  toBacklogInput,
  validateRefinedInventoryProbePayload,
} from "./roadmap-status.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-07-28T00:00:00Z");
const CUTOFF = Date.parse("2026-07-21T00:00:00Z");
const RECENT = "2026-07-26T00:00:00Z";
const OLD = "2026-06-01T00:00:00Z";
const STALE = "2026-07-20T23:59:59Z";
const outcomeDescription = (track, order, status = "committed") =>
  `<!-- outcome: ${JSON.stringify({ version: 1, track, order, status })} -->`;
const WAVE_1 = {
  number: 136,
  title: "Wave 1",
  description: outcomeDescription("wave", 1),
  state: "open",
  due_on: null,
};
const WAVE_2 = {
  number: 137,
  title: "Wave 2",
  description: outcomeDescription("wave", 2),
  state: "open",
  due_on: null,
};
const DEFERRED = { number: 146, title: "Deferred / Incubation", state: "open", due_on: null };
const OPERATIONS = { number: 147, title: "Operations", state: "open", due_on: null };

function slice(number, milestone, state, labels, created_at = OLD, overrides = {}) {
  return {
    number,
    milestone,
    state,
    labels: labels.map((name) => ({ name })),
    created_at,
    closed_at: state === "closed" ? "2026-07-20T00:00:00Z" : null,
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

function epicChildFixtures(count, { state = "closed", milestone = WAVE_1, startNumber = 10_000 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    number: startNumber + index,
    state,
    milestone,
  }));
}

function reconciledEpicCollection(children) {
  const count = children.length;
  return {
    children,
    capacity:
      count === 100
        ? { state: "saturated", count }
        : count >= 90
          ? { state: "warning", count, remaining: 100 - count }
          : { state: "normal", count },
  };
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

function windowMilestoneNode(milestone) {
  return {
    id: `SYNTHETIC_MILESTONE_${milestone.number}`,
    number: milestone.number,
    title: milestone.title,
    description: milestone.description ?? null,
    state: "OPEN",
  };
}

function windowIssueNode(issue) {
  const labels = issue.labels.map((label, index) => ({
    id: `SYNTHETIC_LABEL_${issue.number}_${index}`,
    name: label.name,
  }));
  const blockedBy = (issue.blockedBy ?? []).map((blocker) => ({
    id: blocker.id,
    number: blocker.number,
    state: blocker.state.toUpperCase(),
    repository: { nameWithOwner: blocker.repository.nameWithOwner },
  }));
  return {
    id: `SYNTHETIC_ISSUE_${issue.number}`,
    number: issue.number,
    state: "OPEN",
    issueType: issue.issueTypeName === null ? null : { name: issue.issueTypeName },
    milestone:
      issue.milestone === null
        ? null
        : {
            id: `SYNTHETIC_MILESTONE_${issue.milestone.number}`,
            number: issue.milestone.number,
            title: issue.milestone.title,
            state: issue.milestone.state.toUpperCase(),
          },
    issueDependenciesSummary: {
      blockedBy: issue.blockedByCount,
      totalBlockedBy: issue.blockedByCount,
    },
    labels: windowPage(labels),
    blockedBy: windowPage(blockedBy),
  };
}

function windowPage(nodes) {
  return { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes };
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
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("REFINED_INVENTORY_PRS_SENTINEL")) {
        return jsonResponse({
          data: {
            search: {
              issueCount: 0,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        });
      }
      if (query.includes("WINDOW_MILESTONES_SENTINEL")) {
        return jsonResponse({ data: { repository: { milestones: windowPage(milestones.map(windowMilestoneNode)) } } });
      }
      if (query.includes("WINDOW_ISSUES_SENTINEL")) {
        return jsonResponse({
          data: {
            repository: { issues: windowPage(issues.filter((issue) => issue.state === "open").map(windowIssueNode)) },
          },
        });
      }
      if (query.includes("WINDOW_LABELS_SENTINEL")) {
        const issue = issues.find((candidate) => `SYNTHETIC_ISSUE_${candidate.number}` === variables.id);
        const nodes = (issue?.labels ?? []).map((label, index) => ({
          id: `SYNTHETIC_LABEL_${issue?.number}_${index}`,
          name: label.name,
        }));
        return jsonResponse({ data: { node: { labels: windowPage(nodes) } } });
      }
      if (query.includes("WINDOW_BLOCKED_BY_SENTINEL")) {
        const issue = issues.find((candidate) => `SYNTHETIC_ISSUE_${candidate.number}` === variables.id);
        const nodes = (issue?.blockedBy ?? []).map((blocker) => ({
          id: blocker.id,
          number: blocker.number,
          state: blocker.state.toUpperCase(),
          repository: { nameWithOwner: blocker.repository.nameWithOwner },
        }));
        return jsonResponse({ data: { node: { blockedBy: windowPage(nodes) } } });
      }
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
      if (parsed.searchParams.get("state") !== "open") throw new Error("Unexpected closed-milestone fetch");
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

async function runMainFixture(options = {}) {
  const fixture = createMainRequest(options);
  const diagnostics = [];
  const generated = [];
  const summaries = [];
  const code = await runRoadmapStatus(
    () =>
      main({
        env: mainEnv(options.env),
        request: fixture.request,
        nowMs: NOW,
        writeOutput: (message) => generated.push(message),
        writeError: (message) => diagnostics.push(message),
        appendSummary: async (_env, block) => summaries.push(block),
      }),
    (message) => diagnostics.push(message),
  );
  return { ...fixture, code, diagnostics, generated, summaries };
}

function refinedPage(nodes, issueCount = nodes.length, pageInfo = { hasNextPage: false, endCursor: null }) {
  return { issueCount, pageInfo, nodes };
}

function refinedNode(number, mergedAt, baseRefName = "main") {
  return { number, mergedAt, baseRefName };
}

function capRecord(nowMs = NOW, overrides = {}) {
  const window = deriveMonthlyRefinedInventoryWindow(nowMs);
  return {
    schemaVersion: "roadmap-refined-inventory-cap/v1",
    generatedAt: new Date(nowMs).toISOString(),
    month: window.month,
    windowStart: window.windowStart,
    windowEndExclusive: window.windowEndExclusive,
    mergedPrCount: 0,
    cap: 0,
    identitySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ...overrides,
  };
}

describe("monthly refined-inventory cap authority", () => {
  it("derives the exact UTC half-open trailing-28-day query and canonical LF identity bytes", async () => {
    const nowMs = Date.parse("2026-08-30T18:45:00.000Z");
    const window = deriveMonthlyRefinedInventoryWindow(nowMs);
    expect(window).toEqual({
      month: "2026-08",
      windowStart: "2026-07-04T00:00:00.000Z",
      windowEndExclusive: "2026-08-01T00:00:00.000Z",
      query: "repo:chase-sets/chase-sets is:pr is:merged base:main merged:2026-07-04..2026-07-31",
    });
    const pages = [
      refinedPage([refinedNode(9, "2026-07-31T23:59:59.999Z"), refinedNode(2, "2026-07-04T00:00:00.000Z")], 3, {
        hasNextPage: true,
        endCursor: "page-2",
      }),
      refinedPage([refinedNode(5, "2026-07-18T12:34:56Z")], 3),
    ];
    const result = await collectMonthlyRefinedInventory({ window, loadPage: async () => pages.shift() });
    expect(result).toMatchObject({ pages: 2, count: 3 });
    expect(result.canonicalText).toBe(
      "2|2026-07-04T00:00:00.000Z|main\n5|2026-07-18T12:34:56.000Z|main\n9|2026-07-31T23:59:59.999Z|main",
    );
    expect(Buffer.from(result.canonicalText, "utf8").at(-1)).not.toBe(0x0a);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts 999 only after ten complete pages and fails closed at 1,000 and 1,001", async () => {
    const window = deriveMonthlyRefinedInventoryWindow(Date.parse("2026-08-30T00:00:00.000Z"));
    const rows = Array.from({ length: 999 }, (_, index) =>
      refinedNode(index + 1, `2026-07-${String(4 + (index % 28)).padStart(2, "0")}T00:00:00.000Z`),
    );
    let page = 0;
    const accepted = await collectMonthlyRefinedInventory({
      window,
      loadPage: async () => {
        const nodes = rows.slice(page * 100, (page + 1) * 100);
        page += 1;
        return refinedPage(nodes, 999, { hasNextPage: page < 10, endCursor: page < 10 ? `p${page + 1}` : null });
      },
    });
    expect(accepted).toMatchObject({ pages: 10, count: 999 });
    for (const total of [1_000, 1_001]) {
      await expect(
        collectMonthlyRefinedInventory({ window, loadPage: async () => refinedPage([], total) }),
      ).rejects.toMatchObject({ code: "ROADMAP_REFINED_INVENTORY_SEARCH_LIMIT" });
    }
  });

  it("rejects cursor/total/identity/time/base defects and stabilizes only consecutive equal full digests", async () => {
    const window = deriveMonthlyRefinedInventoryWindow(Date.parse("2026-08-30T00:00:00.000Z"));
    const valid = refinedNode(1, "2026-07-10T00:00:00.000Z");
    await expect(
      collectMonthlyRefinedInventory({
        window,
        loadPage: async (after) =>
          after === null
            ? refinedPage([valid], 2, { hasNextPage: true, endCursor: "same" })
            : refinedPage([refinedNode(2, "2026-07-11T00:00:00.000Z")], 3),
      }),
    ).rejects.toMatchObject({ code: "ROADMAP_REFINED_INVENTORY_TOTAL_CHANGED" });
    for (const invalid of [
      refinedNode(0, valid.mergedAt),
      refinedNode(1, "2026-08-01T00:00:00.000Z"),
      refinedNode(1, valid.mergedAt, "release"),
    ]) {
      await expect(
        collectMonthlyRefinedInventory({ window, loadPage: async () => refinedPage([invalid]) }),
      ).rejects.toMatchObject({ code: "ROADMAP_REFINED_INVENTORY_IDENTITY_INVALID" });
    }
    const attempts = ["a".repeat(64), "b".repeat(64), "b".repeat(64)];
    const stabilized = await stabilizeMonthlyRefinedInventory(async () => ({
      pages: 1,
      count: 1,
      digest: attempts.shift(),
      rows: [],
      canonicalText: "",
    }));
    expect(stabilized.acceptedAttempts).toEqual([2, 3]);
    expect(stabilized.attempts).toHaveLength(3);
    await expect(
      stabilizeMonthlyRefinedInventory(async (attempt) => ({
        pages: 1,
        count: 1,
        digest: String(attempt).repeat(64),
        rows: [],
        canonicalText: "",
      })),
    ).rejects.toMatchObject({ code: "ROADMAP_REFINED_INVENTORY_UNSTABLE" });
  });

  it("orders absent/current/prior/future/malformed marker reduction and recursively closes the compact record", () => {
    const current = capRecord();
    const marker = renderRefinedInventoryCapMarker(current);
    expect(reducePriorRefinedInventoryAuthority(`${START_MARKER}\n${END_MARKER}`, NOW).status).toBe("absent");
    expect(reducePriorRefinedInventoryAuthority(`${START_MARKER}\n${marker}\n${END_MARKER}`, NOW)).toEqual({
      status: "current",
      record: current,
      marker,
    });
    const prior = capRecord(Date.parse("2026-06-28T00:00:00.000Z"));
    expect(
      reducePriorRefinedInventoryAuthority(
        `${START_MARKER}\n${renderRefinedInventoryCapMarker(prior)}\n${END_MARKER}`,
        NOW,
      ).status,
    ).toBe("prior");
    const future = capRecord(Date.parse("2026-08-28T00:00:00.000Z"));
    expect(
      reducePriorRefinedInventoryAuthority(
        `${START_MARKER}\n${renderRefinedInventoryCapMarker(future)}\n${END_MARKER}`,
        NOW,
      ),
    ).toMatchObject({ status: "future", code: "ROADMAP_REFINED_INVENTORY_MARKER_FUTURE" });
    for (const body of [
      `${marker}\n${START_MARKER}\n${END_MARKER}`,
      `${START_MARKER}\n${marker}\n${marker}\n${END_MARKER}`,
      `${START_MARKER}\n${marker.replace('"cap":0', '"cap":1')}\n${END_MARKER}`,
      `${START_MARKER}\n${marker.replace("}", ',"nested":{"unknown":true}}')}\n${END_MARKER}`,
    ]) {
      expect(reducePriorRefinedInventoryAuthority(body, NOW).status).toBe("invalid");
    }
  });

  it("closes and canonicalizes the nonce/run/attempt/job/head/query authority payload", () => {
    const window = deriveMonthlyRefinedInventoryWindow(Date.parse("2026-08-30T00:00:00.000Z"));
    const digest = "a".repeat(64);
    const payload = {
      schemaVersion: "roadmap-refined-inventory-authority-probe/v1",
      repository: "chase-sets/chase-sets",
      workflow: "backlog-roadmap-status.yml",
      runId: 10,
      runAttempt: 1,
      jobId: 20,
      headSha: "b".repeat(40),
      nonce: "c".repeat(32),
      checkedAt: "2026-08-30T00:00:00.000Z",
      query: window.query,
      month: window.month,
      windowStart: window.windowStart,
      windowEndExclusive: window.windowEndExclusive,
      attempts: [
        { attempt: 1, pages: 10, count: 999, digest },
        { attempt: 2, pages: 10, count: 999, digest },
      ],
      acceptedAttempts: [1, 2],
      mergedPrCount: 999,
      cap: 1998,
      identitySha256: digest,
    };
    expect(validateRefinedInventoryProbePayload(payload)).toBe(true);
    expect(canonicalRefinedInventoryProbeBytes(payload)).toEqual(Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"));
    for (const mutant of [
      { ...payload, unknown: true },
      { ...payload, attempts: payload.attempts.map((attempt) => ({ ...attempt, unknown: true })) },
      { ...payload, acceptedAttempts: [2, 3] },
      { ...payload, cap: 1999 },
      { ...payload, nonce: "C".repeat(32) },
    ]) {
      expect(validateRefinedInventoryProbePayload(mutant)).toBe(false);
    }
  });
});

describe("roadmap publication authority", () => {
  it("ignores a legacy forecast record in the prior body", async () => {
    const legacyMarker = "<!-- roadmap-forecast-inputs:";
    for (const record of ['{"schemaVersion":"roadmap-forecast-inputs/v1"}', "not-json", ""]) {
      const result = await runMainFixture({
        roadmapBody: `intro\n${START_MARKER}\n${legacyMarker}${record} -->\n${END_MARKER}\noutro`,
      });
      expect(result.code).toBe(0);
      expect(result.diagnostics).toEqual([]);
      expect(result.generated).toHaveLength(1);
      const block = result.generated[0];
      expect(block).not.toContain(legacyMarker);
      expect(block).not.toMatch(/Forecast|Drift/);
      expect(block).toContain(
        "| Outcome | Slices | Done | Open | Refined | Parentless _(reported)_ | Tracking | Added (7d) | Epics done |",
      );
      expect(result.requests.filter(({ url }) => new URL(url).searchParams.get("state") === "closed")).toEqual([]);
      const patches = result.requests.filter(({ method }) => method === "PATCH");
      expect(patches).toHaveLength(1);
      expect(JSON.parse(patches[0].body).body).toBe(`intro\n${block}\noutro`);
    }
  });

  it("gives malformed open Wave shape exactly one diagnostic", async () => {
    const malformed = { number: 0, title: "", state: "wrong", due_on: "2026-08-01T00:00:00Z" };
    const result = await runMainFixture({ milestones: [malformed, WAVE_1] });
    expect(result.code).toBe(1);
    expect(result.diagnostics).toEqual([expect.stringMatching(/^OPEN_MILESTONE_SHAPE_INVALID:/)]);
    expect(result.generated).toEqual([]);
    expect(result.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it("fails open milestone state shape before due-date prohibition", async () => {
    const cases = [
      { ...WAVE_1, state: "closed", due_on: "2026-08-01T00:00:00Z" },
      { ...WAVE_1, due_on: "2026-08-01" },
      { number: WAVE_1.number, title: WAVE_1.title, state: "open" },
    ];
    for (const milestone of cases) {
      const result = await runMainFixture({ milestones: [milestone] });
      expect(result.diagnostics).toEqual([expect.stringMatching(/^OPEN_MILESTONE_SHAPE_INVALID:/)]);
      expect(result.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
    }
    const deferredDue = await runMainFixture({ milestones: [{ ...DEFERRED, due_on: "2026-08-01T00:00:00Z" }] });
    expect(deferredDue.diagnostics).toEqual([expect.stringMatching(/^OPEN_MILESTONE_DUE_DATE_PROHIBITED:/)]);
  });

  it("fails the scheduled collector closed beyond page one", async () => {
    const base = createMainRequest({ milestones: [WAVE_1] });
    const request = async (url, init) => {
      const parsed = new URL(url);
      if (
        parsed.pathname === "/repos/chase-sets/chase-sets/milestones" &&
        parsed.searchParams.get("state") === "open"
      ) {
        if (!parsed.searchParams.has("page")) {
          return jsonResponse([WAVE_1], {
            link: '<https://api.github.com/repos/chase-sets/chase-sets/milestones?state=open&per_page=100&page=2>; rel="next"',
          });
        }
        return jsonResponse([{ ...WAVE_2, due_on: "2026-08-01T00:00:00Z" }]);
      }
      return base.request(url, init);
    };
    const diagnostics = [];
    const generated = [];
    const candidateCode = await main({
      env: mainEnv(),
      request,
      nowMs: NOW,
      writeOutput: (value) => generated.push(value),
      writeError: (value) => diagnostics.push(value),
      appendSummary: async () => {},
    });
    expect(candidateCode).toBe(1);
    expect(diagnostics).toEqual([expect.stringMatching(/^OPEN_MILESTONE_DUE_DATE_PROHIBITED:/)]);
    expect(generated).toEqual([]);
    expect(base.requests.filter(({ method }) => method === "PATCH")).toEqual([]);

    const firstPageOnly = createMainRequest({ milestones: [WAVE_1] });
    expect(
      await main({
        env: mainEnv({ ROADMAP_ISSUE: "" }),
        request: firstPageOnly.request,
        nowMs: NOW,
        writeOutput: () => {},
        writeError: () => {},
        appendSummary: async () => {},
      }),
    ).toBe(0);
  });

  it("binds backlog-model outcome and scheduling contract", () => {
    const docs = readFileSync(path.join(repoRoot, "docs", "contributing", "backlog-model.md"), "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    for (const literal of [
      "Milestone = finite outcome membership and exit-gate closure",
      "Every executable slice belongs to exactly one committed outcome milestone",
      "Candidate milestones hold triaged future capabilities",
      "Open milestones have `due_on: null`",
      "stable GitHub milestone identity owns",
      "Malformed or duplicate metadata is an explicit error",
      "A milestone without outcome metadata is not",
      "Completion forecasting is owned by #7465.",
      "Outcome order** is agent-owned order within a named track",
      "Blocker** is a native correctness edge, never a scheduling opinion",
      "Dispatch rank** is agent-maintained issue order inside the selected outcome",
      "p0 interrupts an active lane only",
      "p1 wins an otherwise equal next-lane choice",
      "is ordinary work; p3 is opportunistic",
      "p3 is opportunistic",
      "drained merge queue with no sibling pull",
    ])
      expect(docs).toContain(literal);
  });

  it("binds Probe ladder lifecycle and authority boundaries to the documentation contract", () => {
    const docs = readFileSync(path.join(repoRoot, "docs", "contributing", "backlog-model.md"), "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    const lifecycleRequirements = [
      "time-boxed evidence gathering",
      "what a slice needs before dispatch",
      "evidence available only after its prerequisite has landed",
      "at the exact lifecycle boundary where the observed state exists",
    ];
    const authoritativeProbeContract = (markdown) => {
      const lines = markdown.split(/\r?\n/);
      const structuralLines = [];
      const rawHtmlUntilBlankTags = new Set(
        "address article aside blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul".split(
          " ",
        ),
      );
      let commentOpen = false;
      let fence;
      let rawHtmlClosingTag;
      let rawHtmlUntilBlank = false;

      const stripHtmlComments = (line) => {
        let visible = "";
        let cursor = 0;
        while (cursor < line.length) {
          if (commentOpen) {
            const close = line.indexOf("-->", cursor);
            if (close === -1) return visible;
            commentOpen = false;
            cursor = close + 3;
            continue;
          }

          const open = line.indexOf("<!--", cursor);
          const close = line.indexOf("-->", cursor);
          if (close !== -1 && (open === -1 || close < open)) throw new Error("Unmatched HTML comment close");
          if (open === -1) return visible + line.slice(cursor);
          visible += line.slice(cursor, open);
          commentOpen = true;
          cursor = open + 4;
        }
        return visible;
      };
      const closingFence = (line, activeFence) => {
        const match = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
        return match?.[1][0] === activeFence.marker && match[1].length >= activeFence.length;
      };

      for (const raw of lines) {
        if (fence) {
          structuralLines.push({ kind: "code", raw, visible: "" });
          if (closingFence(raw, fence)) fence = undefined;
          continue;
        }
        if (rawHtmlClosingTag) {
          structuralLines.push({ kind: "raw-html", raw, visible: "" });
          if (new RegExp(`</${rawHtmlClosingTag}\\s*>`, "i").test(raw)) rawHtmlClosingTag = undefined;
          continue;
        }
        if (rawHtmlUntilBlank) {
          if (raw.trim() === "") {
            rawHtmlUntilBlank = false;
            structuralLines.push({ kind: "normal", raw, visible: "" });
          } else {
            structuralLines.push({ kind: "raw-html", raw, visible: "" });
          }
          continue;
        }

        const visible = stripHtmlComments(raw);
        if (commentOpen && visible === "") {
          structuralLines.push({ kind: "invisible", raw, visible });
          continue;
        }
        const openingFence = visible.match(/^ {0,3}(`{3,}|~{3,})(?:[^`~]*)$/);
        if (openingFence) {
          fence = { marker: openingFence[1][0], length: openingFence[1].length };
          structuralLines.push({ kind: "code", raw, visible: "" });
          continue;
        }
        const closingTagBlock = visible.match(/^ {0,3}<(pre|script|style|textarea|code)(?=[\s>])/i)?.[1];
        if (closingTagBlock) {
          structuralLines.push({ kind: "raw-html", raw, visible: "" });
          if (!new RegExp(`</${closingTagBlock}\\s*>`, "i").test(visible)) rawHtmlClosingTag = closingTagBlock;
          continue;
        }
        const untilBlankTag = visible.match(/^ {0,3}<([A-Za-z][\w-]*)(?=[\s>])/i)?.[1]?.toLowerCase();
        const completeTagBlock = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[^>]*)?\/?>[ \t]*$/.test(visible);
        if (rawHtmlUntilBlankTags.has(untilBlankTag) || completeTagBlock) {
          rawHtmlUntilBlank = true;
          structuralLines.push({ kind: "raw-html", raw, visible: "" });
          continue;
        }
        if (/^(?: {4}|\t)/.test(visible)) {
          structuralLines.push({ kind: "code", raw, visible: "" });
          continue;
        }
        structuralLines.push({
          kind: visible.trim() === "" && raw.trim() !== "" ? "invisible" : "normal",
          raw,
          visible,
        });
      }
      if (commentOpen) throw new Error("Unclosed HTML comment");

      const headingText = ({ kind, visible }) =>
        kind === "normal" ? visible.match(/^ {0,3}##(?!#)[ \t]+(.+?)[ \t]*#*[ \t]*$/)?.[1] : undefined;
      const ladderHeadings = structuralLines
        .map((line, index) => ({ index, text: headingText(line) }))
        .filter(({ text }) => text === "The ladder");
      expect(ladderHeadings).toHaveLength(1);
      const ladderStart = ladderHeadings[0].index;
      const nextLevelTwoHeading = structuralLines.findIndex(
        (line, index) => index > ladderStart && headingText(line) !== undefined,
      );
      const ladderEnd = nextLevelTwoHeading === -1 ? structuralLines.length : nextLevelTwoHeading;

      const pipeCells = ({ kind, visible }) => {
        if (kind !== "normal") return undefined;
        const trimmed = visible.trim();
        if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return undefined;
        return trimmed
          .slice(1, -1)
          .split(/(?<!\\)\|/)
          .map((cell) => cell.trim());
      };
      const probeRows = [];
      for (let index = ladderStart + 1; index + 1 < ladderEnd; index += 1) {
        const headerCells = pipeCells(structuralLines[index]);
        const delimiterCells = pipeCells(structuralLines[index + 1]);
        if (
          !headerCells ||
          !delimiterCells ||
          headerCells.length !== delimiterCells.length ||
          !delimiterCells.every((cell) => /^:?-{3,}:?$/.test(cell))
        )
          continue;

        let tableEnd = index + 1;
        const tableProbeRows = [];
        for (let rowIndex = index + 2; rowIndex < ladderEnd; rowIndex += 1) {
          const cells = pipeCells(structuralLines[rowIndex]);
          if (!cells || cells.length !== headerCells.length) break;
          tableEnd = rowIndex;
          if (cells[0] === "**Probe**") tableProbeRows.push(rowIndex);
        }
        probeRows.push(...tableProbeRows.map((rowIndex) => ({ index: rowIndex, tableEnd })));
        index = tableEnd;
      }
      expect(probeRows).toHaveLength(1);
      const probe = probeRows[0];
      expect(probe.index).toBe(probe.tableEnd);
      const probeRow = structuralLines[probe.index].visible.trim();

      const paragraphAt = (start) => {
        if (structuralLines[start]?.kind !== "normal" || structuralLines[start].visible.trim() === "") return undefined;
        let end = start;
        while (
          end + 1 < ladderEnd &&
          structuralLines[end + 1].kind === "normal" &&
          structuralLines[end + 1].visible.trim() !== ""
        )
          end += 1;
        return {
          end,
          text: structuralLines
            .slice(start, end + 1)
            .map(({ visible: paragraphLine }) => paragraphLine)
            .join("\n")
            .trim(),
        };
      };
      const paragraphs = [];
      for (let index = ladderStart + 1; index < ladderEnd; index += 1) {
        const paragraph = paragraphAt(index);
        if (!paragraph) continue;
        paragraphs.push(paragraph);
        index = paragraph.end;
      }
      const authorityClosureParagraphs = paragraphs.filter(({ text: paragraph }) =>
        paragraph.startsWith("The **native GitHub issue type is the form of the work and is authoritative.**"),
      );
      expect(authorityClosureParagraphs).toHaveLength(1);
      const authorityClosureParagraph = authorityClosureParagraphs[0];
      let adjacentIndex = probe.index + 1;
      while (
        adjacentIndex < ladderEnd &&
        (structuralLines[adjacentIndex].kind === "invisible" ||
          (structuralLines[adjacentIndex].kind === "normal" && structuralLines[adjacentIndex].visible.trim() === ""))
      )
        adjacentIndex += 1;
      expect(paragraphAt(adjacentIndex)?.text).toBe(authorityClosureParagraph.text);
      return { probeRow, authorityClosureParagraph: authorityClosureParagraph.text };
    };
    const expectProbeContract = (markdown) => {
      const { probeRow, authorityClosureParagraph } = authoritativeProbeContract(markdown);
      for (const requirement of lifecycleRequirements) expect(probeRow).toContain(requirement);

      for (const literal of [
        "do not authorize an",
        "implementation result, staging/deploy verification, a provider or operator",
        "claim, or an ongoing-monitoring result",
        "exact authority, captured artifact, lifecycle moment, and bounded",
        "unknown/failure behavior",
        "post-landing evidence is not collected before the",
        "landed/deployed state it observes exists",
        "independent operator acceptance may close a Probe without a pull request only",
        "after that Probe's own acceptance criteria are met",
      ])
        expect(authorityClosureParagraph).toContain(literal);

      expect(authorityClosureParagraph).toMatch(/operator acceptance is a\s+closure control, not evidence authority/);
      expect(probeRow).not.toContain("what evidence a slice needs before dispatch | as surfaced");
      for (const forbiddenConflation of [
        "a generic Probe authorizes an implementation result",
        "post-landing evidence is collected before the landed/deployed state it observes exists",
      ])
        expect(authorityClosureParagraph).not.toContain(forbiddenConflation);
      expect(authorityClosureParagraph).not.toMatch(/operator acceptance is\s+evidence authority/);
    };

    expectProbeContract(docs);
    const { probeRow, authorityClosureParagraph } = authoritativeProbeContract(docs);
    const probeAndAuthority = `${probeRow}\n\n${authorityClosureParagraph}`;
    for (const requirement of lifecycleRequirements) {
      const withoutRequirement = docs.replace(probeRow, probeRow.replace(requirement, ""));
      expect(() => expectProbeContract(withoutRequirement)).toThrow();
      expect(() => expectProbeContract(`${withoutRequirement}\n<!-- ${requirement} -->`)).toThrow();
    }
    expect(() => expectProbeContract(docs.replace(probeRow, probeRow.replace("**Probe**", "**Decision**")))).toThrow();
    expect(() => expectProbeContract(docs.replace(probeRow, `${probeRow}\n${probeRow}`))).toThrow();
    expect(() =>
      expectProbeContract(
        docs
          .replace(probeRow, "")
          .replace("\n## What each GitHub primitive means", `\n${probeRow}\n\n## What each GitHub primitive means`),
      ),
    ).toThrow();
    expect(() => expectProbeContract(docs.replace(probeRow, `<!-- ${probeRow} -->`))).toThrow();
    expect(() => expectProbeContract(docs.replace(probeRow, `<!--\n${probeRow}\n-->`))).toThrow();
    expect(() => expectProbeContract(docs.replace(probeRow, `> ${probeRow}`))).toThrow();
    expect(() =>
      expectProbeContract(docs.replace(authorityClosureParagraph, `<!-- ${authorityClosureParagraph} -->`)),
    ).toThrow();
    expect(() =>
      expectProbeContract(docs.replace(authorityClosureParagraph, `<!--\n${authorityClosureParagraph}\n-->`)),
    ).toThrow();
    expect(() =>
      expectProbeContract(
        docs.replace(
          authorityClosureParagraph,
          authorityClosureParagraph
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        ),
      ),
    ).toThrow();
    expect(() =>
      expectProbeContract(
        docs
          .replace(authorityClosureParagraph, "")
          .replace(
            "\n## What each GitHub primitive means",
            `\n${authorityClosureParagraph}\n\n## What each GitHub primitive means`,
          ),
      ),
    ).toThrow();
    expect(() =>
      expectProbeContract(
        docs.replace(
          probeAndAuthority,
          `${probeRow}\n\nUnrelated visible adjacency text.\n\n${authorityClosureParagraph}`,
        ),
      ),
    ).toThrow();
    expect(() =>
      expectProbeContract(docs.replace(probeAndAuthority, `\`\`\`markdown\n${probeAndAuthority}\n\`\`\``)),
    ).toThrow();
    expect(() => expectProbeContract(docs.replace(probeAndAuthority, `<pre>\n${probeAndAuthority}\n</pre>`))).toThrow();
    expect(() =>
      expectProbeContract(
        docs.replace(
          probeAndAuthority,
          probeAndAuthority
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n"),
        ),
      ),
    ).toThrow();
    expect(() => expectProbeContract(docs.replace(probeAndAuthority, `<!--\n${probeAndAuthority}`))).toThrow();
    expect(() => expectProbeContract(docs.replace(probeRow, `-->\n${probeRow}`))).toThrow();

    const weakenedRealLadder = docs.replace(
      probeRow,
      probeRow.replace("time-boxed evidence gathering", "evidence gathering"),
    );
    const duplicateHeadingMask = [
      "## The ladder",
      "",
      "| Level | Lives in | Answers | Changes |",
      "|---|---|---|---|",
      probeRow,
      "",
      authorityClosureParagraph,
      "",
      "## The ladder",
    ].join("\n");
    expect(() => expectProbeContract(weakenedRealLadder.replace("## The ladder", duplicateHeadingMask))).toThrow();

    expectProbeContract(
      docs.replace(
        probeAndAuthority,
        `${probeRow}\n<!--\n## The ladder\n${probeRow}\ninvisible adjacency note\n-->\n\n${authorityClosureParagraph}`,
      ),
    );
  });

  it("exhausts every paginated authority before rendering or patching", async () => {
    const seen = [];
    const pages = new Map([
      ["/start", { body: [1], link: '<https://api.github.com/page-2>; rel="next"' }],
      ["/page-2", { body: [2] }],
    ]);
    const result = await paginate("https://api.github.com/start", "token", async (url) => {
      const parsed = new URL(url);
      seen.push(parsed.pathname);
      const page = pages.get(parsed.pathname);
      return jsonResponse(page.body, { link: page.link });
    });
    expect(result).toEqual([1, 2]);
    expect(seen).toEqual(["/start", "/page-2"]);
  });

  it("fails incomplete enumeration before publishing any roadmap block", async () => {
    await expect(
      paginate("https://api.github.com/start", "token", async () => jsonResponse({}, {})),
    ).rejects.toMatchObject({ code: "ROADMAP_PAGINATION_PAGE_INVALID" });
    await expect(
      paginate("https://api.github.com/start", "token", async () =>
        jsonResponse([], { link: '<https://attacker.invalid/page-2>; rel="next"' }),
      ),
    ).rejects.toMatchObject({ code: "ROADMAP_PAGINATION_LINK_INVALID" });
  });

  it("fails exact issue-source reconciliation on invalid duplicate omitted and added numbers", async () => {
    const facts = new Map([
      [1, {}],
      [2, {}],
    ]);
    Object.defineProperty(facts, "sourceNumbers", { value: [1, 2] });
    expect(() => reconcileForecastIssueSources([{ number: 1 }, { number: 2 }], facts)).not.toThrow();
    for (const rest of [
      [{ number: 1 }, { number: 1 }],
      [{ number: 1 }, { number: 3 }],
      [{ number: 0 }, { number: 2 }],
      [{ number: 1.5 }, { number: 2 }],
      [{ number: Number.MAX_SAFE_INTEGER + 1 }, { number: 2 }],
    ]) {
      expect(() => reconcileForecastIssueSources(rest, facts)).toThrowError(
        expect.objectContaining({ code: "ROADMAP_ISSUE_SOURCE_COUNT_MISMATCH" }),
      );
    }

    const invalid = slice(1.5, WAVE_1, "open", ["kind:product"]);
    const mainResult = await runMainFixture({ issues: [invalid] });
    expect(mainResult.code).toBe(1);
    expect(mainResult.diagnostics).toEqual([expect.stringMatching(/^ROADMAP_ISSUE_SOURCE_COUNT_MISMATCH:/)]);
    expect(mainResult.generated).toEqual([]);
    expect(mainResult.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });
});

describe("roadmap status classification and preserved rollups", () => {
  it("preserves every non-forecast cell and row order on a fixed tagged fixture", () => {
    const first = { ...WAVE_1, description: outcomeDescription("commerce", 100) };
    const later = { ...WAVE_2, description: outcomeDescription("commerce", 300) };
    const candidate = {
      ...WAVE_2,
      number: 999,
      title: "Candidate",
      description: outcomeDescription("commerce", 200, "candidate"),
    };
    const issues = [
      slice(1, first, "closed", ["kind:product"]),
      slice(2, first, "open", ["priority:p1", "area:ops", "kind:ops"], RECENT),
      slice(3, first, "open", ["kind:product"]),
      slice(4, first, "open", ["status:tracking-only"]),
      slice(5, candidate, "open", ["kind:product"]),
      slice(6, later, "open", ["priority:p1", "area:ops", "kind:ops"], OLD, { hasParent: true }),
      epic(10, 1),
    ];
    const growth = knownGrowth(issues);
    growth.delete(6);
    const markdown = renderRoadmapStatus(
      summarizeWaves({
        milestones: [later, OPERATIONS, candidate, first],
        issues,
        epicChildren: new Map([[10, reconciledEpicCollection([{ number: 1, state: "closed", milestone: first }])]]),
        scopeGrowthByIssue: growth,
        nowMs: NOW,
      }),
    );
    const table = markdown
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    const retained = table[0]
      .map((name, index) => ({ name, index }))
      .filter(({ name }) => !["Forecast", "Drift"].includes(name));
    expect([table[0], ...table.slice(2)].map((row) => retained.map(({ index }) => row[index]))).toEqual([
      [
        "Outcome",
        "Slices",
        "Done",
        "Open",
        "Refined",
        "Parentless _(reported)_",
        "Tracking",
        "Added (7d)",
        "Epics done",
      ],
      ["Wave 1", "3", "1 (33%)", "2", "1/2", "1", "1", "+1", "1/1"],
      ["Candidate _(not executable)_", "1", "0 (0%)", "1", "—", "—", "0", "—", "—"],
      ["Wave 2", "1", "0 (0%)", "1", "1/1", "0", "0", "?", "—"],
      ["Operations _(not executable)_", "0", "0 (0%)", "0", "—", "—", "0", "—", "—"],
    ]);
  });

  it("orders managed outcomes and preserves candidate inventory without execution authority", () => {
    const first = {
      number: 900,
      title: "Renamed first outcome",
      description: outcomeDescription("commerce", 100),
      state: "open",
      due_on: null,
    };
    const candidate = {
      number: 100,
      title: "Candidate inserted outcome",
      description: outcomeDescription("commerce", 150, "candidate"),
      state: "open",
      due_on: null,
    };
    const later = {
      number: 10,
      title: "Later outcome",
      description: outcomeDescription("commerce", 200),
      state: "open",
      due_on: null,
    };
    const issues = [
      slice(1, { ...first, title: "Old first title" }, "open", ["priority:p1", "area:ops", "kind:ops"]),
      slice(2, candidate, "open", ["priority:p1", "area:ops", "kind:ops"]),
      slice(4, candidate, "closed", ["priority:p1", "area:ops", "kind:ops"]),
      slice(5, candidate, "open", ["status:tracking-only"]),
      slice(3, later, "open", ["priority:p1", "area:ops", "kind:ops"]),
    ];
    const summary = summarizeWaves({
      milestones: [later, candidate, first],
      issues,
      scopeGrowthByIssue: new Map([
        [1, { status: "known", enteredAtMs: null }],
        [3, { status: "known", enteredAtMs: null }],
      ]),
      nowMs: NOW,
    });
    expect(summary.rows.map(({ title }) => title)).toEqual([first.title, candidate.title, later.title]);
    expect(summary.rows[0]).toMatchObject({ total: 1, open: 1, refinedOpen: 1, executable: true });
    expect(summary.rows[1]).toMatchObject({
      total: 2,
      open: 1,
      closed: 1,
      refinedOpen: 0,
      tracking: 1,
      executable: false,
      addedRecently: 0,
      growthUnknown: 0,
      epicsComplete: 0,
    });
    expect(renderRoadmapStatus(summary)).toContain(`${candidate.title} _(not executable)_`);
    expect(renderRoadmapStatus(summary)).toContain(
      `| ${candidate.title} _(not executable)_ | 2 | 1 (50%) | 1 | — | — | 1 | — | — |`,
    );
    expect(renderRoadmapStatus(summary)).toContain(`| ${first.title} |`);
  });

  it("identifies epics and delegates classification to the shared predicate", () => {
    expect(isEpic(slice(1, WAVE_1, "open", ["kind:epic"], OLD, { issueTypeName: null }))).toBe(true);
    expect(isEpic(slice(2, WAVE_1, "open", ["kind:product"]))).toBe(false);
    expect(isEpic(slice(6, WAVE_1, "open", ["kind:epic"], OLD, { issueTypeName: "Slice" }))).toBe(false);

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

  it("reports an epic in every outcome where its reconciled children contribute", () => {
    const issues = [epic(10, 2), epic(11, 1)];
    const epicChildren = new Map([
      [
        10,
        reconciledEpicCollection([
          { number: 20, state: "closed", milestone: WAVE_2 },
          { number: 21, state: "closed", milestone: WAVE_1 },
        ]),
      ],
      [11, reconciledEpicCollection([{ number: 22, state: "open", milestone: WAVE_2 }])],
    ]);
    const { rows } = summarizeWaves({
      milestones: [WAVE_1, WAVE_2],
      issues,
      epicChildren,
      scopeGrowthByIssue: new Map(),
      nowMs: NOW,
    });
    expect(rows[0]).toMatchObject({ epicsTotal: 1, epicsComplete: 1 });
    expect(rows[1]).toMatchObject({ epicsTotal: 2, epicsComplete: 1 });
  });

  it("never counts a childless epic as complete", () => {
    const issues = [epic(10, 0)];
    const { rows } = summarizeWaves({
      milestones: [WAVE_1],
      issues,
      epicChildren: new Map([[10, reconciledEpicCollection([])]]),
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
    expect(markdown).toContain("| Deferred / Incubation _(not executable)_ | 1 |");
    expect(markdown).toContain("| Operations _(not executable)_ | 1 |");
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

  it("preserves parent attachment output byte for byte", () => {
    const markdown = renderRoadmapStatus({
      rows: [
        {
          title: WAVE_1.title,
          executable: true,
          total: 3,
          closed: 0,
          open: 3,
          percent: 0,
          addedRecently: 0,
          growthUnknown: 0,
          refinedOpen: 2,
          parentlessClassified: 2,
          tracking: 4,
          epicsTotal: 0,
          epicsComplete: 0,
          epicsBoundedUnknown: false,
        },
      ],
      windowDays: 7,
    });
    const parentLine = markdown.split("\n").find((line) => line.startsWith("Parent attachment"));
    expect(parentLine).toBe(
      "Parent attachment (reported, not gating): **2 classified slices have no parent**. 4 tracking-only records are shown separately.",
    );
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

  it("uses the final membership transition when a milestone was renamed", () => {
    const issue = slice(4, WAVE_1, "open", ["kind:product"], OLD, { updated_at: RECENT });
    const entry = resolveCurrentMilestoneEntry(issue, [
      { event: "milestoned", milestone: { title: "Wave One (old title)" }, created_at: RECENT },
    ]);
    expect(entry).toEqual({ status: "known", enteredAtMs: Date.parse(RECENT), source: "latest-milestoned-event" });

    const { rows } = summarizeWaves({
      milestones: [WAVE_1],
      issues: [issue],
      scopeGrowthByIssue: new Map([[issue.number, entry]]),
      nowMs: NOW,
    });
    const markdown = renderRoadmapStatus({ rows, windowDays: 7 });
    expect(rows[0]).toMatchObject({ addedRecently: 1, growthUnknown: 0 });
    expect(markdown).toContain("| Wave 1 | 1 | 0 (0%) | 1 | 0/1 | 0 | 0 | +1 |");
    expect(markdown).not.toContain("Scope-growth diagnostics (bounded unknown)");
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
    ).toEqual({ status: "known", enteredAtMs: Date.parse(RECENT), source: "latest-milestoned-event" });
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
    expect(byEpic.get(100)).toEqual({
      children: [
        { number: 101, state: "open", milestone: WAVE_2 },
        { number: 102, state: "closed", milestone: WAVE_1 },
      ],
      capacity: { state: "normal", count: 2 },
    });
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
    expect(() => reconcileEpicChildren(epic(5, 101), epicChildFixtures(101))).toThrowError(
      expect.objectContaining({ code: "ROADMAP_EPIC_CHILD_TOTAL_INVALID" }),
    );
  });

  it.each([
    ["warning", 90, -1],
    ["warning", 90, 0],
    ["warning", 90, Number.MAX_SAFE_INTEGER + 1],
    ["saturated", 100, -1],
    ["saturated", 100, 0],
    ["saturated", 100, Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a %s collection with an invalid child identity", (_boundary, total, invalidNumber) => {
    const children = epicChildFixtures(total);
    children[children.length - 1] = { ...children[children.length - 1], number: invalidNumber };
    expect(() => reconcileEpicChildren(epic(501, total), children)).toThrowError(
      expect.objectContaining({ code: "ROADMAP_EPIC_CHILD_PAGE_INVALID" }),
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

  it("reconciles before classifying epic capacity at 89 90 99 and 100", async () => {
    const cases = [
      { count: 89, capacity: { state: "normal", count: 89 }, diagnostic: null, epics: "1/1" },
      {
        count: 90,
        capacity: { state: "warning", count: 90, remaining: 10 },
        diagnostic: "#500 90/100 (10 remaining)",
        epics: "1/1",
      },
      {
        count: 99,
        capacity: { state: "warning", count: 99, remaining: 1 },
        diagnostic: "#500 99/100 (1 remaining)",
        epics: "1/1",
      },
      {
        count: 100,
        capacity: { state: "saturated", count: 100 },
        diagnostic: "#500 100/100 (saturated; child inventory bounded unknown)",
        epics: "?/1",
      },
    ];

    for (const boundary of cases) {
      const target = epic(500, boundary.count);
      const collected = await collectEpicChildren({
        epics: [target],
        loadChildren: async () => epicChildFixtures(boundary.count),
      });
      const summary = summarizeWaves({
        milestones: [WAVE_1],
        issues: [target],
        epicChildren: collected,
        scopeGrowthByIssue: new Map(),
        nowMs: NOW,
      });
      const markdown = renderRoadmapStatus(summary);

      expect(collected.get(500)?.capacity).toEqual(boundary.capacity);
      expect(summary.rows[0]).toMatchObject({ epicsTotal: 1, epicsBoundedUnknown: boundary.count === 100 });
      expect(markdown).toContain(`| ${boundary.epics} |`);
      if (boundary.diagnostic) expect(markdown).toContain(boundary.diagnostic);
      else expect(markdown).not.toContain("#500 ");
    }

    const orderedTargets = [epic(700, 99), epic(600, 90), epic(650, 89)];
    const orderedCollections = await collectEpicChildren({
      epics: orderedTargets,
      loadChildren: async (target) => epicChildFixtures(target.sub_issues_summary.total),
    });
    const orderedMarkdown = renderRoadmapStatus(
      summarizeWaves({
        milestones: [WAVE_1],
        issues: orderedTargets,
        epicChildren: orderedCollections,
        scopeGrowthByIssue: new Map(),
        nowMs: NOW,
      }),
    );
    expect(orderedMarkdown.indexOf("#600 90/100 (10 remaining)")).toBeLessThan(
      orderedMarkdown.indexOf("#700 99/100 (1 remaining)"),
    );
    expect(orderedMarkdown).not.toContain("#650 ");
  });

  it("saturated all-closed epic publishes bounded unknown through wave rollup", async () => {
    const target = epic(501, 100);
    const returnedChildren = epicChildFixtures(100);
    const intendedSynthetic101stChild = {
      number: 99_999,
      state: "open",
      milestone: WAVE_1,
      syntheticControl: "intended attachment outside provider-returned collection",
    };
    const collected = await collectEpicChildren({
      epics: [target],
      loadChildren: async () => returnedChildren,
    });
    const summary = summarizeWaves({
      milestones: [WAVE_1],
      issues: [target],
      epicChildren: collected,
      scopeGrowthByIssue: new Map(),
      nowMs: NOW,
    });
    const markdown = renderRoadmapStatus(summary);

    expect(returnedChildren).toHaveLength(100);
    expect(collected.get(501)?.children.some((child) => child.number === intendedSynthetic101stChild.number)).toBe(
      false,
    );
    expect(summary.rows[0]).toMatchObject({
      epicsTotal: 1,
      epicsComplete: 0,
      epicsBoundedUnknown: true,
    });
    expect(markdown).toContain("#501 100/100 (saturated; child inventory bounded unknown)");
    expect(markdown).toContain("| ?/1 |");
    expect(markdown).not.toContain("| 1/1 |");

    const knownComplete = epic(502, 1);
    const mixedCollections = await collectEpicChildren({
      epics: [target, knownComplete],
      loadChildren: async (candidate) =>
        candidate.number === target.number ? returnedChildren : epicChildFixtures(1, { startNumber: 20_000 }),
    });
    const mixedSummary = summarizeWaves({
      milestones: [WAVE_1],
      issues: [target, knownComplete],
      epicChildren: mixedCollections,
      scopeGrowthByIssue: new Map(),
      nowMs: NOW,
    });
    expect(mixedSummary.rows[0]).toMatchObject({ epicsTotal: 2, epicsComplete: 1, epicsBoundedUnknown: true });
    expect(renderRoadmapStatus(mixedSummary)).toContain("| ?/2 |");
  });
});

describe("real main composition", () => {
  it("preserves a current-month cap marker without PR acquisition while refreshing the canonical refined numerator", async () => {
    const record = capRecord();
    const marker = renderRefinedInventoryCapMarker(record);
    const issue = slice(700, WAVE_1, "open", ["priority:p1", "area:ops", "kind:ops"]);
    const result = await runMainFixture({
      issues: [issue],
      roadmapBody: `${START_MARKER}\nstale numerator\n${marker}\n${END_MARKER}`,
    });
    const searchRequests = result.requests.filter(({ body }) => body?.includes("REFINED_INVENTORY_PRS_SENTINEL"));
    const patches = result.requests.filter(({ method }) => method === "PATCH");
    const patchedBody = JSON.parse(patches[0].body).body;

    expect(result.code).toBe(0);
    expect(searchRequests).toEqual([]);
    expect(patches).toHaveLength(1);
    expect(result.generated[0]).toContain(
      `Refined inventory: 1 / cap 0 (authority ${record.month}; merged-PR window ${record.windowStart}..${record.windowEndExclusive})`,
    );
    expect(patchedBody.match(/<!-- roadmap-refined-inventory-cap:[^\n]+ -->/g)).toEqual([marker]);
  });

  it("fails a live-source-omitted acquisition closed before PATCH", async () => {
    const base = createMainRequest();
    const request = async (url, init = {}) => {
      if (
        new URL(url).pathname === "/graphql" &&
        JSON.parse(init.body).query.includes("REFINED_INVENTORY_PRS_SENTINEL")
      ) {
        return jsonResponse({ data: {} });
      }
      return base.request(url, init);
    };
    const diagnostics = [];
    const code = await main({
      env: mainEnv(),
      request,
      nowMs: NOW,
      writeOutput: () => {},
      writeError: (message) => diagnostics.push(message),
    });
    expect(code).toBe(1);
    expect(diagnostics).toEqual([expect.stringMatching(/^ROADMAP_REFINED_INVENTORY_PAGE_INVALID:/)]);
    expect(base.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it("leaves the entire prior-month body untouched when rollover acquisition reaches the provider ceiling", async () => {
    const prior = capRecord(Date.parse("2026-06-28T00:00:00.000Z"));
    const body = `intro\n${START_MARKER}\nold line\n${renderRefinedInventoryCapMarker(prior)}\n${END_MARKER}\noutro`;
    const base = createMainRequest({ roadmapBody: body });
    const request = async (url, init = {}) => {
      if (
        new URL(url).pathname === "/graphql" &&
        JSON.parse(init.body).query.includes("REFINED_INVENTORY_PRS_SENTINEL")
      ) {
        return jsonResponse({
          data: {
            search: refinedPage([], 1_000),
          },
        });
      }
      return base.request(url, init);
    };
    const code = await main({ env: mainEnv(), request, nowMs: NOW, writeOutput: () => {}, writeError: () => {} });
    expect(code).toBe(1);
    expect(base.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
    expect(body).toContain(renderRefinedInventoryCapMarker(prior));
  });

  it("refuses a valid future-month marker before acquisition or PATCH", async () => {
    const future = capRecord(Date.parse("2026-08-28T00:00:00.000Z"));
    const body = `${START_MARKER}\n${renderRefinedInventoryCapMarker(future)}\n${END_MARKER}`;
    const result = await runMainFixture({ roadmapBody: body });
    expect(result.code).toBe(1);
    expect(result.diagnostics).toEqual([expect.stringMatching(/^ROADMAP_REFINED_INVENTORY_MARKER_FUTURE:/)]);
    expect(
      result.requests.some(({ body: requestBody }) => requestBody?.includes("REFINED_INVENTORY_PRS_SENTINEL")),
    ).toBe(false);
    expect(result.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it("publishes the collected pull-window summary identically to stdout, step summary, and PATCH", async () => {
    const wave1Runnable = slice(701, WAVE_1, "open", ["priority:p1", "area:ops", "kind:ops"]);
    const staleP0 = slice(702, WAVE_2, "open", ["priority:p0"]);
    const staleP1 = slice(703, WAVE_2, "open", ["priority:p1"]);
    const result = await runMainFixture({
      milestones: [
        WAVE_1,
        WAVE_2,
        { number: 138, title: "Mobile 1", description: outcomeDescription("mobile", 1), state: "open", due_on: null },
      ],
      issues: [wave1Runnable, staleP1, staleP0],
    });
    const patches = result.requests.filter(({ method }) => method === "PATCH");
    const patchedBody = JSON.parse(patches[0].body).body;
    const patchBlock = patchedBody.slice(
      patchedBody.indexOf(START_MARKER),
      patchedBody.indexOf(END_MARKER) + END_MARKER.length,
    );

    expect(result.code).toBe(0);
    expect(patches).toHaveLength(1);
    expect(result.generated).toHaveLength(1);
    expect(result.summaries).toEqual(result.generated);
    expect(patchBlock).toBe(result.generated[0]);
    expect(result.generated[0]).toContain("## Prioritization hygiene");
    expect(result.generated[0]).toContain("Pull window: Wave 1.");
    expect(result.generated[0]).toContain("Stale preemption/tie claims: **2 total** — **1 p0**, **1 p1**.");
    expect(result.generated[0]).toContain("- #702 priority:p0 — Wave 2");
    expect(result.generated[0]).toContain("- #703 priority:p1 — Wave 2");
  });

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

  it("preserves epic child errors and publishes nothing at warning and cap boundaries", async () => {
    const warningDuplicate = epicChildFixtures(90);
    warningDuplicate[89] = { ...warningDuplicate[0] };
    const saturatedDuplicate = epicChildFixtures(100);
    saturatedDuplicate[99] = { ...saturatedDuplicate[0] };
    const matrix = [
      {
        target: epic(590, 90),
        children: epicChildFixtures(89),
        code: "ROADMAP_EPIC_CHILD_COUNT_MISMATCH",
      },
      { target: epic(591, 90), children: warningDuplicate, code: "ROADMAP_EPIC_CHILD_COUNT_MISMATCH" },
      {
        target: epic(592, 100),
        children: epicChildFixtures(99),
        code: "ROADMAP_EPIC_CHILD_COUNT_MISMATCH",
      },
      { target: epic(593, 100), children: saturatedDuplicate, code: "ROADMAP_EPIC_CHILD_COUNT_MISMATCH" },
      {
        target: epic(594, 90, { sub_issues_summary: { total: "90" } }),
        children: epicChildFixtures(90),
        code: "ROADMAP_EPIC_CHILD_TOTAL_INVALID",
      },
      {
        target: epic(595, 90),
        children: [...epicChildFixtures(89), { state: "closed", milestone: WAVE_1 }],
        code: "ROADMAP_EPIC_CHILD_PAGE_INVALID",
      },
    ];

    for (const failure of matrix) {
      const result = await runMainFixture({
        issues: [failure.target],
        childrenByEpic: new Map([[failure.target.number, failure.children]]),
      });
      expect(result.code).toBe(1);
      expect(result.diagnostics).toEqual([expect.stringMatching(new RegExp(`^${failure.code}:`))]);
      expect(result.generated).toEqual([]);
      expect(result.summaries).toEqual([]);
      expect(result.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
    }
  });

  it("rejects an over-cap real main collection before publishing anything", async () => {
    const target = epic(597, 101);
    const result = await runMainFixture({
      issues: [target],
      childrenByEpic: new Map([[target.number, epicChildFixtures(101)]]),
    });

    expect(result.code).toBe(1);
    expect(result.diagnostics).toEqual([expect.stringMatching(/^ROADMAP_EPIC_CHILD_TOTAL_INVALID:/)]);
    expect(result.generated).toEqual([]);
    expect(result.summaries).toEqual([]);
    expect(result.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it.each([
    ["warning", 90, -1],
    ["warning", 90, 0],
    ["warning", 90, Number.MAX_SAFE_INTEGER + 1],
    ["saturated", 100, -1],
    ["saturated", 100, 0],
    ["saturated", 100, Number.MAX_SAFE_INTEGER + 1],
  ])("publishes nothing for a %s collection with invalid child number %s", async (_boundary, total, invalidNumber) => {
    const target = epic(598, total);
    const children = epicChildFixtures(total);
    children[children.length - 1] = { ...children[children.length - 1], number: invalidNumber };
    const result = await runMainFixture({
      issues: [target],
      childrenByEpic: new Map([[target.number, children]]),
    });

    expect(result.code).toBe(1);
    expect(result.diagnostics).toEqual([expect.stringMatching(/^ROADMAP_EPIC_CHILD_PAGE_INVALID:/)]);
    expect(result.generated).toEqual([]);
    expect(result.summaries).toEqual([]);
    expect(result.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it("publishes one identical saturation block to stdout step summary and roadmap issue", async () => {
    const target = epic(596, 100);
    const result = await runMainFixture({
      issues: [target],
      childrenByEpic: new Map([[target.number, epicChildFixtures(100)]]),
      roadmapBody: `intro\n${START_MARKER}\nstale\n${END_MARKER}\noutro`,
    });
    const patches = result.requests.filter(({ method }) => method === "PATCH");
    expect(patches).toHaveLength(1);
    const patchedBody = JSON.parse(patches[0].body).body;
    const patchBlock = patchedBody.slice(
      patchedBody.indexOf(START_MARKER),
      patchedBody.indexOf(END_MARKER) + END_MARKER.length,
    );

    expect(result.code).toBe(0);
    expect(result.generated).toHaveLength(1);
    expect(result.summaries).toEqual(result.generated);
    expect(patchBlock).toBe(result.generated[0]);
    expect(result.generated[0]).toContain("#596 100/100 (saturated; child inventory bounded unknown)");
    expect(result.generated[0]).toContain("| ?/1 |");
  });

  it("writes counted bounded-unknown diagnostics to stdout and the step summary", async () => {
    const issue = slice(200, WAVE_1, "open", ["kind:product"], OLD, { updated_at: RECENT });
    const { request } = createMainRequest({
      issues: [issue],
      timelinesByIssue: new Map([
        [200, [{ event: "demilestoned", milestone: { title: "Wave 1 (old title)" }, created_at: RECENT }]],
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
    const first = createMainRequest();
    expect(
      await main({
        env: mainEnv({ ROADMAP_ISSUE: "" }),
        request: first.request,
        nowMs: NOW,
        writeOutput: (message) => {
          generated = message;
        },
        writeError: () => {},
      }),
    ).toBe(0);
    let steady = "";
    const second = createMainRequest({ roadmapBody: generated });
    expect(
      await main({
        env: mainEnv(),
        request: second.request,
        nowMs: NOW,
        writeOutput: (message) => {
          steady = message;
        },
        writeError: () => {},
      }),
    ).toBe(0);
    const { request, requests } = createMainRequest({ roadmapBody: steady });
    const code = await main({
      env: mainEnv(),
      request,
      nowMs: NOW,
      writeOutput: (message) => expect(message).toBe(steady),
      writeError: () => {},
    });
    expect(code).toBe(0);
    expect(steady).toContain("## Generated status");
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
    expect(diagnostics).toEqual([
      "ROADMAP_GITHUB_TOKEN_REQUIRED: GITHUB_TOKEN is required before provider or issue actions.",
    ]);
  });
});

describe("prioritization hygiene authority", () => {
  function completePage(nodes, totalCount = nodes.length) {
    return { totalCount, pageInfo: { hasNextPage: false, endCursor: null }, nodes };
  }

  function windowLoaders({ reverse = false, labelTotal = 3 } = {}) {
    const milestone = {
      id: "synthetic-milestone-wave-1",
      number: 1,
      title: "Wave 1",
      description: outcomeDescription("wave", 1),
      state: "OPEN",
    };
    const labels = [
      { id: "synthetic-label-priority", name: "priority:p1" },
      { id: "synthetic-label-area", name: "area:ops" },
      { id: "synthetic-label-kind", name: "kind:ops" },
    ];
    const issue = {
      id: "synthetic-issue-1",
      number: 1,
      state: "OPEN",
      issueType: { name: "Slice" },
      milestone: { id: milestone.id, number: milestone.number, title: milestone.title, state: milestone.state },
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
      labels: completePage(reverse ? labels.slice().reverse() : labels, labelTotal),
      blockedBy: completePage([]),
    };
    return {
      loadMilestones: async () => completePage(reverse ? [milestone].reverse() : [milestone]),
      loadIssues: async () => completePage([issue]),
      loadLabels: async () => completePage(reverse ? labels.slice().reverse() : labels, labelTotal),
      loadBlockedBy: async () => completePage([]),
    };
  }

  function pagedWindowLoaders({ labels, blockedBy = [], labelPages = null, blockedByPages = null } = {}) {
    const milestone = {
      id: "synthetic-milestone-wave-1",
      number: 1,
      title: "Wave 1",
      description: outcomeDescription("wave", 1),
      state: "OPEN",
    };
    const completeLabels = labels ?? [
      { id: "synthetic-label-priority", name: "priority:p1" },
      { id: "synthetic-label-area", name: "area:ops" },
      { id: "synthetic-label-kind", name: "kind:ops" },
    ];
    const issue = {
      id: "synthetic-issue-1",
      number: 1,
      state: "OPEN",
      issueType: { name: "Slice" },
      milestone: { id: milestone.id, number: milestone.number, title: milestone.title, state: milestone.state },
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
      labels: labelPages?.root ?? completePage(completeLabels),
      blockedBy: blockedByPages?.root ?? completePage(blockedBy),
    };
    return {
      loadMilestones: async () => completePage([milestone]),
      loadIssues: async () => completePage([issue]),
      loadLabels: async (_id, after) => labelPages?.next?.get(after) ?? completePage(completeLabels),
      loadBlockedBy: async (_id, after) => blockedByPages?.next?.get(after) ?? completePage(blockedBy),
    };
  }

  it("stabilizes complete window authority before deriving or publishing", async () => {
    const attempts = [
      () => collectRoadmapWindowAuthority(windowLoaders({ reverse: false })),
      () => collectRoadmapWindowAuthority(windowLoaders({ reverse: true })),
    ];
    const accepted = await stabilizeRoadmapWindowAuthority(async () => attempts.shift()());
    expect(accepted.authority.issues.nodes[0].labels.nodes.map(({ name }) => name)).toEqual([
      "area:ops",
      "kind:ops",
      "priority:p1",
    ]);
  });

  it("binds same-count label replacements and permits only attempts two and three to recover", async () => {
    const firstLoaders = windowLoaders();
    const firstRoot = await firstLoaders.loadIssues(null);
    firstRoot.nodes[0].labels.nodes[0] = { id: "synthetic-label-priority", name: "priority:p0" };
    firstLoaders.loadIssues = async () => firstRoot;
    const first = await collectRoadmapWindowAuthority(firstLoaders);
    const second = await collectRoadmapWindowAuthority(windowLoaders());
    expect(first.digest).not.toBe(second.digest);
    const attempts = [
      async () => first,
      async () => second,
      async () => collectRoadmapWindowAuthority(windowLoaders()),
    ];
    await expect(stabilizeRoadmapWindowAuthority(async () => attempts.shift()())).resolves.toMatchObject({
      digest: second.digest,
    });
  });

  it("refuses three changing digests after exactly three attempts", async () => {
    const first = await collectRoadmapWindowAuthority(windowLoaders());
    const secondLoaders = windowLoaders();
    (await secondLoaders.loadIssues()).nodes[0].labels.nodes[0].name = "priority:p0";
    const second = await collectRoadmapWindowAuthority(secondLoaders);
    const thirdLoaders = windowLoaders();
    (await thirdLoaders.loadIssues()).nodes[0].labels.nodes[1].name = "area:changed";
    const third = await collectRoadmapWindowAuthority(thirdLoaders);
    const attempts = [first, second, third];
    await expect(stabilizeRoadmapWindowAuthority(async () => attempts.shift())).rejects.toMatchObject({
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_UNSTABLE",
    });
    expect(attempts).toEqual([]);
  });

  it.each([
    {
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_MILESTONE_PAGE_INVALID",
      loaders: () => ({ ...windowLoaders(), loadMilestones: async () => null }),
    },
    {
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_ISSUE_PAGE_INVALID",
      loaders: () => ({ ...windowLoaders(), loadIssues: async () => null }),
    },
    {
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_LABEL_PAGE_INVALID",
      loaders: () =>
        pagedWindowLoaders({
          labelPages: { root: { totalCount: 0, pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } },
        }),
    },
    {
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_BLOCKED_BY_PAGE_INVALID",
      loaders: () =>
        pagedWindowLoaders({
          blockedByPages: { root: { totalCount: 0, pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } },
        }),
    },
    {
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_COUNT_MISMATCH",
      loaders: () => pagedWindowLoaders({ labels: [], labelPages: { root: completePage([], 1) } }),
    },
    {
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_TOTAL_CHANGED",
      loaders: () => {
        const labels = [
          { id: "synthetic-label-priority", name: "priority:p1" },
          { id: "synthetic-label-area", name: "area:ops" },
        ];
        return pagedWindowLoaders({
          labelPages: {
            root: {
              totalCount: 2,
              pageInfo: { hasNextPage: true, endCursor: "synthetic-total-page-2" },
              nodes: [labels[0]],
            },
            next: new Map([["synthetic-total-page-2", completePage([labels[1]], 3)]]),
          },
        });
      },
    },
    {
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_SCHEMA_INVALID",
      loaders: () =>
        pagedWindowLoaders({ labels: [{ id: "synthetic-label-invalid", name: "priority:p1", extra: true }] }),
    },
    {
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_DUPLICATE_IDENTITY",
      loaders: () => {
        const label = { id: "synthetic-label-priority", name: "priority:p1" };
        return pagedWindowLoaders({
          labelPages: {
            root: {
              totalCount: 2,
              pageInfo: { hasNextPage: true, endCursor: "synthetic-duplicate-page-2" },
              nodes: [label],
            },
            next: new Map([["synthetic-duplicate-page-2", completePage([label], 2)]]),
          },
        });
      },
    },
    {
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_CURSOR_REPEATED",
      loaders: () => {
        const labels = [
          { id: "synthetic-label-priority", name: "priority:p1" },
          { id: "synthetic-label-area", name: "area:ops" },
        ];
        return pagedWindowLoaders({
          labelPages: {
            root: {
              totalCount: 3,
              pageInfo: { hasNextPage: true, endCursor: "synthetic-repeated-cursor" },
              nodes: [labels[0]],
            },
            next: new Map([
              [
                "synthetic-repeated-cursor",
                {
                  totalCount: 3,
                  pageInfo: { hasNextPage: true, endCursor: "synthetic-repeated-cursor" },
                  nodes: [labels[1]],
                },
              ],
            ]),
          },
        });
      },
    },
    {
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_MILESTONE_REFERENCE_INVALID",
      loaders: () => {
        const loaders = windowLoaders();
        return {
          ...loaders,
          loadIssues: async () => {
            const page = await loaders.loadIssues();
            page.nodes[0].milestone = { ...page.nodes[0].milestone, id: "synthetic-unlisted-milestone" };
            return page;
          },
        };
      },
    },
  ])("refuses %s when only its governing authority fact changes", async ({ code, loaders }) => {
    await expect(collectRoadmapWindowAuthority(loaders())).rejects.toMatchObject({ code });
  });

  it.each([
    [
      "zero-total label page",
      () =>
        pagedWindowLoaders({
          labelPages: {
            root: {
              totalCount: 0,
              pageInfo: { hasNextPage: true, endCursor: "synthetic-empty-label-page" },
              nodes: [],
            },
          },
        }),
      "loadLabels",
    ],
    [
      "positive-total blockedBy page",
      () =>
        pagedWindowLoaders({
          blockedByPages: {
            root: {
              totalCount: 1,
              pageInfo: { hasNextPage: true, endCursor: "synthetic-empty-blocker-page" },
              nodes: [],
            },
          },
        }),
      "loadBlockedBy",
    ],
  ])("refuses a continuing %s without a continuation call", async (_description, createLoaders, loaderName) => {
    const loaders = createLoaders();
    let continuationCalls = 0;
    const original = loaders[loaderName];
    loaders[loaderName] = async (...args) => {
      continuationCalls += 1;
      return original(...args);
    };

    await expect(collectRoadmapWindowAuthority(loaders)).rejects.toMatchObject({
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_COUNT_MISMATCH",
    });
    expect(continuationCalls).toBe(0);
  });

  it("reaches the synthetic continuation sentinel only when the new non-progress guard is bypassed", async () => {
    const guard =
      'if (nodes.length === nodesBeforePage || nodes.length >= expectedTotal) {\n        throw windowAuthorityError("ROADMAP_DISPATCH_WINDOW_AUTHORITY_COUNT_MISMATCH");\n      }';
    const backlogClassifyImport = ['from "./backlog-classify', '.mjs"'].join("");
    const dispatchWindowImport = ['from "./dispatch-window', '.mjs"'].join("");
    const milestonePolicyImport = ['from "./milestone-policy', '.mjs"'].join("");
    const source = readFileSync(path.join(repoRoot, "scripts", "roadmap-status.mjs"), "utf8");
    expect(source).toContain(guard);

    const loaders = pagedWindowLoaders({
      labelPages: {
        root: { totalCount: 0, pageInfo: { hasNextPage: true, endCursor: "synthetic-bypass-page" }, nodes: [] },
      },
    });
    let continuationCalls = 0;
    loaders.loadLabels = async () => {
      continuationCalls += 1;
      throw new Error("SYNTHETIC_NON_PROGRESS_CONTINUATION_SENTINEL");
    };
    await expect(collectRoadmapWindowAuthority(loaders)).rejects.toMatchObject({
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_COUNT_MISMATCH",
    });
    expect(continuationCalls).toBe(0);

    const mutantSource = source
      .replace(guard, "if (false) {}")
      .replaceAll(
        backlogClassifyImport,
        `from "${pathToFileURL(path.join(repoRoot, "scripts", "backlog-classify.mjs")).href}"`,
      )
      .replaceAll(
        dispatchWindowImport,
        `from "${pathToFileURL(path.join(repoRoot, "scripts", "dispatch-window.mjs")).href}"`,
      )
      .replaceAll(
        milestonePolicyImport,
        `from "${pathToFileURL(path.join(repoRoot, "scripts", "milestone-policy.mjs")).href}"`,
      );
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`);
    continuationCalls = 0;
    await expect(mutant.collectRoadmapWindowAuthority(loaders)).rejects.toThrow(
      "SYNTHETIC_NON_PROGRESS_CONTINUATION_SENTINEL",
    );
    expect(continuationCalls).toBe(1);
  });

  it("collects a decisive page-two label before accepting the authority", async () => {
    const loaders = windowLoaders();
    const rootPage = await loaders.loadIssues(null);
    rootPage.nodes[0].labels = {
      totalCount: 2,
      pageInfo: { hasNextPage: true, endCursor: "synthetic-page-two" },
      nodes: [{ id: "synthetic-label-priority", name: "priority:p1" }],
    };
    loaders.loadIssues = async () => rootPage;
    let labelCalls = 0;
    loaders.loadLabels = async (_id, after) => {
      labelCalls += 1;
      if (after === null) {
        return {
          totalCount: 2,
          pageInfo: { hasNextPage: true, endCursor: "synthetic-page-two" },
          nodes: [{ id: "synthetic-label-priority", name: "priority:p1" }],
        };
      }
      return {
        totalCount: 2,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ id: "synthetic-label-kind", name: "kind:ops" }],
      };
    };
    const accepted = await collectRoadmapWindowAuthority(loaders);
    expect(labelCalls).toBe(1);
    expect(accepted.authority.issues.nodes[0].labels.nodes.map(({ name }) => name)).toEqual([
      "kind:ops",
      "priority:p1",
    ]);
  });

  it("collects a decisive page-two blockedBy node before accepting the authority", async () => {
    const first = {
      id: "synthetic-blocker-one",
      number: 10,
      state: "OPEN",
      repository: { nameWithOwner: "synthetic/one" },
    };
    const second = {
      id: "synthetic-blocker-two",
      number: 11,
      state: "CLOSED",
      repository: { nameWithOwner: "synthetic/two" },
    };
    const loaders = pagedWindowLoaders({
      blockedByPages: {
        root: {
          totalCount: 2,
          pageInfo: { hasNextPage: true, endCursor: "synthetic-blocked-by-page-two" },
          nodes: [first],
        },
        next: new Map([["synthetic-blocked-by-page-two", completePage([second], 2)]]),
      },
    });
    let continuationCalls = 0;
    const original = loaders.loadBlockedBy;
    loaders.loadBlockedBy = async (...args) => {
      continuationCalls += 1;
      return original(...args);
    };

    const accepted = await collectRoadmapWindowAuthority(loaders);
    expect(continuationCalls).toBe(1);
    expect(accepted.authority.issues.nodes[0].blockedBy.nodes.map(({ id }) => id)).toEqual([
      "synthetic-blocker-one",
      "synthetic-blocker-two",
    ]);
  });

  it("keeps a roadmap PATCH unreachable when the exact completeness guard refuses", async () => {
    const base = createMainRequest({ issues: [slice(1, WAVE_1, "open", ["priority:p1", "area:ops", "kind:ops"])] });
    const request = async (url, init = {}) => {
      if (new URL(url).pathname === "/graphql" && JSON.parse(init.body).query.includes("WINDOW_ISSUES_SENTINEL")) {
        const response = await base.request(url, init);
        const payload = await response.json();
        payload.data.repository.issues.nodes[0].labels = {
          totalCount: 1,
          pageInfo: { hasNextPage: true, endCursor: null },
          nodes: [{ id: "synthetic-label", name: "priority:p1" }],
        };
        return jsonResponse(payload);
      }
      return base.request(url, init);
    };
    const diagnostics = [];
    const code = await main({
      env: mainEnv(),
      request,
      nowMs: NOW,
      writeOutput: () => {},
      writeError: (message) => diagnostics.push(message),
    });
    expect(code).toBe(1);
    expect(diagnostics).toEqual([expect.stringMatching(/^ROADMAP_DISPATCH_WINDOW_AUTHORITY_LABEL_PAGE_INVALID:/)]);
    expect(base.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it("keeps PATCH unreachable when all three live window-authority digests differ", async () => {
    const base = createMainRequest();
    let attempt = 0;
    const request = async (url, init = {}) => {
      if (new URL(url).pathname === "/graphql" && JSON.parse(init.body).query.includes("WINDOW_MILESTONES_SENTINEL")) {
        attempt += 1;
        const response = await base.request(url, init);
        const payload = await response.json();
        payload.data.repository.milestones.nodes.push({
          id: `synthetic-unstable-milestone-${attempt}`,
          number: 900 + attempt,
          title: `Wave ${900 + attempt}`,
          state: "OPEN",
        });
        payload.data.repository.milestones.totalCount += 1;
        return jsonResponse(payload);
      }
      return base.request(url, init);
    };
    const diagnostics = [];
    const code = await main({
      env: mainEnv(),
      request,
      nowMs: NOW,
      writeOutput: () => {},
      writeError: (message) => diagnostics.push(message),
    });
    expect(code).toBe(1);
    expect(attempt).toBe(3);
    expect(diagnostics).toEqual([expect.stringMatching(/^ROADMAP_DISPATCH_WINDOW_AUTHORITY_UNSTABLE:/)]);
    expect(base.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it("flags only ruled stale claims and fails bounded when a series has no window", () => {
    const authority = {
      version: "roadmap-dispatch-window-authority/v1",
      milestones: {
        totalCount: 5,
        nodes: [
          {
            id: "synthetic-wave-1",
            number: 1,
            title: "Wave 1",
            description: outcomeDescription("wave", 1),
            state: "OPEN",
          },
          {
            id: "synthetic-wave-2",
            number: 2,
            title: "Wave 2",
            description: outcomeDescription("wave", 2),
            state: "OPEN",
          },
          {
            id: "synthetic-mobile-1",
            number: 3,
            title: "Mobile 1",
            description: outcomeDescription("mobile", 1),
            state: "OPEN",
          },
          { id: "synthetic-operations", number: 4, title: "Operations", state: "OPEN" },
          { id: "synthetic-future", number: 5, title: "Future planning", state: "OPEN" },
        ],
      },
      issues: {
        totalCount: 8,
        nodes: [
          {
            id: "synthetic-runnable",
            number: 1,
            state: "OPEN",
            issueType: { name: "Slice" },
            milestone: { id: "synthetic-wave-1", number: 1, title: "Wave 1", state: "OPEN" },
            // Deliberately synthetic disagreement: native nodes, not this diagnostic summary, govern runnability.
            issueDependenciesSummary: { blockedBy: 3, totalBlockedBy: 3 },
            labels: {
              totalCount: 3,
              nodes: [
                { id: "l1", name: "priority:p1" },
                { id: "l2", name: "area:ops" },
                { id: "l3", name: "kind:ops" },
              ],
            },
            blockedBy: { totalCount: 0, nodes: [] },
          },
          {
            id: "synthetic-stale",
            number: 2,
            state: "OPEN",
            issueType: { name: "Slice" },
            milestone: { id: "synthetic-wave-2", number: 2, title: "Wave 2", state: "OPEN" },
            issueDependenciesSummary: { blockedBy: 1, totalBlockedBy: 1 },
            labels: { totalCount: 1, nodes: [{ id: "l4", name: "priority:p0" }] },
            blockedBy: {
              totalCount: 1,
              nodes: [
                { id: "synthetic-blocker", number: 9, state: "OPEN", repository: { nameWithOwner: "synthetic/local" } },
              ],
            },
          },
          {
            id: "synthetic-tracking",
            number: 3,
            state: "OPEN",
            issueType: { name: "Slice" },
            milestone: { id: "synthetic-wave-2", number: 2, title: "Wave 2", state: "OPEN" },
            issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
            labels: {
              totalCount: 2,
              nodes: [
                { id: "l5", name: "priority:p1" },
                { id: "l6", name: "status:tracking-only" },
              ],
            },
            blockedBy: { totalCount: 0, nodes: [] },
          },
          {
            id: "synthetic-mobile-unrunnable",
            number: 4,
            state: "OPEN",
            issueType: { name: "Slice" },
            milestone: { id: "synthetic-mobile-1", number: 3, title: "Mobile 1", state: "OPEN" },
            // Deliberately synthetic inverse disagreement: the native OPEN node blocks despite this summary.
            issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
            labels: { totalCount: 1, nodes: [{ id: "l7", name: "priority:p1" }] },
            blockedBy: {
              totalCount: 1,
              nodes: [
                {
                  id: "synthetic-native-open-blocker",
                  number: 99,
                  state: "OPEN",
                  repository: { nameWithOwner: "synthetic/native-authority" },
                },
              ],
            },
          },
          {
            id: "synthetic-epic-excluded",
            number: 5,
            state: "OPEN",
            issueType: { name: "Epic" },
            milestone: { id: "synthetic-wave-2", number: 2, title: "Wave 2", state: "OPEN" },
            issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
            labels: { totalCount: 1, nodes: [{ id: "l8", name: "priority:p0" }] },
            blockedBy: { totalCount: 0, nodes: [] },
          },
          {
            id: "synthetic-operations-excluded",
            number: 6,
            state: "OPEN",
            issueType: { name: "Slice" },
            milestone: { id: "synthetic-operations", number: 4, title: "Operations", state: "OPEN" },
            issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
            labels: { totalCount: 1, nodes: [{ id: "l9", name: "priority:p0" }] },
            blockedBy: { totalCount: 0, nodes: [] },
          },
          {
            id: "synthetic-nonmatching-excluded",
            number: 7,
            state: "OPEN",
            issueType: { name: "Slice" },
            milestone: { id: "synthetic-future", number: 5, title: "Future planning", state: "OPEN" },
            issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
            labels: { totalCount: 1, nodes: [{ id: "l10", name: "priority:p0" }] },
            blockedBy: { totalCount: 0, nodes: [] },
          },
          {
            id: "synthetic-unmilestoned-excluded",
            number: 8,
            state: "OPEN",
            issueType: { name: "Slice" },
            milestone: null,
            issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
            labels: { totalCount: 1, nodes: [{ id: "l11", name: "priority:p0" }] },
            blockedBy: { totalCount: 0, nodes: [] },
          },
        ],
      },
    };
    const hygiene = summarizePrioritizationHygiene(authority);
    expect(hygiene).toMatchObject({
      selected: [{ id: "synthetic-wave-1", number: 1, title: "Wave 1" }],
      candidates: [
        { number: 2, priority: "priority:p0", milestone: "Wave 2" },
        { number: 3, priority: "priority:p1", milestone: "Wave 2" },
      ],
      noWindowFamilies: ["mobile"],
    });
    expect(hygiene.candidates).toHaveLength(2);
  });

  it("diagnoses a present Mobile family without coupling it to priority claims", () => {
    const wave1 = {
      id: "synthetic-wave-runnable",
      number: 1,
      title: "Wave 1",
      description: outcomeDescription("wave", 1),
      state: "OPEN",
    };
    const mobile1 = {
      id: "synthetic-mobile-present",
      number: 2,
      title: "Mobile 1",
      description: outcomeDescription("mobile", 1),
      state: "OPEN",
    };
    const issue = (id, number, milestone, labels) => ({
      id,
      number,
      state: "OPEN",
      issueType: { name: "Slice" },
      milestone,
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
      labels: { totalCount: labels.length, nodes: labels.map((name, index) => ({ id: `${id}-label-${index}`, name })) },
      blockedBy: { totalCount: 0, nodes: [] },
    });
    const authority = {
      milestones: { totalCount: 2, nodes: [wave1, mobile1] },
      issues: {
        totalCount: 3,
        nodes: [
          issue("synthetic-wave-runnable-issue", 1, wave1, ["priority:p1", "area:ops", "kind:ops"]),
          issue("synthetic-mobile-non-priority", 2, mobile1, ["area:ops", "kind:ops"]),
          issue("synthetic-mobile-tracking-only", 3, mobile1, ["status:tracking-only"]),
        ],
      },
    };

    const hygiene = summarizePrioritizationHygiene(authority);
    expect(hygiene.selected).toMatchObject([{ id: wave1.id }]);
    expect(hygiene.noWindowFamilies).toEqual(["mobile"]);
    expect(hygiene.candidates).toEqual([]);
    expect(renderRoadmapStatus({ rows: [], windowDays: 7, prioritizationHygiene: hygiene })).toContain(
      "mobile: no runnable refined milestone",
    );
  });

  it("renders stale preemption counts, identities, and zero states", () => {
    const zeroMarkdown = renderRoadmapStatus({
      rows: [],
      windowDays: 7,
      prioritizationHygiene: { selected: [], candidates: [], byPriority: { p0: [], p1: [] }, noWindowFamilies: [] },
    });
    const zeroLines = zeroMarkdown.split("\n");
    const zeroCountLine = "Stale preemption/tie claims: **0 total** — **0 p0**, **0 p1**.";
    expect(zeroMarkdown).toContain("## Prioritization hygiene");
    expect(zeroLines[zeroLines.indexOf(zeroCountLine) + 1]).toBe("none");

    const milestone = (id, number, title, track, order) => ({
      id,
      number,
      title,
      description: outcomeDescription(track, order),
      state: "OPEN",
    });
    const wave1 = milestone("synthetic-render-wave-1", 1, "Wave 1", "wave", 1);
    const wave2 = milestone("synthetic-render-wave-2", 2, "Wave 2", "wave", 2);
    const mobile1 = milestone("synthetic-render-mobile-1", 3, "Mobile 1", "mobile", 1);
    const issue = (number, activeMilestone, priority, blocked = false) => ({
      id: `synthetic-render-issue-${number}`,
      number,
      state: "OPEN",
      issueType: { name: "Slice" },
      milestone: activeMilestone,
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
      labels: {
        totalCount: priority ? 1 : 3,
        nodes: priority
          ? [{ id: `l-${number}`, name: priority }]
          : [
              { id: `l-${number}-p`, name: "priority:p1" },
              { id: `l-${number}-a`, name: "area:ops" },
              { id: `l-${number}-k`, name: "kind:ops" },
            ],
      },
      blockedBy: blocked
        ? {
            totalCount: 1,
            nodes: [
              { id: `b-${number}`, number: 999, state: "OPEN", repository: { nameWithOwner: "synthetic/render" } },
            ],
          }
        : { totalCount: 0, nodes: [] },
    });
    const hygiene = summarizePrioritizationHygiene({
      milestones: { totalCount: 3, nodes: [wave1, wave2, mobile1] },
      // Candidates arrive out of numeric order; the summary sorts before the renderer consumes them.
      issues: {
        totalCount: 6,
        nodes: [
          issue(30, wave1, null),
          issue(104, wave2, "priority:p1"),
          issue(101, wave2, "priority:p0"),
          issue(103, wave2, "priority:p1"),
          issue(102, wave2, "priority:p0"),
          issue(105, mobile1, "priority:p1", true),
        ],
      },
    });
    const markdown = renderRoadmapStatus({ rows: [], windowDays: 7, prioritizationHygiene: hygiene });
    expect(markdown).toContain("Pull window: Wave 1.");
    expect(markdown).toContain("Stale preemption/tie claims: **4 total** — **2 p0**, **2 p1**.");
    expect(markdown).toContain(
      [
        "- #101 priority:p0 — Wave 2",
        "- #102 priority:p0 — Wave 2",
        "- #103 priority:p1 — Wave 2",
        "- #104 priority:p1 — Wave 2",
      ].join("\n"),
    );
    expect(markdown).toContain("Pull-window diagnostics: mobile: no runnable refined milestone.");
  });
});

describe("dispatch-window module boundary", () => {
  it("derives the tracked importer inventory and keeps the helper source network- and mutation-free", () => {
    const trackedScripts = execFileSync("git", ["ls-files", "scripts"], { cwd: repoRoot, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((file) => file.endsWith(".mjs"));
    const importers = trackedScripts.filter((file) =>
      /from\s+["']\.\/dispatch-window\.mjs["']/.test(readFileSync(path.join(repoRoot, file), "utf8")),
    );
    const source = readFileSync(path.join(repoRoot, "scripts/dispatch-window.mjs"), "utf8");

    expect(importers).toEqual(["scripts/dispatch-window.test.mjs", "scripts/roadmap-status.mjs"]);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain("method:");
    expect(source).not.toMatch(/graphql/i);
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
      expect.stringContaining("ROADMAP_ISSUE_COUNT_MISMATCH: Repository issue enumeration collected 1 rows"),
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
