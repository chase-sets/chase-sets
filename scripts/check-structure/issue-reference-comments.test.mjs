import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectIssueReferenceCommentViolations,
  findIssueReferenceCommentViolations,
  isIssueReferenceCommentGuardedFile,
  issueReferenceCommentAllowlist,
} from "./issue-reference-comments.mjs";

const tempDirs = [];

function createRepo() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "issue-reference-comments-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function writeSource(rootDir, relativeFile, source) {
  const filePath = path.join(rootDir, relativeFile);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, "utf8");
}

async function scan(rootDir) {
  const violations = await collectIssueReferenceCommentViolations({ rootDir });
  return violations.map((violation) => `${violation.file}:${violation.line} ${violation.match}`);
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const numberSign = "#";
const example = (digits) => `${numberSign}${digits}`;

describe("findIssueReferenceCommentViolations", () => {
  it("flags a single-line comment citing an issue number", () => {
    const source = `// shipped in ${example("1054")} last quarter\nexport const x = 1;\n`;
    expect(findIssueReferenceCommentViolations(source)).toEqual([{ line: 1, match: example("1054") }]);
  });

  it("flags a block/JSDoc comment citing an issue number", () => {
    const source = `/**\n * Added for the DCR slice (issue ${example("3755")}).\n */\nexport const x = 1;\n`;
    expect(findIssueReferenceCommentViolations(source)).toEqual([{ line: 2, match: example("3755") }]);
  });

  it("flags every occurrence in one comment and across multiple comments", () => {
    const source = [
      `// closes ${example("101")} and ${example("202")}`,
      `const a = 1;`,
      `// also relates to ${example("303")}`,
    ].join("\n");

    expect(findIssueReferenceCommentViolations(source)).toEqual([
      { line: 1, match: example("101") },
      { line: 1, match: example("202") },
      { line: 3, match: example("303") },
    ]);
  });

  it("ignores string, template literal, and JSX text content", () => {
    const source = [
      `const url = "https://github.com/chase-sets/chase-sets/issues/${"9999"}";`,
      `const note = \`See ${numberSign}4638 in the runbook.\`;`,
      `export const label = ${numberSign}1054;`,
    ].join("\n");

    expect(findIssueReferenceCommentViolations(source)).toEqual([]);
  });

  it("ignores a two-digit or unpunctuated number (not a 3+ digit issue reference)", () => {
    const source = `// see ${numberSign}42 and the #note below\n`;
    expect(findIssueReferenceCommentViolations(source)).toEqual([]);
  });

  it("flags a comment after a template literal with substitutions (raw-scanner blind spot)", () => {
    const source = [
      'const label = `${count} item${count === 1 ? "" : "s"}`;',
      `// shipped in ${example("4271")} last quarter`,
      "export const x = 1;",
    ].join("\n");

    expect(findIssueReferenceCommentViolations(source)).toEqual([{ line: 2, match: example("4271") }]);
  });

  it("does not flag a SQL '--' line embedded inside a template-literal DDL string", () => {
    const source = [
      "export const schemaSql = `",
      `-- creation regresses to issue ${example("4599")}'s staging bootstrap failure`,
      "CREATE TABLE example (id text PRIMARY KEY);",
      "`;",
    ].join("\n");

    expect(findIssueReferenceCommentViolations(source)).toEqual([]);
  });

  // #4869: a SQL query template literal with `${...}` interpolation (not just
  // a static DDL string) is the shape that desynced the raw ts.createScanner
  // loop — the scanner cannot re-scan the template middle/tail after a
  // substitution without the parser's reScanTemplateToken, so it mis-pairs
  // backticks and swallows the remainder of the file, comments included, into
  // one bogus template token. Under that old raw-scanner approach this test
  // is red: the trailing #4901 comment goes invisible. The parse-based walk
  // fixes it because ts.createSourceFile performs real re-scanning.
  it("flags a #NNNN comment that follows a SQL query template literal with ${} interpolation", () => {
    const source = [
      "export function findWidgetsByOwner(ownerId, status) {",
      "  return sql`",
      "    SELECT id, name, status",
      "    FROM widgets",
      "    WHERE owner_id = ${ownerId}",
      "      AND status = ${status}",
      "  `;",
      "}",
      "",
      `// shipped in ${example("4901")} for the widget-owner query`,
      "export const x = 1;",
    ].join("\n");

    expect(findIssueReferenceCommentViolations(source)).toEqual([{ line: 10, match: example("4901") }]);
  });
});

describe("isIssueReferenceCommentGuardedFile", () => {
  it("scans .ts/.tsx/.mjs source under the four scoped roots", () => {
    expect(isIssueReferenceCommentGuardedFile("bounded-contexts/catalog/features/x/domain/domain.ts")).toBe(true);
    expect(isIssueReferenceCommentGuardedFile("infrastructure/platform-runtime/control-plane.ts")).toBe(true);
    expect(isIssueReferenceCommentGuardedFile("deployables/platform-worker/src/worker.ts")).toBe(true);
    expect(isIssueReferenceCommentGuardedFile("scripts/some-check.mjs")).toBe(true);
  });

  it("excludes roots outside the scoped four", () => {
    expect(isIssueReferenceCommentGuardedFile("contracts/event-core/index.ts")).toBe(false);
    expect(isIssueReferenceCommentGuardedFile("packages/design-system/src/index.ts")).toBe(false);
    expect(isIssueReferenceCommentGuardedFile("docs/architecture/notes.ts")).toBe(false);
  });

  it("excludes test files, fixtures, stories, test-support, and declaration files", () => {
    expect(isIssueReferenceCommentGuardedFile("bounded-contexts/catalog/features/x/domain/domain.test.ts")).toBe(false);
    expect(isIssueReferenceCommentGuardedFile("bounded-contexts/catalog/tests/proof.ts")).toBe(false);
    expect(isIssueReferenceCommentGuardedFile("scripts/check-structure/__tests__/helper.ts")).toBe(false);
    expect(isIssueReferenceCommentGuardedFile("bounded-contexts/catalog/features/x/fixtures/sample.ts")).toBe(false);
    expect(isIssueReferenceCommentGuardedFile("bounded-contexts/catalog/features/x/ui/x-test-support.ts")).toBe(false);
    expect(isIssueReferenceCommentGuardedFile("packages/design-system/src/index.stories.tsx")).toBe(false);
    expect(isIssueReferenceCommentGuardedFile("bounded-contexts/catalog/api/contracts.d.ts")).toBe(false);
  });

  it("excludes non-JS/TS extensions", () => {
    expect(isIssueReferenceCommentGuardedFile("bounded-contexts/catalog/context.json")).toBe(false);
    expect(isIssueReferenceCommentGuardedFile("bounded-contexts/catalog/README.md")).toBe(false);
  });
});

describe("collectIssueReferenceCommentViolations", () => {
  it("flags an unallowlisted issue-number comment in a guarded file", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/catalog/features/x/domain/domain.ts",
      `// Catalog Alias aggregate (${example("1905")})\nexport const x = 1;\n`,
    );

    expect(await scan(rootDir)).toEqual([`bounded-contexts/catalog/features/x/domain/domain.ts:1 ${example("1905")}`]);
  });

  it("suppresses an allowlisted (file, issue-reference) pair but not other numbers in the same file", async () => {
    const rootDir = createRepo();
    const [allowlisted] = issueReferenceCommentAllowlist;
    writeSource(
      rootDir,
      allowlisted.file,
      [
        `// Retained for the reason this guard allowlists: ${allowlisted.issueReference}.`,
        `// A different, unrelated number stays flagged: ${example("7202")}.`,
        `export const x = 1;`,
      ].join("\n"),
    );

    expect(await scan(rootDir)).toEqual([`${allowlisted.file}:2 ${example("7202")}`]);
  });

  it("does not scan test files, fixtures, or out-of-scope roots even when they contain issue numbers", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/catalog/features/x/domain/domain.test.ts",
      `// shipped in ${example("1905")}\nexport const x = 1;\n`,
    );
    writeSource(
      rootDir,
      "bounded-contexts/catalog/features/x/fixtures/sample.ts",
      `// shipped in ${example("1905")}\nexport const x = 1;\n`,
    );
    writeSource(
      rootDir,
      "packages/design-system/src/index.ts",
      `// shipped in ${example("1905")}\nexport const x = 1;\n`,
    );
    writeSource(rootDir, "contracts/event-core/index.ts", `// shipped in ${example("1905")}\nexport const x = 1;\n`);

    expect(await scan(rootDir)).toEqual([]);
  });

  it("every allowlist entry names a real file under the four scoped roots", () => {
    for (const entry of issueReferenceCommentAllowlist) {
      expect(isIssueReferenceCommentGuardedFile(entry.file), entry.file).toBe(true);
      expect(entry.issueReference, entry.file).toMatch(/^#\d{3,}$/);
      expect(typeof entry.reason, entry.file).toBe("string");
      expect(entry.reason.length > 0, entry.file).toBe(true);
    }
  });

  // The AST tokenization sweep across four repo roots grows with the codebase
  // and already brushes the 5s default on developer machines (same rationale
  // as the typed-ID trust-boundary guard's repo-wide sweep).
  it("keeps non-test source under bounded-contexts, infrastructure, deployables, and scripts free of unallowlisted issue-number comments", async () => {
    const violations = await collectIssueReferenceCommentViolations();

    expect(
      violations,
      violations.map((violation) => `${violation.file}:${violation.line} ${violation.match}`).join("\n"),
    ).toEqual([]);
  }, 30_000);
});
