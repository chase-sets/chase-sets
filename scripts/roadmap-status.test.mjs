import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { classified } from "./backlog-classify.mjs";
import { releaseQualificationScopeRegistry } from "./release-qualification-scope.mjs";
import {
  buildForecastMilestoneCatalog,
  classifyForecastDrift,
  collectEpicChildren,
  collectRoadmapIssueFacts,
  collectScopeGrowth,
  createForecastPresentation,
  deriveForecastInputs,
  END_MARKER,
  evaluateForecastEstimator,
  FORECAST_TABLE_HEADER,
  FORECAST_TABLE_SEPARATOR,
  isEpic,
  main,
  mergeRoadmapIssueFacts,
  normalizeForecastIssue,
  paginate,
  readPriorForecastRecord,
  reconcileForecastIssueSources,
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
const WAVE_1 = { number: 136, title: "Wave 1", state: "open", due_on: null };
const WAVE_2 = { number: 137, title: "Wave 2", state: "open", due_on: null };
const DEFERRED = { number: 146, title: "Deferred / Incubation", state: "open", due_on: null };
const OPERATIONS = { number: 147, title: "Operations", state: "open", due_on: null };
const CLOSED_WAVE_0 = { number: 134, title: "Wave 0", state: "closed", due_on: "2026-07-01T00:00:00Z" };

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
  closedMilestones = [],
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
      return jsonResponse(parsed.searchParams.get("state") === "closed" ? closedMilestones : milestones);
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

function completionIssues(counts, startNumber = 1000, milestone = CLOSED_WAVE_0) {
  const today = Date.UTC(2026, 6, 28);
  const issues = [];
  let number = startNumber;
  for (let day = 0; day < counts.length; day += 1) {
    const closedAt = new Date(today - (14 - day) * 86_400_000 + 12 * 60 * 60 * 1000).toISOString();
    for (let index = 0; index < counts[day]; index += 1) {
      issues.push(
        slice(number, milestone, "closed", ["kind:product"], "2026-06-01T00:00:00Z", { closed_at: closedAt }),
      );
      number += 1;
    }
  }
  return issues;
}

function openForecastIssues(count, milestone, startNumber = 10) {
  return Array.from({ length: count }, (_, index) =>
    slice(startNumber + index, milestone, "open", ["kind:product"], "2026-07-01T00:00:00Z"),
  );
}

function deriveFixture({ counts = Array(14).fill(1), wave1Open = 2, wave2Open = 1, catalog } = {}) {
  const selectedCatalog = catalog ?? buildForecastMilestoneCatalog([WAVE_1, WAVE_2], [CLOSED_WAVE_0]);
  const issues = [
    ...completionIssues(counts),
    ...openForecastIssues(wave1Open, WAVE_1),
    ...openForecastIssues(wave2Open, WAVE_2, 100),
  ];
  const catalogByNumber = new Map(selectedCatalog.map((milestone) => [milestone.number, milestone]));
  const normalizedIssues = issues.map((issue) => normalizeForecastIssue(issue, catalogByNumber, NOW));
  return {
    catalog: selectedCatalog,
    issues,
    normalizedIssues,
    current: deriveForecastInputs({ catalog: selectedCatalog, normalizedIssues, nowMs: NOW }),
  };
}

function bodyWithRecord(record) {
  const encoded = JSON.stringify(record).replaceAll("-->", "--\\u003e");
  return `${START_MARKER}\n<!-- roadmap-forecast-inputs:${encoded} -->\n${END_MARKER}`;
}

async function runMainFixture(options = {}) {
  const fixture = createMainRequest(options);
  const diagnostics = [];
  const generated = [];
  const code = await runRoadmapStatus(
    () =>
      main({
        env: mainEnv(options.env),
        request: fixture.request,
        nowMs: NOW,
        writeOutput: (message) => generated.push(message),
        writeError: (message) => diagnostics.push(message),
        appendSummary: async () => {},
      }),
    (message) => diagnostics.push(message),
  );
  return { ...fixture, code, diagnostics, generated };
}

describe("gate-stable forecast contract", () => {
  it("derives pinned UTC forecasts and literal generated presentation from gate-stable history", () => {
    const fixture = deriveFixture({ wave1Open: 2, wave2Open: 1 });
    const [wave1, wave2] = fixture.current.record.milestones.filter((milestone) => milestone.state === "open");
    expect(fixture.current.estimator).toMatchObject({
      admissible: true,
      closures14: 14,
      closures7: 7,
      activeDays: 14,
      maxDaily: 1,
      ratePerDay: 1,
    });
    expect(wave1).toMatchObject({ title: "Wave 1", cumulativeOpen: 2, forecastDays: 2 });
    expect(wave2).toMatchObject({ title: "Wave 2", cumulativeOpen: 3, forecastDays: 3 });

    const drift = classifyForecastDrift({
      current: fixture.current,
      priorAuthority: { status: "absent", record: null },
      normalizedIssues: fixture.normalizedIssues,
      nowMs: NOW,
    });
    const summary = summarizeWaves({
      milestones: [WAVE_1, WAVE_2],
      issues: fixture.issues,
      scopeGrowthByIssue: knownGrowth(fixture.issues),
      nowMs: NOW,
    });
    summary.forecast = createForecastPresentation({ current: fixture.current, drift, nowMs: NOW });
    const markdown = renderRoadmapStatus(summary);
    expect(markdown).toContain(FORECAST_TABLE_HEADER);
    expect(markdown).toContain(FORECAST_TABLE_SEPARATOR);
    expect(markdown).toContain("| Wave 1 | 2026-07-30 | ? |");
    expect(markdown).toContain("| Wave 2 | 2026-07-31 | ? |");
    expect(markdown).toContain(
      "Forecast estimator: 14 completed UTC days; closures14=14; closures7=7; activeDays14=14; maxDaily=1; maxSharePercent=7.1%; ratePerDay=1.00. Derived forecast, not commitment; milestone exit gates remain closure authority.",
    );
    expect(markdown).toContain("Drift alert (≥7d): none.");
    expect(markdown).toContain("Drift unavailable: **2 row(s)**; **0 unobservable identity transition(s)**.");
  });

  it("normalizes the complete issue authority schema before membership", () => {
    const catalog = buildForecastMilestoneCatalog([WAVE_1], [CLOSED_WAVE_0]);
    const byNumber = new Map(catalog.map((milestone) => [milestone.number, milestone]));
    const accepted = [
      slice(1, WAVE_1, "open", [], OLD, { issueTypeName: null }),
      slice(2, WAVE_1, "open", ["kind:product"], OLD, { issueTypeName: "FutureNativeType" }),
      slice(3, WAVE_1, "open", ["kind:product"], OLD, { issueTypeName: "Epic" }),
      slice(4, CLOSED_WAVE_0, "closed", ["kind:product"], OLD, { closed_at: "2026-07-27T00:00:00+00:00" }),
      slice(5, null, "open", ["kind:product"]),
    ].map((issue) => normalizeForecastIssue(issue, byNumber, NOW));
    expect(accepted.map((entry) => entry.eligible)).toEqual([true, true, false, true, true]);
    expect(Object.keys(accepted[0].issue)).toEqual([
      "number",
      "state",
      "type",
      "labels",
      "milestone",
      "created_at",
      "closed_at",
    ]);

    const base = slice(20, WAVE_1, "open", ["kind:product"]);
    const rejected = [
      { ...base, state: "OPEN" },
      { ...base, issueTypeName: "" },
      { ...base, labels: [{ name: "kind:product" }, { name: "kind:product" }] },
      { ...base, labels: [{ name: "" }] },
      { ...base, created_at: "2026-07-01" },
      { ...base, created_at: "2026-08-01T00:00:00Z" },
      { ...base, closed_at: "2026-07-01T00:00:00Z" },
      { ...base, milestone: { ...WAVE_1, title: "Wave renamed" } },
      { ...base, milestone: { ...WAVE_1, state: "closed" } },
    ];
    for (const issue of rejected) {
      expect(() => normalizeForecastIssue(issue, byNumber, NOW)).toThrowError(
        expect.objectContaining({ code: "FORECAST_ISSUE_AUTHORITY_INVALID" }),
      );
    }
  });

  it("separates gate-stable completion history from open forecast membership", () => {
    const fixture = deriveFixture({ wave1Open: 1, wave2Open: 0 });
    expect(fixture.current.record.closures14).toBe(14);
    expect(fixture.current.record.milestones.find(({ title }) => title === "Wave 0")).toMatchObject({
      state: "closed",
      cumulativeOpen: null,
      closedEligibleIssueNumbers: expect.arrayContaining([1000]),
    });
    expect(fixture.current.record.milestones.find(({ title }) => title === "Wave 1")).toMatchObject({
      state: "open",
      cumulativeOpen: 1,
    });
  });

  it("fails complete but malformed issue authority before rendering or patching", async () => {
    const base = slice(1, WAVE_1, "open", ["kind:product"]);
    const invalidIssues = [
      { ...base, state: "bogus" },
      { ...base, issueTypeName: "" },
      { ...base, labels: [{ name: "kind:product" }, { name: "kind:product" }] },
      { ...base, labels: [{ name: "" }] },
      { ...base, created_at: "2026-07-01" },
      { ...base, created_at: "2026-08-01T00:00:00Z" },
      { ...base, closed_at: "2026-07-01T00:00:00Z" },
      { ...base, milestone: { ...WAVE_1, title: "Wave renamed" } },
      { ...base, milestone: { ...WAVE_1, state: "closed" } },
      { ...base, milestone: { number: 0, title: "Wave 1", state: "open" } },
    ];
    for (const invalid of invalidIssues) {
      const result = await runMainFixture({ issues: [invalid] });
      expect(result.code).toBe(1);
      expect(result.diagnostics).toEqual([expect.stringMatching(/^FORECAST_ISSUE_AUTHORITY_INVALID:/)]);
      expect(result.generated).toEqual([]);
      expect(result.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
    }
  });

  it("fails forecast estimation closed on sparse concentrated and regime-shifted completion samples", () => {
    const distributed = evaluateForecastEstimator(
      Array(14)
        .fill(null)
        .map((_, index) => ({ date: String(index), count: 1 })),
    );
    expect(distributed).toMatchObject({ admissible: true, diagnostics: [], closures14: 14, closures7: 7 });

    const sparse = evaluateForecastEstimator([
      ...Array(13)
        .fill(null)
        .map((_, index) => ({ date: String(index), count: 0 })),
      { date: "13", count: 14 },
    ]);
    expect(sparse.diagnostics).toEqual([
      "FORECAST_ACTIVE_DAYS_BELOW_7",
      "FORECAST_DAY_SHARE_ABOVE_25_PERCENT",
      "FORECAST_7D_14D_RATE_DISAGREEMENT_ABOVE_25_PERCENT",
    ]);

    const concentration = evaluateForecastEstimator(
      [5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1].map((count, index) => ({ date: String(index), count })),
    );
    expect(concentration.diagnostics).toEqual(["FORECAST_DAY_SHARE_ABOVE_25_PERCENT"]);
    const regime = evaluateForecastEstimator(
      [...Array(7).fill(2), ...Array(7).fill(1)].map((count, index) => ({ date: String(index), count })),
    );
    expect(regime.diagnostics).toEqual(["FORECAST_7D_14D_RATE_DISAGREEMENT_ABOVE_25_PERCENT"]);

    const activeOnly = evaluateForecastEstimator(
      [4, 0, 0, 4, 0, 0, 0, 4, 0, 0, 4, 0, 0, 0].map((count, index) => ({ date: String(index), count })),
    );
    expect(activeOnly.diagnostics).toEqual(["FORECAST_ACTIVE_DAYS_BELOW_7"]);
    const mutantReceipts = [
      [activeOnly, "FORECAST_ACTIVE_DAYS_BELOW_7"],
      [concentration, "FORECAST_DAY_SHARE_ABOVE_25_PERCENT"],
      [regime, "FORECAST_7D_14D_RATE_DISAGREEMENT_ABOVE_25_PERCENT"],
    ].map(([candidate, bypass]) => candidate.diagnostics.filter((diagnostic) => diagnostic !== bypass));
    expect(mutantReceipts).toEqual([[], [], []]);
  });

  it("isolates forecast order from legacy milestone and epic order under input permutation", () => {
    const forward = buildForecastMilestoneCatalog([WAVE_2, WAVE_1], [CLOSED_WAVE_0]);
    const reverse = buildForecastMilestoneCatalog([WAVE_1, WAVE_2], [CLOSED_WAVE_0]);
    expect(forward).toEqual(reverse);
    const first = deriveFixture({ catalog: forward }).current.record.milestones;
    const second = deriveFixture({ catalog: reverse }).current.record.milestones;
    expect(first).toEqual(second);
    expect([WAVE_2, WAVE_1].map(({ title }) => title)).toEqual(["Wave 2", "Wave 1"]);
    const openCounts = new Map([
      [WAVE_1.title, 2],
      [WAVE_2.title, 1],
    ]);
    const inputOrderedMutant = (ordered) => {
      let cumulative = 0;
      return ordered.map(({ title }) => [title, (cumulative += openCounts.get(title))]);
    };
    const candidateReceipt = first
      .filter(({ state }) => state === "open")
      .map(({ title, cumulativeOpen }) => [title, cumulativeOpen]);
    const mutants = {
      rows: inputOrderedMutant([WAVE_2, WAVE_1]),
      milestones: inputOrderedMutant([WAVE_2, WAVE_1]),
      milestoneOrder: inputOrderedMutant([WAVE_2, WAVE_1]),
    };
    expect(candidateReceipt).toEqual([
      ["Wave 1", 2],
      ["Wave 2", 3],
    ]);
    for (const receipt of Object.values(mutants)) expect(receipt).not.toEqual(candidateReceipt);
  });

  it("fails every milestone catalog drift arm before rendering or patching", async () => {
    const inversion = [
      WAVE_1,
      { number: 137, title: "Wave 3", state: "open", due_on: null },
      { number: 138, title: "Wave 2", state: "open", due_on: null },
    ];
    const arms = [
      { milestones: inversion },
      { milestones: [WAVE_1], closedMilestones: [{ ...CLOSED_WAVE_0, number: WAVE_1.number }] },
      { milestones: [WAVE_1], closedMilestones: [{ ...CLOSED_WAVE_0, number: 150, title: WAVE_1.title }] },
      { milestones: [WAVE_1], closedMilestones: [{ number: 150, title: "Wave 9", state: "open" }] },
    ];
    for (const arm of arms) {
      const result = await runMainFixture(arm);
      expect(result.code).toBe(1);
      expect(result.diagnostics).toEqual([expect.stringMatching(/^MILESTONE_CATALOG_DRIFT:/)]);
      expect(result.generated).toEqual([]);
      expect(result.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
    }

    const dueWins = await runMainFixture({
      milestones: inversion.map((row, index) => (index === 1 ? { ...row, due_on: "2026-08-01T00:00:00Z" } : row)),
    });
    expect(dueWins.diagnostics).toEqual([expect.stringMatching(/^OPEN_MILESTONE_DUE_DATE_PROHIBITED:/)]);

    const retained = deriveFixture();
    const renamedWave = { ...WAVE_1, title: "Wave 1 renamed" };
    const renamedIssues = retained.issues.map((issue) =>
      issue.milestone?.number === WAVE_1.number ? { ...issue, milestone: renamedWave } : issue,
    );
    const rename = await runMainFixture({
      issues: renamedIssues,
      milestones: [renamedWave, WAVE_2],
      closedMilestones: [CLOSED_WAVE_0],
      roadmapBody: bodyWithRecord(retained.current.record),
    });
    expect(rename.diagnostics).toEqual([expect.stringMatching(/^MILESTONE_CATALOG_DRIFT:/)]);
    expect(rename.generated).toEqual([]);
    expect(rename.requests.filter(({ method }) => method === "PATCH")).toEqual([]);

    const disappearance = await runMainFixture({
      issues: retained.issues,
      milestones: [WAVE_1],
      closedMilestones: [CLOSED_WAVE_0],
      roadmapBody: bodyWithRecord(retained.current.record),
    });
    expect(disappearance.diagnostics).toEqual([expect.stringMatching(/^MILESTONE_CATALOG_DRIFT:/)]);
    expect(disappearance.generated).toEqual([]);
    expect(disappearance.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it("gives malformed open Wave shape exactly one diagnostic", async () => {
    const malformed = { number: 0, title: "", state: "wrong", due_on: "2026-08-01T00:00:00Z" };
    const result = await runMainFixture({ milestones: [malformed, WAVE_1] });
    expect(result.code).toBe(1);
    expect(result.diagnostics).toEqual([expect.stringMatching(/^OPEN_MILESTONE_SHAPE_INVALID:/)]);
    expect(result.generated).toEqual([]);
    expect(result.requests.filter(({ method }) => method === "PATCH")).toEqual([]);
  });

  it("retains a known zero while separating insufficient throughput unknown from gate-bound zero-open dash", () => {
    for (const counts of [Array(14).fill(0), [...Array(13).fill(1), 0]]) {
      const fixture = deriveFixture({ counts, wave1Open: 0, wave2Open: 1 });
      expect(fixture.current.estimator.diagnostics[0]).toBe("FORECAST_SAMPLE_BELOW_14");
      const [wave1, wave2] = fixture.current.record.milestones.filter(({ state }) => state === "open");
      expect(wave1).toMatchObject({ cumulativeOpen: 0, forecastDays: 0 });
      expect(wave2).toMatchObject({ cumulativeOpen: 1, forecastDays: null });
      const drift = classifyForecastDrift({
        current: fixture.current,
        priorAuthority: { status: "absent", record: null },
        normalizedIssues: fixture.normalizedIssues,
        nowMs: NOW,
      });
      expect(drift.rowResults.get(WAVE_1.number).driftCell).toBe("—");
      expect(drift.unavailableRows).toBe(1);
    }
  });

  it("preserves decisive completion history and valid retained evidence across gate close while failing catalog drift closed", () => {
    const openCatalog = buildForecastMilestoneCatalog([WAVE_1, WAVE_2], [CLOSED_WAVE_0]);
    const closedWave1 = { ...WAVE_1, state: "closed" };
    const closedCatalog = buildForecastMilestoneCatalog([WAVE_2], [CLOSED_WAVE_0, closedWave1]);
    const decisiveCompletion = slice(500, WAVE_1, "closed", ["kind:product"], OLD, {
      closed_at: "2026-07-27T12:00:00Z",
    });
    const issuesOpen = [
      ...completionIssues(Array(14).fill(1)),
      decisiveCompletion,
      ...openForecastIssues(1, WAVE_2, 50),
    ];
    const issuesClosed = issuesOpen.map((issue) =>
      issue.number === decisiveCompletion.number ? { ...issue, milestone: closedWave1 } : issue,
    );
    const normalize = (issues, catalog) => {
      const byNumber = new Map(catalog.map((milestone) => [milestone.number, milestone]));
      return issues.map((issue) => normalizeForecastIssue(issue, byNumber, NOW));
    };
    const before = deriveForecastInputs({
      catalog: openCatalog,
      normalizedIssues: normalize(issuesOpen, openCatalog),
      nowMs: NOW,
    });
    const after = deriveForecastInputs({
      catalog: closedCatalog,
      normalizedIssues: normalize(issuesClosed, closedCatalog),
      nowMs: NOW,
    });
    expect(after.record.closureDays14).toEqual(before.record.closureDays14);
    expect(after.record.closures7).toBe(before.record.closures7);
    expect(after.record.milestones.map(({ title }) => title)).toEqual(["Wave 0", "Wave 1", "Wave 2"]);
    expect(after.record.milestones.find(({ title }) => title === "Wave 1").forecastDays).toBeNull();
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

  it("keeps closed milestone due dates outside the prohibition", async () => {
    const result = await runMainFixture({ closedMilestones: [CLOSED_WAVE_0] });
    expect(result.code).toBe(0);
    expect(result.generated).toHaveLength(1);
  });

  it("closes every retained horizon relationship", () => {
    const fixture = deriveFixture();
    expect(readPriorForecastRecord(bodyWithRecord(fixture.current.record), NOW)).toMatchObject({ status: "valid" });
    const mutations = [
      (record) => {
        record.extra = true;
      },
      (record) => {
        record.generatedAt = "2026-07-28T01:00:00+01:00";
      },
      (record) => {
        record.generatedAt = "2026-08-01T00:00:00.000Z";
      },
      (record) => {
        record.closureDays14[0].date = record.closureDays14[1].date;
      },
      (record) => {
        record.closureDays14[0].count += 1;
      },
      (record) => {
        record.closureDays14[0] = { count: record.closureDays14[0].count, date: record.closureDays14[0].date };
      },
      (record) => {
        record.closures7 += 1;
      },
      (record) => {
        record.milestones[0].cumulativeOpen = 0;
      },
      (record) => {
        record.milestones[1].cumulativeOpen += 1;
      },
      (record) => {
        record.milestones[1].forecastDays += 1;
      },
      (record) => {
        record.milestones[1].openEligibleIssueNumbers.reverse();
      },
      (record) => {
        record.milestones[1].unknown = true;
      },
      (record) => {
        record.milestones[1].openEligibleIssueNumbers = [Number.MAX_SAFE_INTEGER + 1];
      },
      (record) => {
        record.milestones[2].openEligibleIssueNumbers.push(record.milestones[1].openEligibleIssueNumbers[0]);
      },
    ];
    for (const mutate of mutations) {
      const record = structuredClone(fixture.current.record);
      mutate(record);
      expect(readPriorForecastRecord(bodyWithRecord(record), NOW).status).toBe("invalid");
    }
    expect(
      readPriorForecastRecord(
        `${START_MARKER}\n<!-- roadmap-forecast-inputs:{"title":"raw --> terminator"} -->\n${END_MARKER}`,
        NOW,
      ).status,
    ).toBe("invalid");
  });

  it("round-trips gate transitions and malformed variants", async () => {
    const fixture = deriveFixture();
    const malformed = structuredClone(fixture.current.record);
    malformed.milestones[1].forecastDays += 1;
    const result = await runMainFixture({
      issues: fixture.issues,
      milestones: [WAVE_1, WAVE_2],
      closedMilestones: [CLOSED_WAVE_0],
      roadmapBody: bodyWithRecord(malformed),
    });
    expect(result.code).toBe(0);
    expect(result.generated[0]).toContain("Drift diagnostics: FORECAST_PRIOR_RECORD_INVALID.");
    expect(result.requests.filter(({ method }) => method === "PATCH")).toHaveLength(1);
    expect(readPriorForecastRecord(result.generated[0], NOW).status).toBe("valid");

    const titleBeforeSchema = structuredClone(fixture.current.record);
    titleBeforeSchema.milestones[1].title = "Wave 1 renamed";
    titleBeforeSchema.milestones[1].unknown = true;
    const titleResult = await runMainFixture({
      issues: fixture.issues,
      milestones: [WAVE_1, WAVE_2],
      closedMilestones: [CLOSED_WAVE_0],
      roadmapBody: bodyWithRecord(titleBeforeSchema),
    });
    expect(titleResult.code).toBe(0);
    expect(titleResult.generated[0]).toContain("Drift diagnostics: FORECAST_PRIOR_RECORD_INVALID.");
    expect(titleResult.diagnostics).toEqual([]);
  });

  it("escapes the HTML terminator while preserving provider title authority", () => {
    const title = "Wave 1 -->";
    const milestone = { ...WAVE_1, title };
    const catalog = buildForecastMilestoneCatalog([milestone], [CLOSED_WAVE_0]);
    const issues = [...completionIssues(Array(14).fill(1)), ...openForecastIssues(1, milestone)];
    const byNumber = new Map(catalog.map((row) => [row.number, row]));
    const normalizedIssues = issues.map((issue) => normalizeForecastIssue(issue, byNumber, NOW));
    const current = deriveForecastInputs({ catalog, normalizedIssues, nowMs: NOW });
    const drift = classifyForecastDrift({
      current,
      priorAuthority: { status: "absent" },
      normalizedIssues,
      nowMs: NOW,
    });
    const presentation = createForecastPresentation({ current, drift, nowMs: NOW });
    expect(presentation.retainedComment).toContain("--\\u003e");
    expect(presentation.retainedComment.slice(FORECAST_TABLE_HEADER.length)).not.toContain(title);
    const parsed = readPriorForecastRecord(`${START_MARKER}\n${presentation.retainedComment}\n${END_MARKER}`, NOW);
    expect(parsed.record.milestones.find(({ number }) => number === WAVE_1.number).title).toBe(title);
  });

  it("renders drift boundaries and recovers valid null horizons without fabricating diagnostics", () => {
    const fixture = deriveFixture({ wave1Open: 20, wave2Open: 0 });
    for (const [priorDays, expected, alerts] of [
      [20, "0d · no-transition", 0],
      [14, "+6d · no-transition", 0],
      [26, "-6d · no-transition", 0],
      [13, "+7d · no-transition", 1],
      [27, "-7d · no-transition", 1],
    ]) {
      const prior = structuredClone(fixture.current.record);
      prior.milestones.find(({ number }) => number === WAVE_1.number).forecastDays = priorDays;
      const drift = classifyForecastDrift({
        current: fixture.current,
        priorAuthority: { status: "valid", record: prior },
        normalizedIssues: fixture.normalizedIssues,
        nowMs: NOW,
      });
      expect(drift.rowResults.get(WAVE_1.number).driftCell).toBe(expected);
      expect(drift.alerts).toHaveLength(alerts);
      expect(drift.priorDiagnostic).toBeNull();
    }

    const inadmissible = deriveFixture({
      counts: [4, 0, 0, 4, 0, 0, 0, 4, 0, 0, 4, 0, 0, 0],
      wave1Open: 20,
      wave2Open: 0,
    });
    const secondRun = classifyForecastDrift({
      current: fixture.current,
      priorAuthority: { status: "valid", record: inadmissible.current.record },
      normalizedIssues: fixture.normalizedIssues,
      nowMs: NOW,
    });
    expect(secondRun.rowResults.get(WAVE_1.number).driftCell).toBe("?");
    expect(secondRun.priorDiagnostic).toBeNull();
    const steady = classifyForecastDrift({
      current: fixture.current,
      priorAuthority: { status: "valid", record: fixture.current.record },
      normalizedIssues: fixture.normalizedIssues,
      nowMs: NOW,
    });
    expect(steady.rowResults.get(WAVE_1.number).driftCell).toBe("0d · no-transition");

    const closedWave1 = { ...WAVE_1, state: "closed" };
    const priorCatalog = buildForecastMilestoneCatalog([WAVE_2], [CLOSED_WAVE_0, closedWave1]);
    const currentCatalog = buildForecastMilestoneCatalog([WAVE_1, WAVE_2], [CLOSED_WAVE_0]);
    const priorIssues = [
      ...completionIssues(Array(14).fill(1)),
      ...openForecastIssues(1, closedWave1),
      ...openForecastIssues(1, WAVE_2, 100),
    ];
    const currentIssues = priorIssues.map((issue) =>
      issue.milestone?.number === WAVE_1.number ? { ...issue, milestone: WAVE_1 } : issue,
    );
    const normalize = (issues, catalog) => {
      const byNumber = new Map(catalog.map((milestone) => [milestone.number, milestone]));
      return issues.map((issue) => normalizeForecastIssue(issue, byNumber, NOW));
    };
    const priorReopen = deriveForecastInputs({
      catalog: priorCatalog,
      normalizedIssues: normalize(priorIssues, priorCatalog),
      nowMs: NOW,
    });
    const currentReopenNormalized = normalize(currentIssues, currentCatalog);
    const currentReopen = deriveForecastInputs({
      catalog: currentCatalog,
      normalizedIssues: currentReopenNormalized,
      nowMs: NOW,
    });
    const reopened = classifyForecastDrift({
      current: currentReopen,
      priorAuthority: { status: "valid", record: priorReopen.record },
      normalizedIssues: currentReopenNormalized,
      nowMs: NOW,
    });
    expect(reopened.rowResults.get(WAVE_1.number).driftCell).toBe("?");
    expect(reopened.rowResults.get(WAVE_2.number)).toMatchObject({
      driftCell: "+1d · scope",
      transitionClass: "scope",
    });
    expect(reopened).toMatchObject({ unavailableRows: 1, unobservableIdentityCount: 0, priorDiagnostic: null });
    const reopenedSteady = classifyForecastDrift({
      current: currentReopen,
      priorAuthority: { status: "valid", record: currentReopen.record },
      normalizedIssues: currentReopenNormalized,
      nowMs: NOW,
    });
    expect([...reopenedSteady.rowResults.values()].map(({ driftCell }) => driftCell)).toEqual([
      "0d · no-transition",
      "0d · no-transition",
    ]);
  });

  it("classifies completion only from retained estimator membership", () => {
    const fixture = deriveFixture({ wave1Open: 1, wave2Open: 1 });
    const prior = structuredClone(fixture.current.record);
    prior.closureDays14[0].count -= 1;
    prior.closureDays14[1].count += 1;
    const drift = classifyForecastDrift({
      current: fixture.current,
      priorAuthority: { status: "valid", record: prior },
      normalizedIssues: fixture.normalizedIssues,
      nowMs: NOW,
    });
    expect([...drift.rowResults.values()].map(({ transitionClass }) => transitionClass)).toEqual([
      "completion",
      "completion",
    ]);
    const stateOnly = classifyForecastDrift({
      current: fixture.current,
      priorAuthority: { status: "valid", record: fixture.current.record },
      normalizedIssues: fixture.normalizedIssues,
      nowMs: NOW,
    });
    expect([...stateOnly.rowResults.values()].map(({ transitionClass }) => transitionClass)).toEqual([
      "no-transition",
      "no-transition",
    ]);
  });

  it("attributes scope only to reached cumulative prefixes", () => {
    const fixture = deriveFixture({ wave1Open: 1, wave2Open: 1 });
    const prior = structuredClone(fixture.current.record);
    const moved = prior.milestones.find(({ number }) => number === WAVE_2.number).openEligibleIssueNumbers.pop();
    prior.milestones.find(({ number }) => number === WAVE_1.number).openEligibleIssueNumbers.push(moved);
    const drift = classifyForecastDrift({
      current: fixture.current,
      priorAuthority: { status: "valid", record: prior },
      normalizedIssues: fixture.normalizedIssues,
      nowMs: NOW,
    });
    expect(drift.rowResults.get(WAVE_1.number).transitionClass).toBe("scope");
    expect(drift.rowResults.get(WAVE_2.number).transitionClass).toBe("scope");

    const latePrior = structuredClone(fixture.current.record);
    const lateNumber = latePrior.milestones.find(({ number }) => number === WAVE_2.number).openEligibleIssueNumbers[0];
    const currentEntry = fixture.normalizedIssues.find(({ issue }) => issue.number === lateNumber);
    currentEntry.eligible = false;
    const late = classifyForecastDrift({
      current: fixture.current,
      priorAuthority: { status: "valid", record: latePrior },
      normalizedIssues: fixture.normalizedIssues,
      nowMs: NOW,
    });
    expect(late.rowResults.get(WAVE_1.number).transitionClass).toBe("no-transition");
    expect(late.rowResults.get(WAVE_2.number).transitionClass).toBe("scope");
  });

  it("bounds mixed unknown while preserving determinate completion", () => {
    const fixture = deriveFixture({ wave1Open: 1, wave2Open: 1 });
    const prior = structuredClone(fixture.current.record);
    const wave2Identity = prior.milestones.find(({ number }) => number === WAVE_2.number).openEligibleIssueNumbers[0];
    prior.milestones.find(({ number }) => number === WAVE_2.number).openEligibleIssueNumbers = [];
    const currentEntry = fixture.normalizedIssues.find(({ issue }) => issue.number === wave2Identity);
    currentEntry.issue.created_at = "2026-07-01T00:00:00Z";
    prior.closureDays14[0].count -= 1;
    prior.closureDays14[1].count += 1;
    const drift = classifyForecastDrift({
      current: fixture.current,
      priorAuthority: { status: "valid", record: prior },
      normalizedIssues: fixture.normalizedIssues,
      nowMs: NOW,
    });
    expect(drift.rowResults.get(WAVE_1.number).transitionClass).toBe("completion");
    expect(drift.rowResults.get(WAVE_2.number).driftCell).toBe("?");
    expect(drift).toMatchObject({ unavailableRows: 1, unobservableIdentityCount: 1 });

    const mobile1 = { number: 143, title: "Mobile 1", state: "open", due_on: null };
    const catalog = buildForecastMilestoneCatalog([WAVE_1, WAVE_2, mobile1], [CLOSED_WAVE_0]);
    const issues = [
      ...completionIssues(Array(14).fill(1)),
      ...openForecastIssues(1, WAVE_1, 10),
      ...openForecastIssues(1, WAVE_2, 20),
      ...openForecastIssues(1, mobile1, 30),
    ];
    const byNumber = new Map(catalog.map((milestone) => [milestone.number, milestone]));
    const normalizedIssues = issues.map((issue) => normalizeForecastIssue(issue, byNumber, NOW));
    const current = deriveForecastInputs({ catalog, normalizedIssues, nowMs: NOW });
    const repeatedPrior = structuredClone(current.record);
    repeatedPrior.milestones.find(({ number }) => number === WAVE_1.number).openEligibleIssueNumbers = [];
    const repeated = classifyForecastDrift({
      current,
      priorAuthority: { status: "valid", record: repeatedPrior },
      normalizedIssues,
      nowMs: NOW,
    });
    expect([...repeated.rowResults.values()].map(({ driftCell }) => driftCell)).toEqual(["?", "?", "?"]);
    expect(repeated).toMatchObject({ unavailableRows: 3, unobservableIdentityCount: 1 });
  });

  it("pins every generated-block production in the authoritative literal grammar", () => {
    const fixture = deriveFixture({ wave1Open: 1, wave2Open: 0 });
    const drift = classifyForecastDrift({
      current: fixture.current,
      priorAuthority: { status: "valid", record: fixture.current.record },
      normalizedIssues: fixture.normalizedIssues,
      nowMs: NOW,
    });
    const summary = summarizeWaves({
      milestones: [WAVE_1, WAVE_2, DEFERRED, OPERATIONS],
      issues: fixture.issues,
      scopeGrowthByIssue: knownGrowth(fixture.issues),
      nowMs: NOW,
    });
    summary.forecast = createForecastPresentation({ current: fixture.current, drift, nowMs: NOW });
    const markdown = renderRoadmapStatus(summary);
    expect(markdown.indexOf(FORECAST_TABLE_HEADER)).toBeLessThan(markdown.indexOf("Forecast estimator:"));
    expect(markdown.indexOf("Forecast estimator:")).toBeLessThan(markdown.indexOf("Executable backlog:"));
    expect(markdown).toContain("| Wave 1 | 2026-07-29 | 0d · no-transition |");
    expect(markdown).toContain("| Wave 2 | 2026-07-29 | 0d · no-transition |");
    expect(markdown).toContain("| Deferred / Incubation _(not executable)_ | — | — |");
    expect(markdown).toContain("Drift alert (≥7d): none.");
    expect(markdown).not.toContain("| Outcome | Target |");
    const retainedIndex = markdown.indexOf("<!-- roadmap-forecast-inputs:");
    expect(retainedIndex).toBeGreaterThan(markdown.indexOf("**Refined ≡ classified**"));
    expect(markdown.slice(retainedIndex)).toMatch(
      /^<!-- roadmap-forecast-inputs:\{.*\} -->\n<!-- roadmap-status:end -->$/s,
    );
  });

  it("binds backlog-model forecast and gate literals to generator constants", () => {
    const docs = readFileSync(path.join(repoRoot, "docs", "contributing", "backlog-model.md"), "utf8");
    for (const literal of [
      "Milestone = outcome-set membership and exit-gate closure",
      "Blocker** is a correctness edge only, never a scheduling opinion",
      "`priority:p0` preempts an active lane",
      "`priority:p1` wins the next",
      "`priority:p2` is normal work",
      "`priority:p3` is",
      "never a statement of business",
      "Dispatch rank** is a sparse within-wave fine order evaluated before",
      "Every open milestone has `due_on: null`, including `Deferred / Incubation` and",
      "An externally committed date belongs on the specific gate issue",
      "drained merge queue with no sibling pull request",
      "FORECAST_SAMPLE_BELOW_14",
      "FORECAST_ACTIVE_DAYS_BELOW_7",
      "FORECAST_DAY_SHARE_ABOVE_25_PERCENT",
      "FORECAST_7D_14D_RATE_DISAGREEMENT_ABOVE_25_PERCENT",
      "derived forecast, not a commitment",
      "Only absolute changes of at least",
      "unavailable-row and distinct",
    ])
      expect(docs).toContain(literal);
    expect(FORECAST_TABLE_HEADER).toContain("Forecast | Drift");
  });

  it("exhausts every forecast authority before rendering or patching", async () => {
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
    expect(markdown).toContain("| Deferred / Incubation _(not executable)_ | — | — | 1 |");
    expect(markdown).toContain("| Operations _(not executable)_ | — | — | 1 |");
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
    expect(markdown).toContain("| Wave 1 | — | — | 1 | 0 (0%) | 1 | 0/1 | 0 | 0 | ? |");
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
