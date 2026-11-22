import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { expect, it, onTestFinished, vi } from "vitest";
import { CI_GATE_DEFINITIONS } from "./ci-gate-plan.mjs";
import { listWorkspacePackages, normalizeRelative, repoRoot } from "./lib/repo.mjs";
import { verifyTypecheck } from "./verify-typecheck.mjs";

const fullCommands = [
  ["run", "check:no-any"],
  ["exec", "tsc", "-p", "./tsconfig.json", "--noEmit"],
  ["exec", "tsc", "-p", "./tsconfig.strict.json", "--noEmit"],
  ["run", "test:typecheck"],
];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "verify-typecheck-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({
    "contracts/value/package.json": { name: "@chase-sets/value" },
    "contracts/value/index.ts": "export const value = 1;",
    "contracts/value/index.test.ts": 'import { value } from "./index"; void value;',
    "packages/one/package.json": { name: "@chase-sets/one" },
    "packages/one/index.ts": 'export { value } from "../../contracts/value";',
    "packages/one/index.test.ts": 'import { value } from "./index"; void value;',
    "packages/two/package.json": { name: "@chase-sets/two" },
    "packages/two/index.ts": 'export { value } from "../one";',
    "packages/two/index.test.ts": 'import { value } from "./index"; void value;',
    "tsconfig.json": { include: ["**/*.ts"], exclude: ["**/*.test.ts", ".tmp/**"] },
    "tsconfig.strict.json": { extends: "./tsconfig.json", include: ["contracts/**/*.ts"] },
    "tsconfig.tests.json": { include: ["**/*.test.ts"] },
  })) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

it("all workspace typecheck scripts use their own selector", () => {
  const wrapperPath = path.join(repoRoot, "scripts", "verify-typecheck.mjs");
  for (const { dir, name, packageJson, packageJsonPath } of listWorkspacePackages()) {
    const wrapper = normalizeRelative(wrapperPath, dir);
    expect(packageJson.scripts?.typecheck, normalizeRelative(packageJsonPath, repoRoot)).toBe(
      `node ${wrapper} --workspace=${name}`,
    );
  }
});

it("workspace selectors alter actual compiler input sets", async () => {
  const root = fixture();
  async function compile(argv) {
    const configs = [];
    const run = vi.fn((args) => {
      if (args[0] !== "exec") return;
      expect(args.slice(0, 3)).toEqual(["exec", "tsc", "-p"]);
      expect(args[4]).toBe("--noEmit");
      const { extends: base, files, include } = JSON.parse(readFileSync(args[3], "utf8"));
      expect(include).toEqual([]);
      configs.push([path.basename(base), files.map((file) => normalizeRelative(file, root)).sort()]);
    });
    expect(await verifyTypecheck({ root, argv, run })).toBe(0);
    expect(run).toHaveBeenNthCalledWith(1, ["run", "check:no-any"]);
    expect(run).toHaveBeenCalledTimes(configs.length + 1);
    expect(run.mock.calls.slice(1).every(([[, , , file]]) => !existsSync(file))).toBe(true);
    return configs;
  }

  expect(await compile(["--workspace=@chase-sets/one"])).toEqual([
    ["tsconfig.json", ["packages/one/index.ts"]],
    ["tsconfig.tests.json", ["packages/one/index.test.ts"]],
  ]);
  expect(await compile(["--workspace=@chase-sets/two"])).toEqual([
    ["tsconfig.json", ["packages/two/index.ts"]],
    ["tsconfig.tests.json", ["packages/two/index.test.ts"]],
  ]);
  const combined = [
    ["tsconfig.json", ["contracts/value/index.ts", "packages/one/index.ts"]],
    ["tsconfig.strict.json", ["contracts/value/index.ts"]],
    ["tsconfig.tests.json", ["contracts/value/index.test.ts", "packages/one/index.test.ts"]],
  ];
  expect(await compile(["--workspace-list=@chase-sets/one,@chase-sets/value"])).toEqual(combined);
  expect(await compile(["--workspace=@chase-sets/one", "--workspace=@chase-sets/value"])).toEqual(combined);
});

it.each(["--workspace=@chase-sets/nonexistent", "--workspace-list=", "--workspace-list=@chase-sets/one,", "--unknown"])(
  "rejects %s before issuing any command, with CLI exit 2",
  async (arg) => {
    const root = fixture();
    const run = vi.fn();
    await expect(verifyTypecheck({ root, argv: [arg], run })).rejects.toMatchObject({
      code: "TYPECHECK_SCOPE_INVALID_SELECTOR",
      exitCode: 2,
    });
    expect(run).not.toHaveBeenCalled();
    const cli = spawnSync(process.execPath, ["./scripts/verify-typecheck.mjs", arg], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain("[TYPECHECK_SCOPE_INVALID_SELECTOR]");
  },
);

it("keeps all four commands in the original order for unscoped runs and selector fallback", async () => {
  const root = fixture();
  const run = vi.fn();
  const stdout = vi.fn();
  await verifyTypecheck({ root, argv: [], run, stdout });
  expect(run.mock.calls.map(([args]) => args)).toEqual(fullCommands);
  expect(stdout).not.toHaveBeenCalled();

  run.mockClear();
  writeFileSync(path.join(root, "packages/two/index.ts"), 'export * from "@chase-sets/missing";');
  await verifyTypecheck({ root, argv: ["--workspace=@chase-sets/one"], run, stdout });
  expect(run.mock.calls.map(([args]) => args)).toEqual(fullCommands);
  expect(stdout).toHaveBeenCalledWith(
    "[TYPECHECK_SCOPE_FULL_FALLBACK] reason=unresolved-workspace-import path=packages/two/index.ts",
  );
});

it("full hosted typecheck remains unconditional", () => {
  expect(CI_GATE_DEFINITIONS.find(({ id }) => id === "typecheck")?.category).toBe("always-required");
  const workflow = parseYaml(readFileSync(path.join(repoRoot, ".github/workflows/platform-pr.yml"), "utf8"));
  expect(workflow.jobs.typecheck.steps.find(({ name }) => name === "Typecheck repository")?.run).toBe(
    "pnpm run verify:typecheck",
  );
});
