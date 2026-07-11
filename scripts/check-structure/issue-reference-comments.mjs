import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "../lib/files.mjs";
import { normalizeRelative, repoRoot } from "../lib/repo.mjs";

// Issue-number provenance guard for code comments.
//
// Rationale (2026-07 documentation audit, issue 3548): a hash followed by three
// or more digits in a comment is almost always a closed-issue citation
// explaining *how* a decision was made, not *what* the decision requires going
// forward — GitHub is the durable home for that history, not the source tree.
// A small number of comments are the opposite: they point at a documented
// production incident or an ADR whose exact wording this code must stay in
// lockstep with, and the number is the only way a future reader finds that
// record before "fixing" what looks wrong. Those stay, named explicitly below.
//
// Mirrors check-operator-surface-pm-content.mjs's shape (guarded-file
// predicate + violation collector + allowlist), scoped to comments instead of
// rendered copy: it tokenizes each file with the TypeScript scanner in
// trivia-preserving mode and inspects only comment tokens, so string/template
// literal content (URLs, SQL embedded in a boot-schema template, JSDoc
// examples quoted as data) is never in scope.

export const issueReferenceCommentGuardExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const issueReferenceCommentGuardRoots = ["bounded-contexts/", "infrastructure/", "deployables/", "scripts/"];

const allowedPathSubstrings = ["/__tests__/", "/tests/", "/fixtures/", "/test-fixtures/", "/test-support/"];

// Files named `*-test-support.ts` (a sibling-file convention, not a directory)
// are test-only fixture/helper modules even though they lack a .test. suffix.
const testSupportFileNamePattern = /-test-support\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

const allowedPathSuffixes = [
  ".test.ts",
  ".test.tsx",
  ".test.js",
  ".test.jsx",
  ".test.mjs",
  ".test.cjs",
  ".spec.ts",
  ".spec.tsx",
  ".spec.js",
  ".spec.mjs",
  ".stories.tsx",
  ".d.ts",
];

// A hash immediately followed by three or more digits, e.g. a GitHub issue
// number. Deliberately unbounded on the upper end (unlike the operator-surface
// guard's #\d{3,4}) since issue numbers here have already crossed four digits.
export const issueReferenceCommentPattern = /#\d{3,}/g;
const issueReferenceCommentProbe = new RegExp(issueReferenceCommentPattern.source);

// Comments that cite a real, load-bearing incident or ADR record rather than
// narrating "this shipped in issue N". Each entry names the exact file and the
// exact "#NNNN" text it permits; a different number in the same file, or the
// same number in a different file, still fails. Add an entry here only when the
// comment cannot be understood (or trusted not to be "fixed" back into a bug)
// without following the citation — see the guard failure message for the
// house rule this enforces.
export const issueReferenceCommentAllowlist = [
  {
    file: "bounded-contexts/checkout/features/sessions/read-model/schema.ts",
    issueReference: "#4638",
    reason:
      "Documents the SET NOT NULL bootstrap livelock incident that the metadata-only ADD COLUMN pattern here avoids repeating.",
  },
  {
    file: "bounded-contexts/inventory/features/holds/read-model/schema.ts",
    issueReference: "#4638",
    reason:
      "Documents the SET NOT NULL bootstrap livelock incident that the metadata-only ADD COLUMN pattern here avoids repeating.",
  },
  {
    file: "scripts/check-structure/boot-schema-ddl-discipline.mjs",
    issueReference: "#4638",
    reason: "Documents the SET NOT NULL bootstrap livelock incident this guard's SET NOT NULL rule exists to prevent.",
  },
  {
    file: "infrastructure/bounded-context-runtime/projection-groups.ts",
    issueReference: "#4768",
    reason:
      "Documents the production 503-flapping incident that justifies the specific concurrency bound, which is otherwise an unexplainable magic number.",
  },
  {
    file: "infrastructure/bounded-context-runtime/subscriptions.ts",
    issueReference: "#4751",
    reason:
      "Documents the fan-out transaction-budget incident that the per-event re-run (instead of batch-wide replay) exists to prevent recurring.",
  },
  {
    file: "bounded-contexts/catalog/features/source-observations/api/catalog-integration-data-governance.ts",
    issueReference: "#1903",
    reason: "Marks alias term/review-state strings as locked verbatim to the ADR slice; drifting the wording is a bug.",
  },
  {
    file: "bounded-contexts/catalog/features/source-observations/api/tcgdex-alias-extraction.ts",
    issueReference: "#1903",
    reason: "Marks alias source-governance policy as locked verbatim to the same ADR slice.",
  },
  {
    file: "infrastructure/platform-runtime/control-plane.ts",
    issueReference: "#4496",
    reason:
      "Documents the poisoned-claim starvation incident that the never-reclaim invariant here exists to prevent recurring.",
  },
  {
    file: "scripts/push-wake-capacity-evidence.mjs",
    issueReference: "#4655",
    reason: "Documents the PgBouncer transaction-pool convergence decision the capacity math here is derived from.",
  },
];

