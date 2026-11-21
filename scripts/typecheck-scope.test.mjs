import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { expect, it, onTestFinished, vi } from "vitest";
import { listWorkspacePackages, normalizeRelative, repoRoot } from "./lib/repo.mjs";
import { createTypecheckScope, deriveChangedFiles, printFallbacks, runScopedPrograms } from "./typecheck-scope.mjs";

const valueFile = "contracts/value/index.ts";
const moneyMovement = "contracts/money-movement/index.ts";
const localEmail = "@chase-sets/local-email-capture";
const realScope = createTypecheckScope();

function write(root, file, content) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "typecheck-scope-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const workspaces = [
    "contracts/value",
    "packages/type-only",
    "packages/reexport",
    "packages/relative",
    "deployables/dynamic",
    "packages/unrelated",
  ];
  for (const dir of workspaces) write(root, `${dir}/package.json`, { name: `@chase-sets/${path.basename(dir)}` });
  for (const [file, content] of Object.entries({
    "tsconfig.json": {
      compilerOptions: {
        module: "Preserve",
        moduleResolution: "Bundler",
        strict: true,
        paths: {
          "@chase-sets/value": ["./contracts/value/index.ts"],
          "@chase-sets/type-only": ["./packages/type-only/index.ts"],
          "@chase-sets/relative": ["./packages/relative/index.ts"],
        },
      },
      include: ["**/*.ts"],
      exclude: ["**/*.test.ts", ".tmp/**"],
    },
    "tsconfig.strict.json": { extends: "./tsconfig.json", include: ["contracts/**/*.ts"] },
    "tsconfig.tests.json": { extends: "./tsconfig.json", include: ["**/*.test.ts", "ambient.d.ts"], exclude: [] },
    "ambient.d.ts": 'declare module "*.css";',
    [valueFile]: "export type Value = { id: string };",
    "packages/type-only/index.ts": 'import type { Value } from "@chase-sets/value"; export type Input = Value;',
    "packages/reexport/index.ts": 'export type { Input } from "@chase-sets/type-only";',
    "packages/reexport/cycle.ts": 'export type { Output } from "@chase-sets/relative";',
    "packages/relative/index.ts":
      'import type { Input } from "../../packages/reexport"; export type Output = string; export const id = (value: Input): Output => value.id;',
    "deployables/dynamic/index.test.ts": 'export const lazy = () => import("../../packages/relative");',
    "packages/unrelated/index.ts": "export const sentinel = 1;",
    "packages/unrelated/globals.ts":
      "export {}; declare /* preserve this augmentation */ global { interface FixtureGlobal { id: number } }",
    "packages/unrelated/module.ts": "declare module FixtureModule { export interface Settings { id: number } }",
  }))
    write(root, file, content);
  return root;
}

