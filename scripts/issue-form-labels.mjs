import process from "node:process";

// Applies the slice form's Priority / Owning context / Kind answers as labels.
// The form itself cannot set conditional labels, so the ready-gate metadata
// would otherwise depend on the author remembering to label by hand — which is
// how 292 of 522 open slices ended up with no priority at all.
//
// Additive only: this never removes a label a human or the planner set.

const FIELDS = [
  { heading: "Priority", prefix: "priority:", allowed: ["p0", "p1", "p2", "p3"] },
  {
    heading: "Owning context",
    prefix: "area:",
    allowed: [
      "auth",
      "catalog",
      "checkout",
      "collections",
      "commercial-terms",
      "design-system",
      "discovery",
      "fulfillment",
      "identity",
      "infrastructure",
      "inventory",
      "marketplace",
      "marketplace-web",
      "notifications",
      "ops",
      "ordering",
      "payments",
      "platform-runtime",
      "pricing",
      "public-presence",
      "settlement",
      "support",
      "tax",
    ],
  },
  { heading: "Kind", prefix: "kind:", allowed: ["product", "tech-debt", "security", "test", "ops"] },
];

const NO_RESPONSE = "_no response_";

export function readFormField(body, heading) {
  const text = String(body ?? "");
  const pattern = new RegExp(`^###\\s+${heading}\\s*$`, "im");
  const match = pattern.exec(text);
  if (!match) return null;

  const rest = text.slice(match.index + match[0].length);
  const nextHeading = rest.search(/^###\s+/m);
  const block = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  if (!block || block.toLowerCase() === NO_RESPONSE) return null;

  // Dropdown answers are a single line; take it and ignore any trailing prose.
  return block.split("\n")[0].trim();
}

export function parseIssueFormLabels(body) {
  const labels = [];
  for (const field of FIELDS) {
    const value = readFormField(body, field.heading);
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (!field.allowed.includes(normalized)) continue;
    labels.push(`${field.prefix}${normalized}`);
  }
  return labels;
}

export function labelsToAdd(body, existing = []) {
  const have = new Set(existing.map((label) => label.name ?? label));
  return parseIssueFormLabels(body).filter((label) => {
    if (have.has(label)) return false;
    // One label per family: never fight a deliberate reclassification.
    const family = label.slice(0, label.indexOf(":") + 1);
    return ![...have].some((name) => name.startsWith(family));
  });
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const issueNumber = process.env.ISSUE_NUMBER;
  if (!repo || !token || !issueNumber) {
    console.error("GITHUB_REPOSITORY, GITHUB_TOKEN and ISSUE_NUMBER are required.");
    return 2;
  }

  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };

  const issueResponse = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, { headers });
  if (!issueResponse.ok) {
    throw new Error(`Failed to read issue: ${issueResponse.status} ${await issueResponse.text()}`);
  }
  const issue = await issueResponse.json();

  const add = labelsToAdd(issue.body, issue.labels);
  if (add.length === 0) {
    console.log("No form labels to add.");
    return 0;
  }

  const addResponse = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ labels: add }),
  });
  if (!addResponse.ok) {
    throw new Error(`Failed to add labels: ${addResponse.status} ${await addResponse.text()}`);
  }

  console.log(`Applied: ${add.join(", ")}`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("issue-form-labels.mjs")) {
  process.exitCode = await main();
}
