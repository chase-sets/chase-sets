import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTypecheckChanged, selectChangedTests, TypecheckChangedError } from "./typecheck-changed.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "typecheck-changed-"));
  const dir = path.join(root, "bounded-contexts", "settlement");
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@example/settlement" }));
  writeFileSync(path.join(dir, "tests", "unchanged.test.ts"), "export const value = 1;\n");
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
});
