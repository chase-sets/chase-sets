import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "./lib/files.mjs";
import { normalizeRelative, repoRoot } from "./lib/repo.mjs";

// Operator-surface project-management (PM) content guard.
//
// Rationale: the app holds the data an operator needs to RUN an integration.
// Our own launch sequencing — GitHub issue/PR numbers, release-blocker severity,
// internal owner-team names, and release-engineering vocabulary — belongs in
// GitHub issues, milestones, and CI, not in operator-facing read models, UI, or
// localization copy. Once those surfaces were cleaned (epic #1889), this guard
// fails closed if PM content tries to re-enter them.
//
// Scope is deliberately narrow so the guard passes on the cleaned tree without
// flagging legitimate operational content:
//   - It scans only operator-facing surfaces: feature/shell UI under
//     `bounded-contexts/**/ui/**` and catalog localization values under
//     `contracts/localization/locales/**/catalog/**`.
//   - In `.ts`/`.tsx` files it inspects only *rendered copy* — string and
//     template literals and JSX text via the TypeScript AST — so code comments
//     and internal identifiers are out of scope (a comment is not operator copy).
//   - Tests, fixtures, stories, type decls, and the relocated verification
//     harnesses are allowlisted, as are the genuine operational alert/runbook
//     link strings kept in Integration Health triage.

export const scannedScopes = [
  { root: path.join("bounded-contexts"), kind: "ui", extensions: new Set([".ts", ".tsx"]) },
  {
    root: path.join("contracts", "localization", "locales"),
    kind: "catalog-locale",
    extensions: new Set([".ts"]),
  },
];

const allowedPathSubstrings = [
  "/__tests__/",
  "/fixtures/",
  "/test-fixtures/",
  "/test-support/",
  // The relocated acceptance / proof verification harnesses (#1895) are
  // test-only scaffolding, not served operator surfaces.
  "/features/source-observations/tests/",
];

const allowedPathSuffixes = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".stories.tsx", ".d.ts"];

// PM-content rules. Each runs against *rendered copy* only (string/template/JSX
// text), except the two identifier rules which run against the raw source because
// the field names must not exist on an operator surface at all.
const copyRules = [
  {
    id: "github-issue-reference",
    description: "GitHub issue/PR reference (e.g. #1054) in operator copy — track work in GitHub, not the app.",
    pattern: /#\d{3,4}\b/,
  },
  {
    id: "release-severity-p0-p1",
    description: "Release-blocker severity (P0/P1) in operator copy — use diagnostic levels (info/warning/error).",
    pattern: /\bP[01]\b/,
  },
  {
    id: "owner-team-label",
    description: "Internal owner-team label rendered as operator copy — owners live in GitHub, not the UI.",
    pattern: /\bops-release\b|\bcatalog-source-observations\b/,
  },
  {
    id: "release-signoff",
    description: "Release-engineering vocabulary 'signoff' in operator copy.",
    pattern: /sign-?off/i,
  },
  {
    id: "deploy-skew",
    // `deploy-skew-unsupported-version` is a real fail-closed blocker discriminant
    // (a system token, not rendered prose); the trailing boundary excludes it.
    description: "Release-engineering vocabulary 'deploy skew' in operator copy.",
    pattern: /deploy[\s-]skew(?![\w-])/i,
  },
  {
    id: "scaffolding",
    description: "Release-engineering vocabulary 'scaffolding' in operator copy.",
    pattern: /\bscaffolding\b/i,
  },
  {
    id: "residual-debt",
    description: "Release-engineering vocabulary 'residual debt' in operator copy.",
    pattern: /\bresidual debt\b/i,
  },
  {
    id: "release-note",
    description: "Release-engineering vocabulary 'release note(s)' in operator copy.",
    pattern: /\brelease notes?\b/i,
  },
  {
    id: "operator-instruction",
    // The PM laundry-list sense ("docs, runbooks, release notes, operator
    // instructions"). Genuine instructional copy uses verbs, not this noun phrase.
    description: "Release-policy vocabulary 'operator instructions' in operator copy.",
    pattern: /\boperator instructions\b/i,
  },
  {
    id: "before-launch",
    description: "Pre-launch tracking vocabulary 'before launch' in operator copy.",
    pattern: /\bbefore launch\b/i,
  },
  {
    id: "retire-means-complete-removal",
    // The specific release-policy phrase, not the operator-domain word "retire"
    // (retiring a provider profile is genuine lifecycle vocabulary).
    description: "Release-policy phrasing 'retire(ment) means complete removal' in operator copy.",
    pattern: /retire(?:ment)?\s+means\s+complete\s+removal/i,
  },
  // Deliberately NO bare-"runbook" rule. Every runbook reference on a live
  // operator surface today is a genuine operational alert/runbook *link*
  // (a `docs/runbooks/*.md` href plus its "Runbook {value}" / "Alert/runbook"
  // label), which Integration Health triage keeps on purpose (#1896). The PM
  // sense of "runbook" only ever appeared inside the release-policy laundry list
  // ("docs, runbooks, release notes, operator instructions"), which the
  // `release-note`, `operator-instruction`, and issue-reference rules already
  // catch when it recurs. A standalone runbook link is not PM content.
];

