import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";

// A route must not be able to render an unresolved public policy value
// without the machine-readable degraded-state markers. Nothing stops that
// structurally by construction: any production module that reads
// HelpArticle block content directly (article.blocks, its inline text, or the
// policy-value-unavailable discriminant that marks an unresolved value) can
// render it through a home-grown renderer that never calls the canonical
// chokepoint and therefore never emits data-policy-value-state /
// data-policy-values-state. The canonical renderer is the Corten public app's
// views/help_page.rs. This guard fails closed on any TypeScript module, and on
// any Corten pilot Rust module, that reads article block content outside a
// small, explicitly justified allowlist, regardless of the syntax, component
// name, CSS class, or copy the bypassing renderer uses: detection keys on the
// discriminant literal and on structural access to `.blocks`, not on how the
// caller chooses to render what it read. It also fails when the canonical
// renderer stops emitting either marker.

const POLICY_VALUE_UNAVAILABLE_DISCRIMINANT = "policy-value-unavailable";
const BLOCK_CONTENT_TYPE_NAMES = new Set(["HelpArticleBlock", "HelpArticleInline"]);
const BLOCK_CONTENT_PROPERTY_NAME = "blocks";

// Every entry is a file that would otherwise trip a signal below, with the
// reason it is the sanctioned owner/transformer of that signal. A file that
// never trips a signal does not need an entry here (it already passes), so
// this list stays exactly as large as the set of files the discriminant and
// HelpArticle block content legitimately have to pass through.
export const canonicalPolicyValueDiscriminantAllowlist = [
  {
    file: "bounded-contexts/public-presence/features/help/domain/resolve-article-policy-values.ts",
    reason:
      "The canonical domain transform that produces the policy-value-unavailable discriminant; it must read and rewrite article.blocks/content/items to do so.",
  },
  {
    file: "bounded-contexts/public-presence/features/help/domain/article-model.ts",
    reason: "Owns the policy-value-unavailable discriminant type declaration and the HelpArticleBlock/Inline shapes.",
  },
  {
    file: "bounded-contexts/public-presence/features/help/domain/policy-value-state.ts",
    reason:
      "Owns the machine-readable marker-attribute contract; walks blocks/content/items to derive the unresolved key set from the exact structure the renderer consumes.",
  },
  {
    file: "bounded-contexts/public-presence/features/help/domain/article-catalog.ts",
    reason:
      "The generated-catalog integration surface; re-exports the HelpArticleBlock/HelpArticleInline types for downstream catalog consumers (e.g. developer-portal) without itself touching block content.",
  },
];

export const CORTEN_POLICY_VALUE_RENDERER = "deployables/corten-pilot/public/src/views/help_page.rs";

// The Corten pilot's Rust modules that may read an article's blocks or its
// PolicyValue inlines. Any other pilot Rust module that does fails.
export const cortenPolicyValueRendererAllowlist = [
  {
    file: CORTEN_POLICY_VALUE_RENDERER,
    reason:
      "The sole canonical renderer: draws each block and an unresolved PolicyValue as data-policy-value-state=\"unavailable\", and marks the article data-policy-values-state=\"degraded\".",
  },
  {
    file: "deployables/corten-pilot/public/src/help.rs",
    reason:
      "Owns the Article/Block/Inline shapes and Values::unavailable, which walks the blocks to derive the unresolved key set the renderer marks.",
  },
];

// Both degraded-state markers the canonical renderer must keep emitting.
export const cortenPolicyValueRendererMarkers = [
  'data-policy-value-state="unavailable"',
  "data-policy-values-state=",
];

