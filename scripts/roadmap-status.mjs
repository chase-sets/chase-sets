import process from "node:process";
import { classified, isEpic as classifiedEpic, isTrackingOnly } from "./backlog-classify.mjs";

// Generated status for the program roadmap issue. The contract this reports
// against lives in docs/contributing/backlog-model.md. Numbers are generated
// because a hand-maintained rollup drifted on 5 of 12 rows in two weeks.

export const START_MARKER = "<!-- roadmap-status:start -->";
export const END_MARKER = "<!-- roadmap-status:end -->";

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMELINE_CONCURRENCY = 8;
const NON_EXECUTABLE_MILESTONES = new Set(["Deferred / Incubation", "Operations"]);
const MILESTONE_EVENTS = new Set(["milestoned", "demilestoned"]);

export class RoadmapIssueEnumerationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoadmapIssueEnumerationError";
    this.code = code;
  }
}

export function toBacklogInput(issue) {
  return {
    number: issue.number,
    state: typeof issue.state === "string" ? issue.state.toLowerCase() : issue.state,
    labels: Array.isArray(issue.labels) ? issue.labels.map((label) => label.name ?? label) : issue.labels,
    issueTypeName: Object.hasOwn(issue, "issueTypeName")
      ? issue.issueTypeName
      : (issue.type?.name ?? issue.issueType?.name ?? null),
    milestoneTitle: issue.milestone?.title ?? null,
    blockedByCount: issue.blockedByCount,
    hasParent: issue.hasParent,
  };
}

// Kept as a caller-facing compatibility seam; the decision itself lives in
// backlog-classify.mjs.
export function isEpic(issue) {
  return classifiedEpic(toBacklogInput(issue));
}

export async function collectRoadmapIssueFacts(loadPage) {
  const byNumber = new Map();
  let after = null;
  let expectedTotal = null;
  let collectedCount = 0;

  do {
    const page = await loadPage(after);
    if (
      !page ||
      !Number.isInteger(page.totalCount) ||
      page.totalCount < 0 ||
      !Array.isArray(page.nodes) ||
      typeof page.pageInfo?.hasNextPage !== "boolean"
    ) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_ISSUE_PAGE_INVALID",
        "Repository issue enumeration returned an invalid page.",
      );
    }
    if (expectedTotal === null) expectedTotal = page.totalCount;
    if (page.totalCount !== expectedTotal) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_ISSUE_TOTAL_CHANGED",
        `Repository issue total changed during enumeration (${expectedTotal} -> ${page.totalCount}).`,
      );
    }

    for (const node of page.nodes) {
      if (
        typeof node?.number !== "number" ||
        !Object.hasOwn(node, "state") ||
        !Object.hasOwn(node, "issueType") ||
        !Object.hasOwn(node, "parent") ||
        !Object.hasOwn(node, "issueDependenciesSummary")
      ) {
        throw new RoadmapIssueEnumerationError(
          "ROADMAP_ISSUE_NODE_INVALID",
          "Repository issue enumeration returned an issue with missing classification facts.",
        );
      }
      collectedCount += 1;
      byNumber.set(node.number, {
        state: typeof node.state === "string" ? node.state.toLowerCase() : node.state,
        issueTypeName: node.issueType?.name ?? null,
        blockedByCount: node.issueDependenciesSummary?.blockedBy,
        hasParent: node.parent !== null,
      });
    }

    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_ISSUE_PAGINATION_INCOMPLETE",
        "Repository issue enumeration has another page but no end cursor.",
      );
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  if (expectedTotal === null || collectedCount !== expectedTotal || byNumber.size !== expectedTotal) {
    throw new RoadmapIssueEnumerationError(
      "ROADMAP_ISSUE_COUNT_MISMATCH",
      `Repository issue enumeration collected ${collectedCount} rows (${byNumber.size} unique) but reported ${expectedTotal}.`,
    );
  }

  return byNumber;
}