function parseConfig(root, config) {
  const configPath = path.resolve(root, config);
  const { config: input, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(input, ts.sys, path.dirname(configPath), {}, configPath);
  expect(parsed.errors).toEqual([]);
  return parsed;
}

function diagnostics(root, config) {
  const { fileNames, options } = parseConfig(root, config);
  return ts
    .getPreEmitDiagnostics(ts.createProgram(fileNames, options))
    .filter(({ file }) => file && normalizeRelative(file.fileName, root) === "packages/relative/index.ts")
    .map(({ code }) => code);
}

it("affected graph retains reverse consumers and explicit fallback", async () => {
  const root = fixture();
  expect(diagnostics(root, "tsconfig.json")).toEqual([]);
  write(root, valueFile, "export type Value = { id: number };");
  const plan = createTypecheckScope({ root }).plan({ changedFiles: [valueFile] });
  expect(plan.mode).toBe("scoped");
  expect(plan.workspaces).toEqual([
    "@chase-sets/dynamic",
    "@chase-sets/reexport",
    "@chase-sets/relative",
    "@chase-sets/type-only",
    "@chase-sets/value",
  ]);
  const [source] = plan.programs;
  expect(source.roots).toContain("packages/unrelated/globals.ts");
  expect(source.roots).toContain("packages/unrelated/module.ts");
  expect(source.roots).not.toContain("packages/unrelated/index.ts");
  const fullDiagnostics = diagnostics(root, "tsconfig.json");
  expect(fullDiagnostics).toEqual([2322]);
  await runScopedPrograms(root, [source], (configPath) => {
    expect(diagnostics(root, configPath)).toEqual(fullDiagnostics);
  });

  const realPlan = realScope.plan({ changedFiles: [moneyMovement] });
  expect(realPlan.mode).toBe("scoped");
  expect(realPlan.workspaces).toEqual(
    expect.arrayContaining([
      "@chase-sets/settlement",
      "@chase-sets/stripe-connect",
      "@chase-sets/app-platform-api",
      "@chase-sets/app-platform-worker",
    ]),
  );

  const changedInputs = [
    ["global-input", "package.json"],
    ["global-input", "pnpm-lock.yaml"],
    ["global-input", "tsconfig.tests.json"],
    ["global-input", "vitest.shared.mjs"],
    ["workspace-config", "contracts/value/package.json"],
    ["workspace-config", "contracts/value/tsconfig.any.json"],
    ["declaration-input", "packages/unrelated/ambient.d.ts"],
    ["unmapped-typescript", "infrastructure/no-owner/index.ts"],
  ];
  const scope = createTypecheckScope({ root });
  for (const [reason, file] of changedInputs) {
    const fallback = scope.plan({ changedFiles: [file] });
    expect(fallback).toEqual({ mode: "full", fallbacks: [{ reason, path: file }] });
    const output = vi.fn();
    printFallbacks(fallback.fallbacks, output);
    expect(output).toHaveBeenCalledWith(`[TYPECHECK_SCOPE_FULL_FALLBACK] reason=${reason} path=${file}`);
  }

  const unrelated = "packages/unrelated/index.ts";
  const asset = "contracts/value/styles.css";
  write(root, asset, "body { color: black; }");
  write(root, unrelated, 'import "../../contracts/value/styles.css";');
  expect(createTypecheckScope({ root }).plan({ changedFiles: [asset] }).workspaces).toContain("@chase-sets/unrelated");

  const imports = ["@chase-sets/no-owner", "../../contracts/value/missing", "../../contracts/value/missing.css"];
  write(root, unrelated, imports.map((specifier) => `import "${specifier}";`).join("\n"));
  const fallback = createTypecheckScope({ root }).plan({ changedFiles: [valueFile] });
  expect(fallback).toEqual({
    mode: "full",
    fallbacks: imports.map((specifier) => ({ reason: "unresolved-workspace-import", path: unrelated, specifier })),
  });
  const output = vi.fn();
  printFallbacks(fallback.fallbacks, output);
  expect(output).toHaveBeenCalledWith(
    `[TYPECHECK_SCOPE_FULL_FALLBACK] reason=unresolved-workspace-import path=${unrelated}`,
  );
});

it("selects both sides of a git rename and deleted-file consumers; a deleted workspace requires full", () => {
  const root = fixture();
  const renameFrom = "contracts/value/rename-from.ts";
  const renameTo = "packages/unrelated/rename-to.ts";
  const deleted = "packages/relative/delete-me.ts";
  write(root, renameFrom, "export const from = 1;");
  write(root, deleted, "export const gone = 1;");
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        `core.hooksPath=${path.join(root, "no-hooks")}`,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: root,
        stdio: "pipe",
        encoding: "utf8",
      },
    );
  git("init");
  git("add", ".");
  git("commit", "-m", "Baseline fixture");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  renameSync(path.join(root, renameFrom), path.join(root, renameTo));
  rmSync(path.join(root, deleted));
  git("add", "-A");
  git("commit", "-m", "Rename and delete fixture files");
  const changedFiles = deriveChangedFiles({ root, env: {} });
  expect(changedFiles).toEqual([renameFrom, deleted, renameTo]);
  const scope = createTypecheckScope({ root });
  expect(scope.plan({ changedFiles }).workspaces).toEqual([
    "@chase-sets/dynamic",
    "@chase-sets/reexport",
    "@chase-sets/relative",
    "@chase-sets/type-only",
    "@chase-sets/unrelated",
    "@chase-sets/value",
  ]);
  expect(scope.plan({ changedFiles: [deleted] }).workspaces).toEqual([
    "@chase-sets/dynamic",
    "@chase-sets/reexport",
    "@chase-sets/relative",
  ]);
  git("rm", "-r", "packages/unrelated");
  git("commit", "-m", "Delete fixture workspace");
  const fallback = createTypecheckScope({ root }).plan({ changedFiles: deriveChangedFiles({ root, env: {} }) });
  const output = vi.fn();
  printFallbacks(fallback.fallbacks, output);
  expect(output).toHaveBeenCalledWith(
    "[TYPECHECK_SCOPE_FULL_FALLBACK] reason=deleted-workspace path=packages/unrelated/package.json",
  );
});