const cortenPolicyValueRendererFiles = new Set(cortenPolicyValueRendererAllowlist.map((entry) => entry.file));
const cortenBlockReadPatterns = [
  { pattern: /\bInline::PolicyValue\b/, message: "matches Inline::PolicyValue" },
  { pattern: /\.blocks\b(?!\s*\()/, message: "reads an article's .blocks" },
];

export function isCortenPolicyValueGuardedModule(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!/^deployables\/corten-pilot\/[^/]+\/src\/.+\.rs$/.test(normalized)) return false;
  if (/(^|\/)tests\.rs$/.test(normalized)) return false;
  if (/\/tests\//.test(normalized)) return false;
  return true;
}

/**
 * Scans the Corten pilot's Rust sources: a module outside the allowlist that
 * reads article blocks or matches a PolicyValue inline is a bypassing
 * renderer, and the canonical renderer must be present and keep both markers.
 */
export function findCortenPolicyValueRendererViolations(sourceRecords) {
  const guardedFiles = [];
  const violations = [];
  const seen = new Set();

  for (const record of sourceRecords) {
    const { relativePath } = record;
    if (!isCortenPolicyValueGuardedModule(relativePath)) continue;
    guardedFiles.push(relativePath);
    seen.add(relativePath);

    if (record.readError !== undefined) {
      violations.push(
        `${relativePath}: ${record.readError} - the policy-value discriminant guard fails closed on unreadable tracked production files`,
      );
      continue;
    }

    if (cortenPolicyValueRendererFiles.has(relativePath)) {
      if (relativePath === CORTEN_POLICY_VALUE_RENDERER) {
        for (const marker of cortenPolicyValueRendererMarkers) {
          if (!record.source.includes(marker)) {
            violations.push(
              `${relativePath}: the canonical policy-value renderer no longer emits ${marker}; an unresolved value would render without its degraded-state marker`,
            );
          }
        }
      }
      continue;
    }

    record.source.split(/\r?\n/).forEach((line, index) => {
      for (const { pattern, message } of cortenBlockReadPatterns) {
        if (pattern.test(line)) {
          violations.push(
            `${relativePath}:${index + 1}: ${message} outside the canonical HelpArticle-block chokepoint; draw articles only through ${CORTEN_POLICY_VALUE_RENDERER}`,
          );
        }
      }
    });
  }

  for (const file of cortenPolicyValueRendererFiles) {
    if (!seen.has(file)) {
      violations.push(`${file}: allowlisted Corten policy-value module is not tracked; the guard fails closed`);
    }
  }

  return { guardedFiles: guardedFiles.sort(), violations: violations.sort() };
}

const canonicalPolicyValueDiscriminantFiles = new Set(
  canonicalPolicyValueDiscriminantAllowlist.map((entry) => entry.file),
);

const testPathPattern = /(^|\/)(?:__tests__|tests|fixtures|test-fixtures|test-support)(\/|$)/;
const testSupportFileNamePattern = /-test-support\.(?:ts|tsx)$/;

export function isPolicyValueDiscriminantGuardedModule(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!/\.(?:ts|tsx)$/.test(normalized)) return false;
  if (/\.d\.(?:ts|mts)$/.test(normalized)) return false;
  if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(normalized)) return false;
  if (testPathPattern.test(normalized)) return false;
  if (testSupportFileNamePattern.test(normalized)) return false;
  return true;
}

