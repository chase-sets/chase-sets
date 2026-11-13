import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyChanges } from "./change-scope.mjs";
import { listWorkspacePackages } from "./lib/repo.mjs";
import { runTypecheckChanged, selectChangedTests, TypecheckChangedError } from "./typecheck-changed.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "typecheck-changed-"));
  const dir = path.join(root, "bounded-contexts", "settlement");
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@example/settlement" }));
  writeFileSync(path.join(dir, "tests", "unchanged.test.ts"), "export const value = 1;\n");
  writeFileSync(path.join(root, "tsconfig.tests.json"), JSON.stringify({ include: ["**/*.test.ts"] }));
  writeFileSync(path.join(root, "test-env.d.ts"), "declare const TEST_FIXTURE: string;\n");
  return {
    root,
    workspace: { name: "@example/settlement", dir, root: "bounded-contexts", dirName: "settlement", packageJson: {} },
  };
}

describe("typecheck:changed", () => {
  it("selects every test in an affected workspace, including unchanged tests", () => {
    const { root, workspace } = fixture();
    try {
      const selected = selectChangedTests({
        repoRoot: root,
        workspaces: [workspace],
        changedFiles: ["bounded-contexts/settlement/src/changed.ts"],
      });
      expect(selected.workspaces.map(({ name }) => name)).toEqual(["@example/settlement"]);
      expect(selected.testFiles).toEqual(["bounded-contexts/settlement/tests/unchanged.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a TypeScript file in executable territory with no workspace mapping", () => {
    expect(() =>
      selectChangedTests({
        repoRoot: "/tmp/fixture",
        workspaces: [],
        changedFiles: ["infrastructure/stripe-payments/changed.ts"],
      }),
    ).toThrowError(TypecheckChangedError);
  });

  it("admits before writing the temporary program and removes it after compiler failure", async () => {
    const { root, workspace } = fixture();
    const order = [];
    let configPath;
    try {
      const status = await runTypecheckChanged({
        repoRoot: root,
        env: { CHANGED_FILES_JSON: JSON.stringify(["bounded-contexts/settlement/src/changed.ts"]) },
        listWorkspaces: () => [workspace],
        acquireSlot: () => {
          order.push("admit");
          return true;
        },
        runCompiler: (candidate) => {
          order.push("compile");
          configPath = candidate;
          expect(candidate).toMatch(/[\\/]\.tmp[\\/]typecheck-changed-/);
          expect(JSON.parse(readFileSync(candidate, "utf8")).files).toContain(
            path.resolve(root, "bounded-contexts/settlement/tests/unchanged.test.ts"),
          );
          return 7;
        },
        stdout: () => {},
        stderr: () => {},
      });
      expect(status).toBe(7);
      expect(order).toEqual(["admit", "compile"]);
      expect(existsSync(configPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not create a temporary program after admission refusal", async () => {
    const { root, workspace } = fixture();
    try {
      const status = await runTypecheckChanged({
        repoRoot: root,
        env: { CHANGED_FILES_JSON: JSON.stringify(["bounded-contexts/settlement/src/changed.ts"]) },
        listWorkspaces: () => [workspace],
        acquireSlot: () => false,
        runCompiler: () => {
          throw new Error("compiler must not run");
        },
        stdout: () => {},
        stderr: () => {},
      });
      expect(status).toBe(73);
      expect(existsSync(path.join(root, ".tmp"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves only selected workspace tests and excludes an untouched workspace", async () => {
    const { root, workspace } = fixture();
    const untouchedDir = path.join(root, "bounded-contexts", "catalog");
    mkdirSync(path.join(untouchedDir, "tests"), { recursive: true });
    const untouched = {
      name: "@example/catalog",
      dir: untouchedDir,
      root: "bounded-contexts",
      dirName: "catalog",
      packageJson: {},
    };
    writeFileSync(path.join(untouchedDir, "package.json"), JSON.stringify({ name: untouched.name }));
    writeFileSync(path.join(untouchedDir, "tests", "untouched.test.ts"), "export const value = 2;\n");
    let resolved;
    try {
      const status = await runTypecheckChanged({
        repoRoot: root,
        env: { CHANGED_FILES_JSON: JSON.stringify(["bounded-contexts/settlement/src/changed.ts"]) },
        listWorkspaces: () => [workspace, untouched],
        acquireSlot: () => true,
        runCompiler: (configPath) => {
          const tscPath = path.join(path.dirname(require.resolve("typescript")), "tsc.js");
          resolved = JSON.parse(
            execFileSync(process.execPath, [tscPath, "-p", configPath, "--showConfig"], { encoding: "utf8" }),
          );
          return 0;
        },
        stdout: () => {},
        stderr: () => {},
      });
      expect(status).toBe(0);
      expect(resolved.files).toContain("../../bounded-contexts/settlement/tests/unchanged.test.ts");
      expect(resolved.files).toContain("../../test-env.d.ts");
      expect(resolved.files).not.toContain("../../bounded-contexts/catalog/tests/untouched.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns NO_WORKSPACE without admission for documentation-only changes", async () => {
    const { root, workspace } = fixture();
    const output = [];
    try {
      const status = await runTypecheckChanged({
        repoRoot: root,
        env: { CHANGED_FILES_JSON: JSON.stringify(["docs/runbook.md"]) },
        listWorkspaces: () => [workspace],
        acquireSlot: () => {
          throw new Error("docs-only input must not acquire heavy admission");
        },
        stdout: (message) => output.push(message),
        stderr: () => {},
      });
      expect(status).toBe(0);
      expect(output).toContain("[TYPECHECK_CHANGED_NO_WORKSPACE] No affected workspace test program.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed changed-file input", async () => {
    await expect(
      runTypecheckChanged({ env: { CHANGED_FILES_JSON: "{" }, listWorkspaces: () => [] }),
    ).rejects.toMatchObject({
      code: "TYPECHECK_CHANGED_CHANGED_FILES_INVALID",
    });
  });

  it("reports merge-base derivation failure with a non-zero error", async () => {
    await expect(
      runTypecheckChanged({
        env: {},
        execFile: () => {
          throw new Error("merge-base unavailable");
        },
        listWorkspaces: () => [],
      }),
    ).rejects.toMatchObject({ code: "TYPECHECK_CHANGED_DERIVATION_FAILED", exitCode: 2 });
  });

  it.each([
    ["deleted", "bounded-contexts/settlement/tests/deleted.test.ts"],
    ["rename source", "bounded-contexts/settlement/tests/renamed-from.test.ts"],
  ])("maps a %s path to its owning workspace", (_name, changedFile) => {
    const { root, workspace } = fixture();
    try {
      const selected = selectChangedTests({ repoRoot: root, workspaces: [workspace], changedFiles: [changedFile] });
      expect(selected.workspaces.map(({ name }) => name)).toEqual([workspace.name]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports global inputs while selecting only the touched workspace", async () => {
    const { root, workspace } = fixture();
    const output = [];
    try {
      const status = await runTypecheckChanged({
        repoRoot: root,
        env: {
          CHANGED_FILES_JSON: JSON.stringify(["package.json", "bounded-contexts/settlement/src/changed.ts"]),
        },
        listWorkspaces: () => [workspace],
        acquireSlot: () => false,
        stdout: (message) => output.push(message),
        stderr: () => {},
      });
      expect(status).toBe(73);
      expect(output).toContain(
        "[TYPECHECK_CHANGED_GLOBAL_INPUT] package.json; hosted Typecheck remains authoritative.",
      );
      expect(output.join("\n")).toContain("workspaces=@example/settlement");
      expect(output.join("\n")).not.toContain("catalog");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps selector deltas explicit against classifyChanges for real workspace paths", () => {
    const workspaces = listWorkspacePackages({ repoRoot, assertRootCoverage: false });
    const settlement = workspaces.find(
      (workspace) => workspace.root === "bounded-contexts" && workspace.dirName === "settlement",
    );
    expect(settlement).toBeDefined();
    const authContext = workspaces.find(
      (workspace) => workspace.root === "contracts" && workspace.dirName === "auth-context",
    );
    const settlementContext = workspaces.find(
      (workspace) => workspace.root === "bounded-contexts" && workspace.dirName === "settlement",
    );
    expect(authContext).toBeDefined();
    expect(settlementContext).toBeDefined();
    const corpus = [
      [
        "modified",
        "bounded-contexts/settlement/src/changed.ts",
        settlement.name,
        true,
        "dependents and Public Presence are intentionally excluded",
      ],
      ["added", "bounded-contexts/settlement/src/added.ts", settlement.name, true, "added paths map by owner"],
      [
        "deleted",
        "bounded-contexts/settlement/src/deleted.ts",
        settlement.name,
        true,
        "deleted paths remain selectable",
      ],
      [
        "rename source",
        "bounded-contexts/settlement/src/renamed-from.ts",
        settlement.name,
        true,
        "rename sources remain selectable",
      ],
      [
        "contract source",
        "contracts/auth-context/index.ts",
        authContext.name,
        true,
        "contract path maps to its own workspace, not dependents",
      ],
      [
        "context metadata",
        "bounded-contexts/settlement/context.json",
        settlementContext.name,
        true,
        "context metadata maps to its owning context while classifyChanges also routes platform consumers",
      ],
    ];
    for (const [_name, changedFile, expectedWorkspace, scopeContains, reason] of corpus) {
      const selected = selectChangedTests({ repoRoot, workspaces, changedFiles: [changedFile] });
      const scope = classifyChanges({ repoRoot, baseDir: repoRoot, workspaces, changedFiles: [changedFile] });
      expect(
        selected.workspaces.map(({ name }) => name),
        reason,
      ).toEqual([expectedWorkspace]);
      expect(scope.affectedWorkspaces.includes(expectedWorkspace), reason).toBe(scopeContains);
      expect(
        selected.workspaces.map(({ name }) => name),
        reason,
      ).not.toContain("@chase-sets/public-presence");
    }
    for (const [changedFile, reason] of [
      ["package.json", "root runtime input is reported globally without selecting every workspace"],
      ["tsconfig.tests.json", "root test typecheck input is reported globally without selecting every workspace"],
      ["vitest.shared.mjs", "shared Vitest input is reported globally without selecting every workspace"],
    ]) {
      const selected = selectChangedTests({ repoRoot, workspaces, changedFiles: [changedFile] });
      expect(selected.workspaces, reason).toEqual([]);
    }
    for (const dirName of ["stripe-payments", "stripe-connect", "stripe-config", "provider-webhook-inbox"]) {
      const workspace = workspaces.find((entry) => entry.root === "infrastructure" && entry.dirName === dirName);
      expect(workspace, `negative control workspace ${dirName}`).toBeDefined();
      const selected = selectChangedTests({
        repoRoot,
        workspaces,
        changedFiles: [`infrastructure/${dirName}/src/changed.ts`],
      });
      expect(selected.workspaces.map(({ name }) => name)).toContain(workspace.name);
    }
  });
});
