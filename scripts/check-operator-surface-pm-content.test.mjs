import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectOperatorSurfacePmViolations } from "./check-operator-surface-pm-content.mjs";

const tempDirs = [];

function createRepo() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "operator-surface-pm-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function writeSource(rootDir, relativeFile, source) {
  const filePath = path.join(rootDir, relativeFile);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, "utf8");
}

async function rules(rootDir) {
  const violations = await collectOperatorSurfacePmViolations({ rootDir });
  return violations.map((violation) => `${violation.file}:${violation.rule}`);
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const UI_FILE = "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/read-model.ts";
const LOCALE_FILE = "contracts/localization/locales/en/catalog/source-observations-control-plane.ts";

describe("check-operator-surface-pm-content", () => {
  it("flags a GitHub issue reference planted in a read model", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      UI_FILE,
      `export const readModel = {
  blocker: "Promotion is blocked; resolve #1054 reset evidence before continuing.",
};
`,
    );

    expect(await rules(rootDir)).toEqual([`${UI_FILE}:github-issue-reference`]);
  });

  it("flags an issue reference interpolated into localization copy", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      LOCALE_FILE,
      `export const copy = {
  "catalog.features.sourceObservations.ui.rollout.owner": "ops-release owns the stop; issue #801.",
};
`,
    );

    expect(await rules(rootDir)).toEqual([`${LOCALE_FILE}:github-issue-reference`, `${LOCALE_FILE}:owner-team-label`]);
  });

  it("flags release-blocker severity framing but not diagnostic levels", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      UI_FILE,
      `export const readModel = {
  blocker: "This is a P0 release blocker.",
  level: "warning",
  diagnostics: ["info", "warning", "error"],
};
`,
    );

    expect(await rules(rootDir)).toEqual([`${UI_FILE}:release-severity-p0-p1`]);
  });

  it("flags release-engineering vocabulary in operator copy", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      LOCALE_FILE,
      `export const copy = {
  a: "Verify telemetry before release signoff.",
  b: "Deploy skew fails closed.",
  c: "Delete the temporary scaffolding before launch.",
  d: "Clear all residual debt and ship the release notes and operator instructions.",
  e: "Retirement means complete removal of all retired code and docs.",
};
`,
    );

    // Violations sort by (file, line, rule); the planted lines a–e each contribute
    // in source order, with same-line rules ordered alphabetically.
    expect(await rules(rootDir)).toEqual([
      `${LOCALE_FILE}:release-signoff`,
      `${LOCALE_FILE}:deploy-skew`,
      `${LOCALE_FILE}:before-launch`,
      `${LOCALE_FILE}:scaffolding`,
      `${LOCALE_FILE}:operator-instruction`,
      `${LOCALE_FILE}:release-note`,
      `${LOCALE_FILE}:residual-debt`,
      `${LOCALE_FILE}:retire-means-complete-removal`,
    ]);
  });

  it("flags the ownerIssue and consumesIssues fields anywhere in an operator surface file", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      UI_FILE,
      `export const workspace = {
  ownerIssue: 801,
  consumesIssues: [1054, 1061],
};
`,
    );

    expect(await rules(rootDir)).toEqual([`${UI_FILE}:owner-issue-field`, `${UI_FILE}:consumes-issues-field`]);
  });

  it("allows the genuine operational alert/runbook links kept in health triage", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      UI_FILE,
      `const runbookHref = "https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/catalog-integration-operations.md";
export const readModel = {
  runbookLabel: "Runbook {value}",
  tableHeader: "Alert/runbook",
  href: runbookHref,
};
`,
    );

    expect(await rules(rootDir)).toEqual([]);
  });

  it("allows the deploy-skew-unsupported-version blocker discriminant", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-copy.ts",
      `export const copy = {
  "deploy-skew-unsupported-version": { reason: "The UI and API contracts are out of sync and fail closed." },
};
`,
    );

    expect(await rules(rootDir)).toEqual([]);
  });

  it("allows the operator-domain language of retiring a provider profile", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      LOCALE_FILE,
      `export const copy = {
  a: "Retirement fully removes the profile behavior, not a soft deprecation.",
  b: "Rollback, retire, deprecate, replay, or reapply profile behavior.",
};
`,
    );

    expect(await rules(rootDir)).toEqual([]);
  });

  it("ignores code comments and out-of-scope paths", async () => {
    const rootDir = createRepo();
    // PM words in a comment are not operator copy.
    writeSource(rootDir, UI_FILE, `// release scaffolding and signoff notes for #1054\nexport const x = 1;\n`);
    // Tests, fixtures, relocated harnesses, and non-ui/non-catalog files are out of scope.
    writeSource(rootDir, `${UI_FILE.replace(".ts", ".test.ts")}`, `const s = "P0 release blocker #1054 signoff";\n`);
    writeSource(
      rootDir,
      "bounded-contexts/catalog/features/source-observations/tests/proof.ts",
      `export const s = "P0 release blocker #1054 signoff scaffolding";\n`,
    );
    writeSource(
      rootDir,
      "bounded-contexts/catalog/features/source-observations/api/contracts.ts",
      `export const s = "P0 release blocker #1054 signoff";\n`,
    );
    writeSource(
      rootDir,
      "contracts/localization/locales/en/checkout/copy.ts",
      `export const s = "P0 release blocker #1054 signoff";\n`,
    );

    expect(await rules(rootDir)).toEqual([]);
  });
});
