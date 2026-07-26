import process from "node:process";

// Applies a trusted issue author's slice-form Priority / Owning context / Kind
// answers as labels. The form itself cannot set conditional labels, so this
// script mirrors those answers for repository owners, members, and collaborators.
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

// GitHub's CommentAuthorAssociation vocabulary, retrieved 2026-07-26:
// https://docs.github.com/en/graphql/reference/issues#commentauthorassociation
// Keep the trusted partition explicit and fail closed when GitHub adds a value.
// github-actions[bot] currently reports NONE; repository workflows must set
// their labels when creating issues instead of relying on this form labeler.
export function isTrustedAuthorAssociation(association) {
  switch (association) {
    case "OWNER":
    case "MEMBER":
    case "COLLABORATOR":
      return true;
    default:
      return false;
  }
}

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

export async function main({ env = process.env, client = globalThis.fetch, logger = console } = {}) {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const issueNumber = env.ISSUE_NUMBER;
  if (!repo || !token || !issueNumber) {
    logger.error("GITHUB_REPOSITORY, GITHUB_TOKEN and ISSUE_NUMBER are required.");
    return 2;
  }

  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };

  const issueResponse = await client(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, { headers });
  if (!issueResponse.ok) {
    throw new Error(`Failed to read issue: ${issueResponse.status} ${await issueResponse.text()}`);
  }
  const issue = await issueResponse.json();

  if (!isTrustedAuthorAssociation(issue.author_association)) {
    logger.log(`skipped: author association \`${String(issue.author_association)}\` is not trusted.`);
    return 0;
  }

  const add = labelsToAdd(issue.body, issue.labels);
  if (add.length === 0) {
    logger.log("No form labels to add.");
    return 0;
  }

  const addResponse = await client(`https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ labels: add }),
  });
  if (!addResponse.ok) {
    throw new Error(`Failed to add labels: ${addResponse.status} ${await addResponse.text()}`);
  }

  logger.log(`Applied: ${add.join(", ")}`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("issue-form-labels.mjs")) {
  process.exitCode = await main();
}