function scriptKindFor(relativePath) {
  return relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function lineFor(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function importOrExportSpecifierName(specifier) {
  const nameNode = specifier.propertyName ?? specifier.name;
  return ts.isIdentifier(nameNode) ? nameNode.text : undefined;
}

function mightContainASignal(source) {
  return (
    source.includes(POLICY_VALUE_UNAVAILABLE_DISCRIMINANT) ||
    source.includes(BLOCK_CONTENT_PROPERTY_NAME) ||
    source.includes("HelpArticleBlock") ||
    source.includes("HelpArticleInline")
  );
}

/**
 * AST guard: scans one already-loaded set of source records (relativePath +
 * source, or relativePath + readError for a fail-closed read failure) and
 * reports every production, non-canonical reference to the
 * policy-value-unavailable discriminant, HelpArticleBlock/HelpArticleInline
 * types, or `.blocks` access (dot, bracket, or destructured).
 */
export function findPolicyValueDiscriminantViolations(sourceRecords) {
  const guardedFiles = [];
  const violations = [];

  for (const record of sourceRecords) {
    const { relativePath } = record;
    if (!isPolicyValueDiscriminantGuardedModule(relativePath)) continue;
    guardedFiles.push(relativePath);

    if (record.readError !== undefined) {
      violations.push(
        `${relativePath}: ${record.readError} — the policy-value discriminant guard fails closed on unreadable tracked production files`,
      );
      continue;
    }

    if (canonicalPolicyValueDiscriminantFiles.has(relativePath)) continue;

    const source = record.source;
    if (!mightContainASignal(source)) continue;

    let sourceFile;
    try {
      sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(relativePath));
    } catch (error) {
      violations.push(
        `${relativePath}: could not parse (${error instanceof Error ? error.message : String(error)}) — the policy-value discriminant guard fails closed on parse ambiguity`,
      );
      continue;
    }

    function report(node, message) {
      violations.push(`${relativePath}:${lineFor(sourceFile, node)}: ${message}`);
    }

    function visit(node) {
      if (ts.isStringLiteralLike(node) && node.text === POLICY_VALUE_UNAVAILABLE_DISCRIMINANT) {
        report(
          node,
          `references the '${POLICY_VALUE_UNAVAILABLE_DISCRIMINANT}' discriminant outside the canonical chokepoint; render unresolved policy values only through ${CORTEN_POLICY_VALUE_RENDERER}`,
        );
      }

      if (ts.isPropertyAccessExpression(node) && node.name.text === BLOCK_CONTENT_PROPERTY_NAME) {
        report(
          node,
          "reads a '.blocks' property outside the canonical HelpArticle-block chokepoint; compose the canonical renderer instead of reading block content directly",
        );
      }

      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === BLOCK_CONTENT_PROPERTY_NAME
      ) {
        report(
          node,
          "reads a ['blocks'] property outside the canonical HelpArticle-block chokepoint; compose the canonical renderer instead of reading block content directly",
        );
      }

      if (ts.isBindingElement(node)) {
        const boundName = node.propertyName ?? node.name;
        if (ts.isIdentifier(boundName) && boundName.text === BLOCK_CONTENT_PROPERTY_NAME) {
          report(
            node,
            "destructures a 'blocks' property outside the canonical HelpArticle-block chokepoint; compose the canonical renderer instead of reading block content directly",
          );
        }
      }

      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
        const importedName = importOrExportSpecifierName(node);
        if (importedName !== undefined && BLOCK_CONTENT_TYPE_NAMES.has(importedName)) {
          report(node, `imports or re-exports '${importedName}' outside the canonical HelpArticle-block chokepoint`);
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return {
    guardedFiles: guardedFiles.sort(),
    violations: violations.sort(),
  };
}

/**
 * Derives the production corpus from Git-tracked files (not a readdir walk
 * of known route roots), so an arbitrary tracked .ts/.tsx path anywhere in
 * the repo is in scope, not only the public-presence bounded context.
 */
function listTrackedFiles(repoRoot, execGit) {
  return execGit("git", ["ls-files", "-z", "--cached"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_LISTING_MAX_BUFFER,
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"));
}

export function listPolicyValueDiscriminantGuardCandidates(repoRoot, { execGit = execFileSync } = {}) {
  return listTrackedFiles(repoRoot, execGit).filter(isPolicyValueDiscriminantGuardedModule).sort();
}

export function listCortenPolicyValueGuardCandidates(repoRoot, { execGit = execFileSync } = {}) {
  return listTrackedFiles(repoRoot, execGit).filter(isCortenPolicyValueGuardedModule).sort();
}

function readSources(repoRoot, relativePaths) {
  return relativePaths.map((relativePath) => {
    try {
      return { relativePath, source: readFileSync(path.join(repoRoot, ...relativePath.split("/")), "utf8") };
    } catch (error) {
      return {
        relativePath,
        readError: `could not read tracked file (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  });
}

export function readPolicyValueDiscriminantGuardSources({ repoRoot, execGit } = {}) {
  return readSources(repoRoot, listPolicyValueDiscriminantGuardCandidates(repoRoot, { execGit }));
}

export function readCortenPolicyValueGuardSources({ repoRoot, execGit } = {}) {
  return readSources(repoRoot, listCortenPolicyValueGuardCandidates(repoRoot, { execGit }));
}

export function validatePolicyValueDiscriminantChokepoint({ repoRoot, execGit } = {}) {
  const typescript = findPolicyValueDiscriminantViolations(readPolicyValueDiscriminantGuardSources({ repoRoot, execGit }));
  const corten = findCortenPolicyValueRendererViolations(readCortenPolicyValueGuardSources({ repoRoot, execGit }));
  return {
    guardedFiles: typescript.guardedFiles,
    cortenGuardedFiles: corten.guardedFiles,
    violations: [...typescript.violations, ...corten.violations].sort(),
  };
}
