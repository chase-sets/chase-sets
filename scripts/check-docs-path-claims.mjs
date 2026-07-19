import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectFiles, defaultSkippedDirectories } from "./lib/files.mjs";
import { normalizeRelative, repoRoot } from "./lib/repo.mjs";

// Docs path-claims guard.
//
// The 2026-07-02 documentation audit's sharpest finding: every
// mechanically-enforced doc surface (the docs index, code<->doc references)
// was spotless, while the unenforced surface -- inline path claims in prose
// and code spans -- had quietly drifted in six docs after files moved or were
// deleted. Docs are agent input; a stale path claim sends an agent (or a
// person) to a file that no longer exists. This guard closes that gap for two
// claim shapes, across every committed Markdown file in the repository:
//
//   (a) Markdown link targets, `[text](relative/path)`, must resolve to a
//       file or directory on disk.
//   (b) Inline-code-span tokens (single backtick-quoted), that start with a
//       tracked repo-root prefix, must resolve to a file or directory on
//       disk.
//
// Heuristics (deliberately conservative -- a noisy guard gets deleted, so an
// ambiguous pattern class is skipped rather than flagged):
//
//   - Only eight repo-root prefixes are scanned for (b): bounded-contexts/,
//     packages/, contracts/, infrastructure/, deployables/, scripts/, docs/,
//     and .github/. `artifacts/` is deliberately excluded: everything under
//     it is generated/gitignored output (evidence JSON, reports, logs), so a
//     fresh checkout never has it and citing it is not a path claim about
//     committed source.
//   - External-repo paths (docs describing another repository's layout, for
//     example the tcgplayer-automation-app client contract) use that repo's
//     own directory names (`app/...`), which never collide with the eight
//     tracked prefixes, so they are excluded by construction rather than
//     allowlisted.
//   - A token containing `*` is a glob/wildcard citation (`mcp*.ts`,
//     `bounded-contexts/*/context.json`), not a literal path claim, and is
//     skipped.
//   - Fenced (triple-backtick) code blocks are out of scope for (b): they
//     illustrate commands/output/examples rather than assert that a path
//     exists in this tree, and scanning them produced no signal beyond noise
//     during development of this guard.
//   - http(s)/mailto links and anchor-only/query-only/absolute (leading "/")
//     link targets are skipped for (a), matching check-docs-index.mjs.
//   - Everything else that still doesn't resolve is an allowlist entry:
//     { file, token, reason }, scoped to the exact file and exact claimed
//     path (mirrors scripts/check-structure/issue-reference-comments.mjs's
//     allowlist shape). Add an entry only for one of the categories the
//     audit actually found: a documented-as-forbidden/retired artifact, an
//     explicitly-future path, or a create-this-file instruction (for example
//     a local-only `.env.local`) -- never to silence a genuine stale
//     reference. Keep it small and per-file.

export const docsPathClaimsGuardedExtension = ".md";

const repoRootPrefixes = [
  "bounded-contexts/",
  "packages/",
  "contracts/",
  "infrastructure/",
  "deployables/",
  "scripts/",
  "docs/",
  ".github/",
];

const pathTokenPattern = new RegExp(
  `(?:${repoRootPrefixes.map((prefix) => prefix.replace(".", "\\.")).join("|")})[A-Za-z0-9_.\\-/*]*`,
  "g",
);