export function mergeRoadmapIssueFacts(issue, issueFacts) {
  if (!issueFacts) {
    throw new RoadmapIssueEnumerationError(
      "ROADMAP_ISSUE_FACT_MISSING",
      `Repository issue enumeration omitted #${issue.number}.`,
    );
  }
  return { ...issue, ...issueFacts };
}

function pct(part, total) {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}

function isExecutableMilestone(title) {
  return typeof title === "string" && title.length > 0 && !NON_EXECUTABLE_MILESTONES.has(title);
}

function isGrowthScopeIssue(issue) {
  const input = toBacklogInput(issue);
  return !classifiedEpic(input) && !isTrackingOnly(input) && isExecutableMilestone(input.milestoneTitle);
}

export function timelineFetchRequired(issue, cutoffMs) {
  if (!isGrowthScopeIssue(issue)) return false;
  const createdAtMs = Date.parse(issue.created_at);
  const updatedAtMs = Date.parse(issue.updated_at);
  return (
    Number.isFinite(createdAtMs) && Number.isFinite(updatedAtMs) && createdAtMs < cutoffMs && updatedAtMs >= cutoffMs
  );
}

export function selectTimelineIssues({ issues, nowMs, windowDays = 7 }) {
  const cutoffMs = nowMs - windowDays * DAY_MS;
  return issues.filter((issue) => timelineFetchRequired(issue, cutoffMs));
}

function knownEntry(enteredAtMs, source) {
  return { status: "known", enteredAtMs, source };
}

function unknownEntry(reason) {
  return { status: "unknown", reason };
}

export function resolveCurrentMilestoneEntry(issue, timeline) {
  const currentTitle = issue.milestone?.title;
  const milestoneEvents = timeline.filter((event) => MILESTONE_EVENTS.has(event?.event));
  const matchingEntries = milestoneEvents.filter(
    (event) => event.event === "milestoned" && event.milestone?.title === currentTitle,
  );

  if (matchingEntries.length > 0) {
    const timestamps = matchingEntries.map((event) => Date.parse(event.created_at));
    if (timestamps.some((timestamp) => !Number.isFinite(timestamp))) {
      return unknownEntry("matching milestone entry has an invalid timestamp");
    }
    return knownEntry(Math.max(...timestamps), "latest-milestoned-event");
  }

  if (milestoneEvents.length > 0) {
    return unknownEntry(`milestone history has no entry titled "${currentTitle}"`);
  }

  const createdAtMs = Date.parse(issue.created_at);
  return Number.isFinite(createdAtMs)
    ? knownEntry(createdAtMs, "created-at-with-zero-milestone-events")
    : unknownEntry("zero milestone events and an invalid issue creation timestamp");
}

async function mapConcurrent(items, concurrency, task) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}

export async function collectScopeGrowth({
  issues,
  nowMs,
  windowDays = 7,
  loadTimeline,
  concurrency = TIMELINE_CONCURRENCY,
}) {
  const cutoffMs = nowMs - windowDays * DAY_MS;
  const byIssue = new Map();
  const selectedIssues = selectTimelineIssues({ issues, nowMs, windowDays });
  const selectedNumbers = new Set(selectedIssues.map((issue) => issue.number));

  for (const issue of issues.filter(isGrowthScopeIssue)) {
    const createdAtMs = Date.parse(issue.created_at);
    const updatedAtMs = Date.parse(issue.updated_at);
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs)) {
      byIssue.set(issue.number, unknownEntry("issue creation or update timestamp is invalid"));
    } else if (createdAtMs >= cutoffMs) {
      // A current member created inside the window necessarily entered its
      // current scope inside the window, so D4 does not spend a timeline fetch.
      byIssue.set(issue.number, knownEntry(createdAtMs, "created-in-window"));
    } else if (!selectedNumbers.has(issue.number)) {
      // Milestone changes update the issue. An older updated_at proves that
      // this issue could not have entered its current scope inside the window.
      byIssue.set(issue.number, knownEntry(null, "not-updated-in-window"));
    }
  }

  if (selectedIssues.length > 0 && typeof loadTimeline !== "function") {
    throw new TypeError("loadTimeline is required when the D4 predicate selects an issue.");
  }

  await mapConcurrent(selectedIssues, concurrency, async (issue) => {
    const timeline = await loadTimeline(issue);
    if (!Array.isArray(timeline)) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_TIMELINE_INVALID",
        `Timeline for issue #${issue.number} did not return an array.`,
      );
    }
    byIssue.set(issue.number, resolveCurrentMilestoneEntry(issue, timeline));
  });

  return { byIssue, selectedIssues };
}

