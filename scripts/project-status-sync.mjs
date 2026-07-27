import process from "node:process";
import { classified, isEpic as classifiedEpic, isTrackingOnly } from "./backlog-classify.mjs";

// Recomputes the delivery board's Status field from the facts that already
// exist on each issue: its blocking dependencies, its milestone, and its
// labels. Without this the field is a snapshot taken on the day the board was
// built — a slice whose blocker closed would sit in Blocked forever, which is
// the same rot that made the hand-typed roadmap table untrustworthy.
//
// Lane states (In lane / In review / Landed) are owned by the orchestrator and
// by GitHub's own PR automation. This job never overwrites them; it only
// maintains the three states it can derive.

export const DERIVED_STATUSES = Object.freeze(["Backlog", "Refined", "Blocked"]);
export const NON_EXECUTABLE_MILESTONES = Object.freeze(["Deferred / Incubation", "Operations"]);

export function toBacklogInput(issue) {
  const issueTypeName = Object.hasOwn(issue, "issueTypeName")
    ? issue.issueTypeName
    : (issue.type?.name ?? issue.issueType?.name ?? null);
  const blockedByCount = Object.hasOwn(issue, "blockedByCount") ? issue.blockedByCount : issue.blockedBy;
  const hasParent = Object.hasOwn(issue, "hasParent")
    ? issue.hasParent
    : Object.hasOwn(issue, "parent")
      ? issue.parent !== null
      : undefined;

  return {
    number: issue.number,
    state: typeof issue.state === "string" ? issue.state.toLowerCase() : issue.state,
    labels: Array.isArray(issue.labels) ? issue.labels.map((label) => label.name ?? label) : issue.labels,
    issueTypeName,
    milestoneTitle: issue.milestone?.title ?? null,
    blockedByCount,
    hasParent,
  };
}

// Kept as a caller-facing compatibility seam; the decision itself lives in
// backlog-classify.mjs.
export function isEpic(issue) {
  return classifiedEpic(toBacklogInput(issue));
}

export function deriveStatus(issue) {
  const input = toBacklogInput(issue);
  if (classifiedEpic(input)) return null; // epics roll up; they are not dispatchable
  if (isTrackingOnly(input)) return null; // continuity records keep their existing board value

  if (input.blockedByCount > 0) return "Blocked";

  return classified(input) ? "Refined" : "Backlog";
}

// GitHub's Roadmap layout cannot plot the built-in Milestone field, so the
// board carries a real Date field derived from the milestone's due date.
// Derived, not hand-set: re-dating a milestone re-dates every one of its items.
export function deriveTargetDate(issue) {
  const dueOn = issue.milestone?.dueOn ?? issue.milestone?.due_on ?? null;
  return dueOn ? String(dueOn).slice(0, 10) : null;
}

export function planDateUpdates(items) {
  const updates = [];
  for (const item of items) {
    const next = deriveTargetDate(item.issue);
    if (!next) continue; // undated milestones (Deferred, Operations) stay blank
    if (item.targetDate === next) continue;
    updates.push({ itemId: item.itemId, number: item.issue.number, from: item.targetDate ?? "(none)", to: next });
  }
  return updates;
}

export function planStatusUpdates(items) {
  const updates = [];
  for (const item of items) {
    // Closed items keep their terminal board snapshot. Classification is an
    // open-backlog contract, so rewriting closed history to Backlog would be a
    // destructive transition with no dispatch value.
    if (toBacklogInput(item.issue).state === "closed") continue;
    const next = deriveStatus(item.issue);
    if (next === null) continue;
    // Never clobber a lane-owned state.
    if (item.status && !DERIVED_STATUSES.includes(item.status)) continue;
    if (item.status === next) continue;
    updates.push({ itemId: item.itemId, number: item.issue.number, from: item.status ?? "(none)", to: next });
  }
  return updates;
}

async function graphql(query, variables, token) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(`GraphQL failed: ${response.status} ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return payload.data;
}

export const ITEMS_QUERY = `
query($project:ID!, $after:String) {
  node(id:$project) {
    ... on ProjectV2 {
      items(first:100, after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          status: fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          targetDate: fieldValueByName(name:"Target date") { ... on ProjectV2ItemFieldDateValue { date } }
          content {
            ... on Issue {
              number
              state
              issueType { name }
              parent { number }
              milestone { title dueOn }
              labels(first:30) { nodes { name } }
              issueDependenciesSummary { blockedBy }
            }
          }
        }
      }
    }
  }
}`;

export function projectItemFromNode(node) {
  if (!node.content?.number) return null;
  return {
    itemId: node.id,
    status: node.status?.name ?? null,
    targetDate: node.targetDate?.date ? String(node.targetDate.date).slice(0, 10) : null,
    issue: {
      number: node.content.number,
      state: typeof node.content.state === "string" ? node.content.state.toLowerCase() : node.content.state,
      issueTypeName: Object.hasOwn(node.content, "issueType") ? (node.content.issueType?.name ?? null) : undefined,
      milestone: node.content.milestone,
      labels: node.content.labels?.nodes?.map((label) => label.name),
      blockedByCount: node.content.issueDependenciesSummary?.blockedBy,
      hasParent: node.content.parent === undefined ? undefined : node.content.parent !== null,
    },
  };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const project = process.env.PROJECT_ID;
  const statusFieldId = process.env.STATUS_FIELD_ID;
  const optionsRaw = process.env.STATUS_OPTION_IDS;
  if (!token || !project || !statusFieldId || !optionsRaw) {
    console.error("GITHUB_TOKEN, PROJECT_ID, STATUS_FIELD_ID and STATUS_OPTION_IDS are required.");
    return 2;
  }
  const optionIds = JSON.parse(optionsRaw);

  const items = [];
  let after = null;
  do {
    const data = await graphql(ITEMS_QUERY, { project, after }, token);
    const page = data.node.items;
    for (const node of page.nodes) {
      const item = projectItemFromNode(node);
      if (item) items.push(item);
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  const updates = planStatusUpdates(items);
  console.log(`${items.length} items scanned, ${updates.length} status changes.`);

  for (const update of updates) {
    const optionId = optionIds[update.to];
    if (!optionId) throw new Error(`No option id configured for status ${update.to}`);
    await graphql(
      `
        mutation ($p: ID!, $i: ID!, $f: ID!, $o: String!) {
          updateProjectV2ItemFieldValue(
            input: { projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }
          ) {
            projectV2Item {
              id
            }
          }
        }
      `,
      { p: project, i: update.itemId, f: statusFieldId, o: optionId },
      token,
    );
    console.log(`  #${update.number}: ${update.from} -> ${update.to}`);
  }

  const dateFieldId = process.env.TARGET_DATE_FIELD_ID;
  if (dateFieldId) {
    const dateUpdates = planDateUpdates(items);
    console.log(`${dateUpdates.length} target-date changes.`);
    for (const update of dateUpdates) {
      await graphql(
        `
          mutation ($p: ID!, $i: ID!, $f: ID!, $d: Date!) {
            updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { date: $d } }) {
              projectV2Item {
                id
              }
            }
          }
        `,
        { p: project, i: update.itemId, f: dateFieldId, d: update.to },
        token,
      );
      console.log(`  #${update.number}: ${update.from} -> ${update.to}`);
    }
  }

  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("project-status-sync.mjs")) {
  process.exitCode = await main();
}