it("scoped programs are subsets of the full gate programs", () => {
  const workspaces = listWorkspacePackages({ repoRoot });
  const prefixes = workspaces.map(({ dir }) => `${normalizeRelative(dir, repoRoot)}/`);
  const fullPrograms = new Map();
  const augmentations = new Map();
  for (const config of ["tsconfig.json", "tsconfig.strict.json", "tsconfig.tests.json"]) {
    const { fileNames } = parseConfig(repoRoot, config);
    const roots = new Set(fileNames.map((file) => normalizeRelative(file, repoRoot)));
    const mandatory = [...roots].filter((file) => {
      if (/\.d\.ts$/.test(file) || !prefixes.some((prefix) => file.startsWith(prefix))) return true;
      if (!augmentations.has(file)) {
        const text = readFileSync(path.join(repoRoot, file), "utf8");
        augmentations.set(file, /\bdeclare(?:\s|\/\*[\s\S]*?\*\/)+(?:global|module)\b/.test(text));
      }
      return augmentations.get(file);
    });
    fullPrograms.set(config, { roots, mandatory });
  }
  for (const { name } of workspaces) {
    const plan = realScope.plan({ workspaceNames: [name] });
    expect(plan.mode).toBe("scoped");
    expect(plan.workspaces).toEqual([name]);
    for (const { config, roots } of plan.programs) {
      const full = fullPrograms.get(config);
      const scoped = new Set(roots);
      expect(
        roots.filter((file) => !full.roots.has(file)),
        `${name} ${config} subset`,
      ).toEqual([]);
      expect(
        full.mandatory.filter((file) => !scoped.has(file)),
        `${name} ${config} mandatory roots`,
      ).toEqual([]);
    }
  }
  const email = realScope.plan({ workspaceNames: [localEmail] });
  expect(email.programs.flatMap(({ roots }) => roots)).not.toContain(moneyMovement);
});

it("scoped plan reports input counts against the full gate", () => {
  const plan = realScope.plan({ workspaceNames: [localEmail] });
  const summary = realScope.summarize(plan);
  expect(summary.programs.map(({ name }) => name)).toEqual(["source", "strict", "test"]);
  for (const { name, scoped, full, wholeGraph } of summary.programs) {
    expect(full.roots).toBeGreaterThan(scoped.roots);
    expect(full.forwardClosure).toBeGreaterThan(scoped.forwardClosure);
    expect(scoped.forwardClosure).toBeGreaterThanOrEqual(scoped.roots);
    expect(wholeGraph).toBe(false);
    if (name === "strict") expect(scoped).toEqual({ roots: 0, forwardClosure: 0 });
    else expect(scoped.roots).toBeGreaterThan(0);
  }
  expect(
    realScope
      .summarize(realScope.plan({ changedFiles: ["package.json"] }))
      .programs.every(
        ({ scoped, full, wholeGraph }) =>
          wholeGraph && scoped.roots === full.roots && scoped.forwardClosure === full.forwardClosure,
      ),
  ).toBe(true);
});