export function reconcileEpicChildren(epic, children) {
  const expectedTotal = epic.sub_issues_summary?.total;
  if (!Number.isInteger(expectedTotal) || expectedTotal < 0) {
    throw new RoadmapIssueEnumerationError(
      "ROADMAP_EPIC_CHILD_TOTAL_INVALID",
      `Epic #${epic.number} has no valid sub_issues_summary.total.`,
    );
  }
  if (!Array.isArray(children) || children.some((child) => !Number.isInteger(child?.number))) {
    throw new RoadmapIssueEnumerationError(
      "ROADMAP_EPIC_CHILD_PAGE_INVALID",
      `Epic #${epic.number} returned an invalid sub-issue collection.`,
    );
  }

  const uniqueCount = new Set(children.map((child) => child.number)).size;
  if (children.length !== expectedTotal || uniqueCount !== expectedTotal) {
    throw new RoadmapIssueEnumerationError(
      "ROADMAP_EPIC_CHILD_COUNT_MISMATCH",
      `Epic #${epic.number} collected ${children.length} children (${uniqueCount} unique) but sub_issues_summary.total reported ${expectedTotal}.`,
    );
  }
  return children;
}

export async function collectEpicChildren({ epics, loadChildren, concurrency = TIMELINE_CONCURRENCY }) {
  const byEpic = new Map();
  await mapConcurrent(epics, concurrency, async (epic) => {
    const children = reconcileEpicChildren(epic, await loadChildren(epic));
    byEpic.set(
      epic.number,
      children.map((child) => ({ number: child.number, state: child.state, milestone: child.milestone })),
    );
  });
  return byEpic;
}

/**
 * @param issues all repository issues (open and closed), excluding pull requests
 * @param epicChildren Map<epicNumber, Array<{number, state, milestone}>>
 * @param scopeGrowthByIssue Map<issueNumber, known-or-unknown milestone entry>
 * @param nowMs timestamp used for the "added recently" window
 */
