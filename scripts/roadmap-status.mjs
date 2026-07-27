import process from "node:process";
import { classified, isEpic as classifiedEpic, isTrackingOnly } from "./backlog-classify.mjs";

// Generated status for the program roadmap issue. The contract this reports
// against lives in docs/contributing/backlog-model.md. Numbers are generated
// because a hand-maintained rollup drifted on 5 of 12 rows in two weeks.

export const START_MARKER = "<!-- roadmap-status:start -->";
export const END_MARKER = "<!-- roadmap-status:end -->";

const NON_EXECUTABLE_MILESTONES = new Set(["Deferred / Incubation", "Operations"]);

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

/**
 * @param issues all repository issues (open and closed), excluding pull requests
 * @param epicChildren Map<epicNumber, Array<{state, milestone}>>
 * @param nowMs timestamp used for the "added recently" window
 */
export function summarizeWaves({ milestones, issues, epicChildren = new Map(), nowMs, windowDays = 7 }) {
  const entries = issues.map((issue) => ({ issue, input: toBacklogInput(issue) }));
  const slices = entries.filter(({ input }) => !classifiedEpic(input));
  const epics = entries.filter(({ input }) => classifiedEpic(input));
  const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1000;

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
    const addedRecently = mine.filter(({ issue }) => Date.parse(issue.created_at) >= cutoff);
    const classifiedOpen = open.filter(({ input }) => classified(input));

    const waveEpics = epics.filter(({ issue: epic }) => epicWave.get(epic.number) === milestone.title);
    const completeEpics = waveEpics.filter(({ issue: epic }) => {
      const children = epicChildren.get(epic.number) ?? [];
      return children.length > 0 && children.every((child) => child.state === "closed");
    });

    return {
      title: milestone.title,
      dueOn: milestone.due_on ? milestone.due_on.slice(0, 10) : "—",
      executable: !NON_EXECUTABLE_MILESTONES.has(milestone.title),
      total: mine.length,
      closed: closed.length,
      open: open.length,
      percent: pct(closed.length, mine.length),
      addedRecently: addedRecently.length,
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
    const growth = row.addedRecently > 0 ? `+${row.addedRecently}` : "0";
    lines.push(
      `| ${label} | ${row.dueOn} | ${row.total} | ${row.closed} (${row.percent}%) | ${row.open} | ${refinedRatio} | ${parentless} | ${row.tracking} | ${growth} | ${epics} |`,
    );
  }

  const executable = summary.rows.filter((row) => row.executable);
  const totalOpen = executable.reduce((sum, row) => sum + row.open, 0);
  const totalRefined = executable.reduce((sum, row) => sum + row.refinedOpen, 0);
  const totalParentless = executable.reduce((sum, row) => sum + row.parentlessClassified, 0);
  const totalAdded = executable.reduce((sum, row) => sum + row.addedRecently, 0);
  const totalTracking = summary.rows.reduce((sum, row) => sum + row.tracking, 0);

  lines.push(
    "",
    `Executable backlog: **${totalOpen} open slices**, ${totalRefined} refined (${pct(totalRefined, totalOpen)}%), ` +
      `${totalAdded} added in the last ${summary.windowDays} days.`,
    "",
    `Parent attachment (reported, not gating): **${totalParentless} classified slices have no parent**. ` +
      `${totalTracking} tracking-only records are shown separately.`,
    "",
    "**Refined ≡ classified** = open, non-Epic, executable milestone + `priority:*` + `area:*` + `kind:*`, excluding `status:tracking-only`. Unrefined far-horizon work is expected, not a defect.",
    "",
    END_MARKER,
  );

  return lines.join("\n");
}

export function spliceIntoBody(body, block) {
  const text = String(body ?? "");
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    // Fail safe: never rewrite a body that has not opted in with markers.
    return null;
  }
  return `${text.slice(0, start)}${block}${text.slice(end + END_MARKER.length)}`;
}

async function gh(pathname, token, init = {}) {
  const url = pathname.startsWith("http") ? pathname : `https://api.github.com${pathname}`;
  const response = await fetch(url, {
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

async function paginate(pathname, token) {
  const items = [];
  let url = pathname;
  while (url) {
    const response = await gh(url, token);
    items.push(...(await response.json()));
    const link = response.headers.get("link") ?? "";
    const next = link.split(",").find((part) => part.includes('rel="next"'));
    url = next ? next.slice(next.indexOf("<") + 1, next.indexOf(">")) : null;
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

async function graphql(query, variables, token) {
  const response = await gh("https://api.github.com/graphql", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (payload.errors) throw new Error(`GraphQL failed: ${JSON.stringify(payload.errors)}`);
  return payload.data;
}

export async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const roadmapIssue = process.env.ROADMAP_ISSUE;
  if (!repo || !token) {
    console.error("GITHUB_REPOSITORY and GITHUB_TOKEN are required.");
    return 2;
  }

  const milestones = (await paginate(`/repos/${repo}/milestones?state=open&per_page=100`, token)).sort((a, b) => {
    if (!a.due_on) return 1;
    if (!b.due_on) return -1;
    return a.due_on.localeCompare(b.due_on);
  });
  const raw = await paginate(`/repos/${repo}/issues?state=all&per_page=100`, token);
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra) {
    throw new RoadmapIssueEnumerationError("ROADMAP_REPOSITORY_INVALID", `Invalid GITHUB_REPOSITORY: ${repo}`);
  }
  const issueFacts = await collectRoadmapIssueFacts(async (after) => {
    const data = await graphql(ISSUE_FACTS_QUERY, { owner, name, after }, token);
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

  const epicChildren = new Map();
  for (const epic of issues.filter(isEpic)) {
    const children = await paginate(`/repos/${repo}/issues/${epic.number}/sub_issues?per_page=100`, token);
    epicChildren.set(
      epic.number,
      children.map((child) => ({ state: child.state, milestone: child.milestone })),
    );
  }

  const summary = summarizeWaves({ milestones, issues, epicChildren, nowMs: Date.now() });
  const block = renderRoadmapStatus(summary);
  console.log(block);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${block}\n`);
  }

  if (roadmapIssue) {
    const current = await (await gh(`/repos/${repo}/issues/${roadmapIssue}`, token)).json();
    const next = spliceIntoBody(current.body, block);
    if (next === null) {
      console.error(`Issue #${roadmapIssue} has no roadmap-status markers; leaving the body untouched.`);
      return 1;
    }
    if (next !== current.body) {
      await gh(`/repos/${repo}/issues/${roadmapIssue}`, token, {
        method: "PATCH",
        body: JSON.stringify({ body: next }),
      });
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