function isAllowlisted(relativeFile, issueReference) {
  return issueReferenceCommentAllowlist.some(
    (entry) => entry.file === relativeFile && entry.issueReference === issueReference,
  );
}

export function isIssueReferenceCommentGuardedFile(relativeFile) {
  const normalized = relativeFile.replaceAll("\\", "/");

  if (!issueReferenceCommentGuardRoots.some((root) => normalized.startsWith(root))) return false;
  if (!issueReferenceCommentGuardExtensions.has(path.extname(normalized))) return false;
  if (allowedPathSuffixes.some((suffix) => normalized.endsWith(suffix))) return false;
  if (normalized.includes(".test.") || normalized.includes(".spec.") || normalized.includes(".stories.")) return false;
  if (allowedPathSubstrings.some((fragment) => normalized.includes(fragment))) return false;
  if (testSupportFileNamePattern.test(normalized)) return false;

  return true;
}

function lineFor(sourceText, position) {
  return sourceText.slice(0, position).split(/\r?\n/).length;
}

// Parses the file and collects comment ranges from each token's leading
// trivia (every comment, including one trailing a statement or at end of
// file, is leading trivia of the next token — the EndOfFileToken for the
// last ones). A raw scanner loop cannot do this correctly: template-literal
// middles/tails after a `${...}` substitution need the parser's
// reScanTemplateToken, and without it whole spans of a file — comments
// included — disappear into one mis-paired template token. The file name
// picks the script kind so .ts angle-bracket casts and .tsx JSX both parse.
export function findIssueReferenceCommentViolations(sourceText, fileName = "module.tsx") {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  const seenCommentPositions = new Set();
  const violations = [];

  const recordCommentsAt = (fullStart) => {
    for (const range of ts.getLeadingCommentRanges(sourceText, fullStart) ?? []) {
      if (seenCommentPositions.has(range.pos)) continue;
      seenCommentPositions.add(range.pos);

      const commentText = sourceText.slice(range.pos, range.end);
      for (const match of commentText.matchAll(issueReferenceCommentPattern)) {
        const position = range.pos + match.index;
        violations.push({ line: lineFor(sourceText, position), match: match[0] });
      }
    }
  };

  const visit = (node) => {
    recordCommentsAt(node.getFullStart());
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  recordCommentsAt(sourceFile.endOfFileToken.getFullStart());

  return violations.sort((left, right) => left.line - right.line);
}

export async function collectIssueReferenceCommentViolations(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const violations = [];

  for (const root of issueReferenceCommentGuardRoots) {
    for (const filePath of await collectFiles(path.join(rootDir, root), {
      skippedDirectories: defaultSkippedDirectories,
    })) {
      const relativeFile = normalizeRelative(filePath, rootDir);
      if (!isIssueReferenceCommentGuardedFile(relativeFile)) continue;

      const sourceText = readFileSync(filePath, "utf8");
      // Cheap prefilter: parsing is only needed to decide whether a match sits
      // in a comment, and almost no files contain "#NNN" text at all. The probe
      // is a non-global copy — calling .test() on the global pattern would
      // advance its lastIndex, which matchAll then inherits via cloning.
      if (!issueReferenceCommentProbe.test(sourceText)) continue;

      for (const violation of findIssueReferenceCommentViolations(sourceText, relativeFile)) {
        if (isAllowlisted(relativeFile, violation.match)) continue;
        violations.push({ file: relativeFile, line: violation.line, match: violation.match });
      }
    }
  }

  return violations.sort((left, right) => {
    if (left.file !== right.file) return left.file.localeCompare(right.file);
    return left.line - right.line;
  });
}

function printViolations(violations) {
  console.error("Issue-reference comment guard failed.");
  console.error(
    'Comments must not cite closed-issue provenance ("shipped in #NNNN"); track history in GitHub, not code.',
  );
  console.error(
    "If a hit is a genuine constraint pointer (a documented incident or ADR this code must stay in lockstep",
  );
  console.error(
    'with, not just "where this came from"), add { file, issueReference, reason } to issueReferenceCommentAllowlist',
  );
  console.error("in scripts/check-structure/issue-reference-comments.mjs. Otherwise, rewrite the comment as a");
  console.error("present-tense constraint and drop the number.");
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} ${JSON.stringify(violation.match)}`);
  }
}

export async function checkIssueReferenceComments(options = {}) {
  const violations = await collectIssueReferenceCommentViolations(options);
  return { passed: violations.length === 0, violations };
}

async function main() {
  const result = await checkIssueReferenceComments();

  if (!result.passed) {
    printViolations(result.violations);
    process.exit(1);
  }

  console.log("Code comments are free of unallowlisted issue-number provenance.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