export function summarizeWaves({
  milestones,
  issues,
  epicChildren = new Map(),
  scopeGrowthByIssue,
  nowMs,
  windowDays = 7,
}) {
  if (!(scopeGrowthByIssue instanceof Map)) {
    throw new TypeError("scopeGrowthByIssue must be a Map produced by collectScopeGrowth.");
  }

  const entries = issues.map((issue) => ({ issue, input: toBacklogInput(issue) }));
  const slices = entries.filter(({ input }) => !classifiedEpic(input));
  const epics = entries.filter(({ input }) => classifiedEpic(input));
  const cutoff = nowMs - windowDays * DAY_MS;

  // An epic's wave is the earliest-dated wave among its children: epics are
  // unmilestoned by contract, so they have no wave of their own.
  const milestoneOrder = new Map(milestones.map((milestone, index) => [milestone.title, index]));
  const epicWave = new Map();
  for (const { issue: epic } of epics) {
    const children = epicChildren.get(epic.number) ?? [];
    let best = null;
    for (const child of children) {
      const title = child.milestone?.title;
      if (!title || !milestoneOrder.has(title)) continue;
      if (best === null || milestoneOrder.get(title) < milestoneOrder.get(best)) best = title;
    }
    if (best) epicWave.set(epic.number, best);
  }

  const rows = milestones.map((milestone) => {
    const waveSlices = slices.filter(({ issue }) => issue.milestone?.title === milestone.title);
    const tracking = waveSlices.filter(({ input }) => isTrackingOnly(input));
    const mine = waveSlices.filter(({ input }) => !isTrackingOnly(input));
    const closed = mine.filter(({ input }) => input.state === "closed");
    const open = mine.filter(({ input }) => input.state === "open");
    const executable = isExecutableMilestone(milestone.title);
    let addedRecently = 0;
    let growthUnknown = 0;

    if (executable) {
      for (const { issue } of mine) {
        const entry = scopeGrowthByIssue.get(issue.number);
        if (!entry || entry.status !== "known") {
          growthUnknown += 1;
        } else if (entry.enteredAtMs !== null && entry.enteredAtMs >= cutoff) {
          addedRecently += 1;
        }
      }
    }

    const classifiedOpen = open.filter(({ input }) => classified(input));
    const waveEpics = epics.filter(({ issue: epic }) => epicWave.get(epic.number) === milestone.title);
    const completeEpics = waveEpics.filter(({ issue: epic }) => {
      const children = epicChildren.get(epic.number) ?? [];
      return children.length > 0 && children.every((child) => child.state === "closed");
    });

    return {
      title: milestone.title,
      dueOn: milestone.due_on ? milestone.due_on.slice(0, 10) : "—",
      executable,
      total: mine.length,
      closed: closed.length,
      open: open.length,
      percent: pct(closed.length, mine.length),
      addedRecently,
      growthUnknown,
      refinedOpen: classifiedOpen.length,
      parentlessClassified: classifiedOpen.filter(({ input }) => !input.hasParent).length,
      tracking: tracking.length,
      epicsTotal: waveEpics.length,
      epicsComplete: completeEpics.length,
    };
  });

  return { rows, windowDays };
}

