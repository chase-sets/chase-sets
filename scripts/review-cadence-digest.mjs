import process from "node:process";

const REVIEW_PASS_PATTERN = /\b(?:\d+(?:st|nd|rd|th)\s+)?comprehensive\s+review(?:\s+update)?\b/i;
const LEDGER_PATTERNS = [
  /\bevidence\s+(?:update|row|ledger|matrix)\b/i,
  /\blaunch\s+(?:evidence|matrix|register)\b/i,
  /\blatest[- ]main\s+(?:correction|revalidation)\b/i,
  /\bcurrent[- ]main\s+revalidation\b/i,
];

export const DEFAULT_REVIEW_PASS_LIMIT = 1;
export const DEFAULT_LEDGER_COMMENT_LIMIT = 10;

export function classifyCadenceComment(body) {
  const text = String(body ?? "");
  if (REVIEW_PASS_PATTERN.test(text)) {
    return "review-pass";
  }
  if (LEDGER_PATTERNS.some((pattern) => pattern.test(text))) {
    return "ledger";
  }
  return "other";
}

export function buildCadenceDigest(comments, options = {}) {
  const reviewPassLimit = options.reviewPassLimit ?? DEFAULT_REVIEW_PASS_LIMIT;
  const ledgerCommentLimit = options.ledgerCommentLimit ?? DEFAULT_LEDGER_COMMENT_LIMIT;

  const reviewPasses = [];
  const ledgerComments = [];
  for (const comment of comments) {
    const kind = classifyCadenceComment(comment.body);
    if (kind === "review-pass") {
      reviewPasses.push(comment);
    } else if (kind === "ledger") {
      ledgerComments.push(comment);
    }
  }

  const flagged = reviewPasses.length > reviewPassLimit || ledgerComments.length > ledgerCommentLimit;

  const lines = [
    "## Review cadence digest",
    "",
    `Window: last 7 days. Review passes found: ${reviewPasses.length} (limit ${reviewPassLimit}). Ledger-style comments found: ${ledgerComments.length} (limit ${ledgerCommentLimit}).`,
    "",
  ];

  if (flagged) {
    lines.push(
      "**Flagged.** The anti-ratchet cadence cap was exceeded. Per `docs/launch/checklist.md`, evidence rows belong in the checklist via PR and comprehensive reviews are capped at one per milestone per week.",
      "",
    );
    for (const comment of [...reviewPasses, ...ledgerComments].slice(0, 20)) {
      lines.push(`- ${comment.html_url ?? comment.url ?? "(comment)"}`);
    }
  } else {
    lines.push("Clean: cadence within limits.");
  }

  return { flagged, reviewPassCount: reviewPasses.length, ledgerCommentCount: ledgerComments.length, markdown: lines.join("\n") };
}

async function fetchRecentIssueComments(repo, sinceIso, token) {
  const comments = [];
  let url = `https://api.github.com/repos/${repo}/issues/comments?since=${encodeURIComponent(sinceIso)}&per_page=100&sort=created&direction=desc`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub comments request failed: ${response.status} ${await response.text()}`);
    }
    comments.push(...(await response.json()));

    const link = response.headers.get("link") ?? "";
    const next = link.split(",").find((part) => part.includes('rel="next"'));
    url = next ? next.slice(next.indexOf("<") + 1, next.indexOf(">")) : null;
    if (comments.length >= 1000) {
      break;
    }
  }

  return comments;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    console.error("GITHUB_REPOSITORY and GITHUB_TOKEN are required.");
    return 2;
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const comments = await fetchRecentIssueComments(repo, since, token);
  const digest = buildCadenceDigest(comments);

  console.log(digest.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${digest.markdown}\n`);
  }

  // Advisory by design: flagging is loud (digest + nonzero outcome surfaced as
  // a red scheduled run to notice), but nothing blocks merges or deploys.
  return digest.flagged ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("review-cadence-digest.mjs")) {
  process.exitCode = await main();
}
