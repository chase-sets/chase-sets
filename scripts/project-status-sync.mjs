import process from "node:process";

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

const EPIC_LABEL = "kind:epic";

export function deriveStatus(issue) {
  const labels = (issue.labels ?? []).map((label) => label.name ?? label);
  if (labels.includes(EPIC_LABEL)) return null; // epics roll up; they are not dispatchable

  if ((issue.blockedBy ?? 0) > 0) return "Blocked";

  const milestone = issue.milestone?.title ?? null;
  if (!milestone || NON_EXECUTABLE_MILESTONES.includes(milestone)) return "Backlog";

  const refined =
    labels.some((name) => name.startsWith("priority:")) &&
    labels.some((name) => name.startsWith("area:")) &&
    labels.some((name) => name.startsWith("kind:"));

  return refined ? "Refined" : "Backlog";
}

export function planStatusUpdates(items) {
  const updates = [];
  for (const item of items) {
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

const ITEMS_QUERY = `
query($project:ID!, $after:String) {
  node(id:$project) {
    ... on ProjectV2 {
      items(first:100, after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          content {
            ... on Issue {
              number
              milestone { title }
              labels(first:30) { nodes { name } }
              issueDependenciesSummary { blockedBy }
            }
          }
        }
      }
    }
  }
}`;

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
      if (!node.content?.number) continue;
      items.push({
        itemId: node.id,
        status: node.fieldValueByName?.name ?? null,
        issue: {
          number: node.content.number,
          milestone: node.content.milestone,
          labels: node.content.labels.nodes,
          blockedBy: node.content.issueDependenciesSummary?.blockedBy ?? 0,
        },
      });
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

  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("project-status-sync.mjs")) {
  process.exitCode = await main();
}