export function renderRoadmapStatus(summary) {
  const lines = [
    START_MARKER,
    "",
    "## Generated status",
    "",
    "Generated by `scripts/roadmap-status.mjs`. Do not edit by hand — edits are overwritten.",
    "Contract: [`docs/contributing/backlog-model.md`](../blob/main/docs/contributing/backlog-model.md).",
    "",
    "| Outcome | Target | Slices | Done | Open | Refined | Parentless _(reported)_ | Tracking | Added (7d) | Epics done |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];

  for (const row of summary.rows) {
    const label = row.executable ? row.title : `${row.title} _(not executable)_`;
    const refinedRatio = row.executable ? `${row.refinedOpen}/${row.open}` : "—";
    const parentless = row.executable ? String(row.parentlessClassified) : "—";
    const epics = row.epicsTotal === 0 ? "—" : `${row.epicsComplete}/${row.epicsTotal}`;
    const growth = !row.executable
      ? "—"
      : row.growthUnknown > 0
        ? "?"
        : row.addedRecently > 0
          ? `+${row.addedRecently}`
          : "0";
    lines.push(
      `| ${label} | ${row.dueOn} | ${row.total} | ${row.closed} (${row.percent}%) | ${row.open} | ${refinedRatio} | ${parentless} | ${row.tracking} | ${growth} | ${epics} |`,
    );
  }

  const executable = summary.rows.filter((row) => row.executable);
  const totalOpen = executable.reduce((sum, row) => sum + row.open, 0);
  const totalRefined = executable.reduce((sum, row) => sum + row.refinedOpen, 0);
  const totalParentless = executable.reduce((sum, row) => sum + row.parentlessClassified, 0);
  const totalAdded = executable.reduce((sum, row) => sum + row.addedRecently, 0);
  const totalGrowthUnknown = executable.reduce((sum, row) => sum + row.growthUnknown, 0);
  const totalTracking = summary.rows.reduce((sum, row) => sum + row.tracking, 0);
  const growthSummary =
    totalGrowthUnknown > 0
      ? `scope growth is **?** (${totalGrowthUnknown} issue${totalGrowthUnknown === 1 ? " has" : "s have"} bounded-unknown entry history)`
      : `${totalAdded} entered current scope in the last ${summary.windowDays} days`;

  lines.push(
    "",
    `Executable backlog: **${totalOpen} open slices**, ${totalRefined} refined (${pct(totalRefined, totalOpen)}%), ${growthSummary}.`,
    "",
    `Parent attachment (reported, not gating): **${totalParentless} classified slices have no parent**. ` +
      `${totalTracking} tracking-only records are shown separately.`,
    "",
    "**Added (7d)** = entered current scope within the window.",
  );

  const unknownRows = executable.filter((row) => row.growthUnknown > 0);
  if (unknownRows.length > 0) {
    lines.push(
      "",
      `Scope-growth diagnostics (bounded unknown): ${unknownRows
        .map((row) => `${row.title}: ${row.growthUnknown} issue${row.growthUnknown === 1 ? "" : "s"}`)
        .join("; ")}.`,
    );
  }

  lines.push(
    "",
    "**Refined ≡ classified** = open, non-Epic, executable milestone + `priority:*` + `area:*` + `kind:*`, excluding `status:tracking-only`. Unrefined far-horizon work is expected, not a defect.",
    "",
    END_MARKER,
  );

  return lines.join("\n");
}

function countOccurrences(text, marker) {
  let count = 0;
  let cursor = 0;
  while (cursor <= text.length - marker.length) {
    const index = text.indexOf(marker, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + marker.length;
  }
  return count;
}

export function spliceIntoBody(body, block) {
  const text = String(body ?? "");
  if (countOccurrences(text, START_MARKER) !== 1 || countOccurrences(text, END_MARKER) !== 1) {
    return null;
  }
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER);
  if (end < start) return null;
  return `${text.slice(0, start)}${block}${text.slice(end + END_MARKER.length)}`;
}

async function gh(pathname, token, init = {}, request = globalThis.fetch) {
  const url = pathname.startsWith("http") ? pathname : `https://api.github.com${pathname}`;
  const response = await request(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${pathname} ${await response.text()}`);
  }
  return response;
}

function nextPageUrl(response) {
  const link = response.headers.get("link") ?? "";
  const next = link.split(",").find((part) => part.includes('rel="next"'));
  if (!next) return null;
  const value = next.slice(next.indexOf("<") + 1, next.indexOf(">"));
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RoadmapIssueEnumerationError("ROADMAP_PAGINATION_LINK_INVALID", `Invalid next-page link: ${value}`);
  }
  if (url.protocol !== "https:" || url.hostname !== "api.github.com") {
    throw new RoadmapIssueEnumerationError("ROADMAP_PAGINATION_LINK_INVALID", `Unsafe next-page link: ${value}`);
  }
  return url.href;
}

export async function paginate(pathname, token, request = globalThis.fetch) {
  const items = [];
  let url = pathname;
  while (url) {
    const response = await gh(url, token, {}, request);
    const page = await response.json();
    if (!Array.isArray(page)) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_PAGINATION_PAGE_INVALID",
        `Paginated GitHub request did not return an array: ${url}`,
      );
    }
    items.push(...page);
    url = nextPageUrl(response);
  }
  return items;
}

const ISSUE_FACTS_QUERY = `
query($owner:String!, $name:String!, $after:String) {
  repository(owner:$owner, name:$name) {
    issues(first:100, after:$after, states:[OPEN,CLOSED]) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        state
        issueType { name }
        parent { number }
        issueDependenciesSummary { blockedBy }
      }
    }
  }
}`;

async function graphql(query, variables, token, request) {
  const response = await gh(
    "https://api.github.com/graphql",
    token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
    request,
  );
  const payload = await response.json();
  if (payload.errors) throw new Error(`GraphQL failed: ${JSON.stringify(payload.errors)}`);
  return payload.data;
}

async function appendStepSummary(env, block) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const { appendFileSync } = await import("node:fs");
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${block}\n`);
}