const identifierRules = [
  {
    id: "owner-issue-field",
    description: "`ownerIssue` field on an operator surface — issue ownership is GitHub metadata.",
    pattern: /\bownerIssue\b/,
  },
  {
    id: "consumes-issues-field",
    description: "`consumesIssues` field on an operator surface — issue tracking is GitHub metadata.",
    pattern: /\bconsumesIssues\b/,
  },
];

function sourceKindFor(filePath) {
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) {
    return ts.ScriptKind.TSX;
  }
  return ts.ScriptKind.TS;
}

export function isOperatorSurfaceFile(relativeFile, scope) {
  const normalized = relativeFile.replaceAll("\\", "/");

  if (!scope.extensions.has(path.extname(normalized))) return false;
  if (allowedPathSuffixes.some((suffix) => normalized.endsWith(suffix))) return false;
  if (normalized.includes(".test.") || normalized.includes(".spec.") || normalized.includes(".stories.")) return false;
  if (allowedPathSubstrings.some((fragment) => normalized.includes(fragment))) return false;

  if (scope.kind === "ui") {
    return normalized.includes("/ui/");
  }

  // catalog-locale: only the catalog locale value files.
  return normalized.includes("/catalog/") || normalized.endsWith("/catalog.ts");
}

// Collect the rendered-copy segments (string/template literal text and JSX text)
// from a TypeScript source. Comments and identifiers are intentionally excluded.
function collectRenderedCopy(sourceText, filePath) {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindFor(filePath));
  const segments = [];

  function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      segments.push({ text: node.text, pos: node.getStart(sourceFile) });
    } else if (ts.isTemplateExpression(node)) {
      segments.push({ text: node.head.text, pos: node.head.getStart(sourceFile) });
      for (const span of node.templateSpans) {
        segments.push({ text: span.literal.text, pos: span.literal.getStart(sourceFile) });
      }
    } else if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (text.length > 0) {
        segments.push({ text: node.text, pos: node.getStart(sourceFile) });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { sourceFile, segments };
}

function lineFor(sourceFile, sourceText, position) {
  if (sourceFile) {
    return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  }
  return sourceText.slice(0, position).split(/\r?\n/).length;
}

function collectFileViolations(filePath, rootDir) {
  const relativeFile = normalizeRelative(filePath, rootDir);
  const sourceText = readFileSync(filePath, "utf8");
  const { sourceFile, segments } = collectRenderedCopy(sourceText, filePath);
  const violations = [];

  for (const segment of segments) {
    for (const rule of copyRules) {
      const match = rule.pattern.exec(segment.text);
      if (match) {
        violations.push({
          file: relativeFile,
          rule: rule.id,
          description: rule.description,
          match: match[0],
          line: lineFor(sourceFile, sourceText, segment.pos),
        });
      }
    }
  }

  for (const rule of identifierRules) {
    const match = rule.pattern.exec(sourceText);
    if (match) {
      violations.push({
        file: relativeFile,
        rule: rule.id,
        description: rule.description,
        match: match[0],
        line: lineFor(null, sourceText, match.index),
      });
    }
  }

  return violations.sort((left, right) => {
    if (left.line !== right.line) return left.line - right.line;
    return left.rule.localeCompare(right.rule);
  });
}

export async function collectOperatorSurfacePmViolations(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const seen = new Set();
  const files = [];

  for (const scope of scannedScopes) {
    const scopeRoot = path.join(rootDir, scope.root);
    for (const filePath of await collectFiles(scopeRoot, {
      skippedDirectories: defaultSkippedDirectories,
    })) {
      const relativeFile = normalizeRelative(filePath, rootDir);
      if (!isOperatorSurfaceFile(relativeFile, scope)) continue;
      if (seen.has(relativeFile)) continue;
      seen.add(relativeFile);
      files.push(filePath);
    }
  }

  return files
    .flatMap((filePath) => collectFileViolations(filePath, rootDir))
    .sort((left, right) => {
      if (left.file !== right.file) return left.file.localeCompare(right.file);
      if (left.line !== right.line) return left.line - right.line;
      return left.rule.localeCompare(right.rule);
    });
}

function printViolations(violations) {
  console.error("Operator-surface project-management content guard failed.");
  console.error("Operator surfaces hold integration-running data only; track our own launch work (issue/PR numbers,");
  console.error("release severity, owner teams, release-engineering vocabulary) in GitHub, not in the app.");
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} [${violation.rule}] ${JSON.stringify(violation.match)}`);
    console.error(`    ${violation.description}`);
  }
}

export async function checkOperatorSurfacePmContent(options = {}) {
  const violations = await collectOperatorSurfacePmViolations(options);
  return { passed: violations.length === 0, violations };
}

async function main() {
  const result = await checkOperatorSurfacePmContent();

  if (!result.passed) {
    printViolations(result.violations);
    process.exit(1);
  }

  console.log("Operator surfaces are free of project-management content.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
