import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { runTypecheckChanged } from "./typecheck-changed.mjs";

const changed = "contracts/contract/index.ts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "typecheck-changed-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({
    "contracts/contract/package.json": { name: "@chase-sets/contract" },
    [changed]: "export const value = 1;",
    "contracts/contract/index.test.ts": 'import { value } from "./index"; void value;',
    "packages/consumer/package.json": { name: "@chase-sets/consumer" },
    "packages/consumer/index.ts": 'export { value } from "../../contracts/contract";',
    "packages/consumer/index.test.ts": 'import { value } from "./index"; void value;',
    "tsconfig.json": { include: ["**/*.ts"], exclude: ["**/*.test.ts"] },
    "tsconfig.strict.json": { extends: "./tsconfig.json", include: ["contracts/**/*.ts"] },
    "tsconfig.tests.json": { include: ["**/*.test.ts"] },
  })) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

const envFor = (...files) => ({ CHANGED_FILES_JSON: JSON.stringify(files) });

it("runs source, applicable strict and test programs for affected workspaces without heavy admission", async () => {
  const root = fixture();
  const stdout = vi.fn();
  const configs = [];
  const temporaryFiles = [];
  const runCompiler = (configPath) => {
    configs.push(JSON.parse(readFileSync(configPath, "utf8")));
    temporaryFiles.push(configPath);
    return 0;
  };
  expect(await runTypecheckChanged({ root, env: envFor(changed), runCompiler, stdout })).toBe(0);
  expect(stdout).toHaveBeenCalledWith(
    "[TYPECHECK_CHANGED_SCOPED] workspaces=@chase-sets/consumer,@chase-sets/contract programs=source,strict,test",
  );
  expect(configs.map((config) => config.extends)).toEqual([
    "../../tsconfig.json",
    "../../tsconfig.strict.json",
    "../../tsconfig.tests.json",
  ]);
  expect(configs[0].files).toContain(path.join(root, "packages/consumer/index.ts"));
  expect(configs[1].files).toEqual([path.join(root, changed)]);
  expect(configs[2].files).toContain(path.join(root, "packages/consumer/index.test.ts"));
  expect(configs.every((config) => config.include.length === 0)).toBe(true);
  expect(temporaryFiles.every((file) => !existsSync(file))).toBe(true);
  expect(readFileSync(new URL("./typecheck-changed.mjs", import.meta.url), "utf8")).not.toMatch(
    /heavy-slot|acquireHeavySlot|invoke-heavy-verifier/,
  );
});

it("skips strict when no strict roots are owned by affected workspaces", async () => {
  const root = fixture();
  const configs = [];
  expect(
    await runTypecheckChanged({
      root,
      env: envFor("packages/consumer/index.ts"),
      runCompiler: (configPath) => {
        configs.push(JSON.parse(readFileSync(configPath, "utf8")).extends);
        return 0;
      },
      stdout: vi.fn(),
    }),
  ).toBe(0);
  expect(configs).toEqual(["../../tsconfig.json", "../../tsconfig.tests.json"]);
});

it("propagates a compiler failure and cleans up its temporary program", async () => {
  const root = fixture();
  const runCompiler = vi.fn(() => 7);
  expect(await runTypecheckChanged({ root, env: envFor(changed), runCompiler, stdout: vi.fn() })).toBe(7);
  expect(runCompiler).toHaveBeenCalledTimes(1);
  expect(existsSync(runCompiler.mock.calls[0][0])).toBe(false);
});

it.each([
  [["package.json", changed], 3, "[TYPECHECK_CHANGED_FULL_REQUIRED]", "reason=global-input path=package.json"],
  [["docs/runbook.md"], 0, "[TYPECHECK_CHANGED_NO_WORKSPACE]"],
])("reports %j with exit %i without compiling", async (files, code, marker, fallback) => {
  const root = fixture();
  const stdout = vi.fn();
  const runCompiler = vi.fn();
  expect(await runTypecheckChanged({ root, env: envFor(...files), runCompiler, stdout })).toBe(code);
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining(marker));
  if (fallback) expect(stdout).toHaveBeenCalledWith(`[TYPECHECK_SCOPE_FULL_FALLBACK] ${fallback}`);
  expect(runCompiler).not.toHaveBeenCalled();
  expect(existsSync(path.join(root, ".tmp"))).toBe(false);
});

it("fails closed for malformed changed-file input and usage", async () => {
  await expect(runTypecheckChanged({ env: { CHANGED_FILES_JSON: "{" } })).rejects.toMatchObject({
    code: "TYPECHECK_CHANGED_CHANGED_FILES_INVALID",
    exitCode: 2,
  });
  await expect(runTypecheckChanged({ argv: ["--unknown"] })).rejects.toMatchObject({
    code: "TYPECHECK_CHANGED_USAGE",
    exitCode: 2,
  });
});

it("reports merge-base derivation failure with a non-zero error", async () => {
  await expect(
    runTypecheckChanged({
      env: {},
      execFile: () => {
        throw new Error("merge-base unavailable");
      },
    }),
  ).rejects.toMatchObject({ code: "TYPECHECK_CHANGED_DERIVATION_FAILED", exitCode: 2 });
});