const inlineCodePattern = /`([^`\n]+)`/g;
const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;

// Documented-nonexistence exceptions found by the 2026-07-02 audit. Each entry
// names the exact Markdown file and the exact claimed path text; a different
// path in the same file, or the same path in a different file, still fails.
export const docsPathClaimsAllowlist = [
  {
    file: "docs/architecture/bounded-context-structure.md",
    token: "contracts/dev-seeds",
    reason: "R02 names this as a hard-coded retired artifact that must not exist; the structure gate enforces it.",
  },
  {
    file: "docs/architecture/bounded-context-structure.md",
    token: "contracts/sellable-units",
    reason: "R02 names this as a hard-coded retired artifact that must not exist; the structure gate enforces it.",
  },
  {
    file: "docs/adr/0012-unified-outbound-messaging.md",
    token: "contracts/communications-email",
    reason: "ADR 0012 documents this package as retired in favor of contracts/outbound-messaging.",
  },
  {
    file: "docs/adr/0012-unified-outbound-messaging.md",
    token: "infrastructure/transactional-email-outbox",
    reason: "ADR 0012 documents this outbox as retired in favor of infrastructure/notification-outbox.",
  },
  {
    file: "docs/architecture/notifications-channel-and-provider-recommendation.md",
    token: "contracts/communications-email",
    reason: "Restates ADR 0012's retirement of this package; same retired artifact, cross-referenced here.",
  },
  {
    file: "docs/architecture/notifications-channel-and-provider-recommendation.md",
    token: "infrastructure/transactional-email-outbox",
    reason: "Restates ADR 0012's retirement of this outbox; same retired artifact, cross-referenced here.",
  },
  {
    file: "docs/architecture/notifications-channel-and-provider-recommendation.md",
    token: "infrastructure/mailchimp-marketing",
    reason: "Explicitly-future path: named as the package to add only once marketing campaigns start.",
  },
  {
    file: "packages/design-system/README.md",
    token: "deployables/design-system-showcase",
    reason: "Documented-as-forbidden retired artifact: the showcase was deleted once and must not be rebuilt.",
  },
  {
    file: "docs/runbooks/money-operations.md",
    token: "deployables/platform-api/.env.local",
    reason: "Create-this-file instruction: a developer-local, gitignored env file, never committed.",
  },
  {
    file: "README.md",
    token: "deployables/platform-api/.env.local",
    reason: "Create-this-file instruction: a developer-local, gitignored env file, never committed.",
  },
  {
    file: "docs/runbooks/digitalocean-platform-deployment.md",
    token: ".github/deployment/production-destructive-change-approved.md",
    reason:
      "Create-this-file instruction: the approval artifact must remain absent until the owner confirms the exact #4055 fingerprint.",
  },
];

const allowlistByFile = new Map();
for (const entry of docsPathClaimsAllowlist) {
  const tokens = allowlistByFile.get(entry.file) ?? new Set();
  tokens.add(entry.token);
  allowlistByFile.set(entry.file, tokens);
}

function isAllowlisted(relativeFile, claimedPath) {
  return allowlistByFile.get(relativeFile)?.has(claimedPath) ?? false;
}

function lineFor(sourceText, index) {
  return sourceText.slice(0, index).split(/\r?\n/).length;
}

function stripTrailingPunctuation(token) {
  return token.replace(/[)\].,;:!?'"]+$/, "");
}

function resolvesOnDisk(rootDir, relativeTarget) {
  const withoutTrailingSlash = relativeTarget.endsWith("/") ? relativeTarget.slice(0, -1) : relativeTarget;
  return existsSync(path.join(rootDir, withoutTrailingSlash));
}

// Extracts inline-code path tokens that start with a tracked repo-root prefix.
// A token containing `*` is a glob/wildcard citation and is skipped.
export function findPathTokenClaims(content) {
  const claims = [];

  for (const codeMatch of content.matchAll(inlineCodePattern)) {
    const codeContent = codeMatch[1];
    const codeStart = codeMatch.index;

    for (const tokenMatch of codeContent.matchAll(pathTokenPattern)) {
      const token = stripTrailingPunctuation(tokenMatch[0]);
      if (token.includes("*")) continue;
      if (repoRootPrefixes.includes(token)) continue; // bare prefix, e.g. a stray "docs/" fragment

      claims.push({ line: lineFor(content, codeStart + tokenMatch.index), token });
    }
  }

  return claims;
}

function normalizeMarkdownLinkTarget(linkTarget) {
  const withoutAnchor = linkTarget.split("#")[0].split("?")[0].trim();
  if (
    withoutAnchor.length === 0 ||
    withoutAnchor.startsWith("http://") ||
    withoutAnchor.startsWith("https://") ||
    withoutAnchor.startsWith("mailto:") ||
    withoutAnchor.startsWith("/")
  ) {
    return null;
  }

  return withoutAnchor;
}

// Extracts relative Markdown link targets (external URLs, mailto links, and
// anchor/query-only fragments are not path claims and are skipped).
export function findMarkdownLinkClaims(content) {
  const claims = [];

  for (const match of content.matchAll(markdownLinkPattern)) {
    const target = normalizeMarkdownLinkTarget(match[1]);
    if (!target) continue;

    claims.push({ line: lineFor(content, match.index), target });
  }

  return claims;
}

export async function collectDocsPathClaimViolations(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const violations = [];

  const markdownFiles = await collectFiles(rootDir, {
    extensions: new Set([docsPathClaimsGuardedExtension]),
    skippedDirectories: defaultSkippedDirectories,
  });

  for (const filePath of markdownFiles) {
    const relativeFile = normalizeRelative(filePath, rootDir);
    const content = readFileSync(filePath, "utf8");
    const sourceDir = path.dirname(filePath);

    for (const claim of findMarkdownLinkClaims(content)) {
      if (resolvesOnDisk(sourceDir, claim.target)) continue;
      if (isAllowlisted(relativeFile, claim.target)) continue;

      violations.push({ file: relativeFile, line: claim.line, claim: claim.target, kind: "link" });
    }

    for (const claim of findPathTokenClaims(content)) {
      if (resolvesOnDisk(rootDir, claim.token)) continue;
      if (isAllowlisted(relativeFile, claim.token)) continue;

      violations.push({ file: relativeFile, line: claim.line, claim: claim.token, kind: "path-token" });
    }
  }

  return violations.sort((left, right) => {
    if (left.file !== right.file) return left.file.localeCompare(right.file);
    return left.line - right.line;
  });
}

function printViolations(violations) {
  console.error("Docs path-claims guard failed.");
  console.error("A Markdown file cites a repo path (a link target or a backtick-quoted token) that does not exist.");
  console.error("Fix the doc to point at the real path, or -- only for a documented-forbidden/retired artifact, an");
  console.error("explicitly-future path, or a create-this-file instruction -- add { file, token, reason } to");
  console.error("docsPathClaimsAllowlist in scripts/check-docs-path-claims.mjs.");
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} [${violation.kind}] ${JSON.stringify(violation.claim)}`);
  }
}

export async function checkDocsPathClaims(options = {}) {
  const violations = await collectDocsPathClaimViolations(options);
  return { passed: violations.length === 0, violations };
}

async function main() {
  const result = await checkDocsPathClaims();

  if (!result.passed) {
    printViolations(result.violations);
    process.exit(1);
  }

  console.log("Docs path claims (links and inline-code repo paths) all resolve on disk.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