export async function main({
  env = process.env,
  request = globalThis.fetch,
  nowMs = Date.now(),
  writeOutput = (message) => console.log(message),
  writeError = (message) => console.error(message),
  appendSummary = appendStepSummary,
} = {}) {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const roadmapIssue = env.ROADMAP_ISSUE;
  if (!repo || !token) {
    writeError("ROADMAP_ENV_REQUIRED: GITHUB_REPOSITORY and GITHUB_TOKEN are required.");
    return 2;
  }

  const milestones = (await paginate(`/repos/${repo}/milestones?state=open&per_page=100`, token, request)).sort(
    (a, b) => {
      if (!a.due_on) return 1;
      if (!b.due_on) return -1;
      return a.due_on.localeCompare(b.due_on);
    },
  );
  const raw = await paginate(`/repos/${repo}/issues?state=all&per_page=100`, token, request);
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra) {
    throw new RoadmapIssueEnumerationError("ROADMAP_REPOSITORY_INVALID", `Invalid GITHUB_REPOSITORY: ${repo}`);
  }
  const issueFacts = await collectRoadmapIssueFacts(async (after) => {
    const data = await graphql(ISSUE_FACTS_QUERY, { owner, name, after }, token, request);
    return data.repository?.issues;
  });
  const restIssues = raw.filter((issue) => !issue.pull_request);
  if (restIssues.length !== issueFacts.size) {
    throw new RoadmapIssueEnumerationError(
      "ROADMAP_ISSUE_SOURCE_COUNT_MISMATCH",
      `REST issue enumeration collected ${restIssues.length} issues but GraphQL reconciled ${issueFacts.size}.`,
    );
  }
  const issues = restIssues.map((issue) => mergeRoadmapIssueFacts(issue, issueFacts.get(issue.number)));
  const epics = issues.filter(isEpic);
  const epicChildren = await collectEpicChildren({
    epics,
    loadChildren: (epic) => paginate(`/repos/${repo}/issues/${epic.number}/sub_issues?per_page=100`, token, request),
  });
  const scopeGrowth = await collectScopeGrowth({
    issues,
    nowMs,
    loadTimeline: (issue) => paginate(`/repos/${repo}/issues/${issue.number}/timeline?per_page=100`, token, request),
  });

  const summary = summarizeWaves({
    milestones,
    issues,
    epicChildren,
    scopeGrowthByIssue: scopeGrowth.byIssue,
    nowMs,
  });
  const block = renderRoadmapStatus(summary);
  writeOutput(block);
  await appendSummary(env, block);

  if (roadmapIssue) {
    const current = await (await gh(`/repos/${repo}/issues/${roadmapIssue}`, token, {}, request)).json();
    const next = spliceIntoBody(current.body, block);
    if (next === null) {
      writeError(
        `ROADMAP_MARKERS_INVALID: Issue #${roadmapIssue} must contain exactly one ordered roadmap-status marker pair; leaving the body untouched.`,
      );
      return 1;
    }
    if (next !== current.body) {
      await gh(
        `/repos/${repo}/issues/${roadmapIssue}`,
        token,
        {
          method: "PATCH",
          body: JSON.stringify({ body: next }),
        },
        request,
      );
    }
  }

  return 0;
}

export async function runRoadmapStatus(run = main, writeError = (message) => console.error(message)) {
  try {
    return await run();
  } catch (error) {
    writeError(`${error.name}: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("roadmap-status.mjs")) {
  process.exitCode = await runRoadmapStatus();
}
