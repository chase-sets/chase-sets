import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = "scripts/fixtures/lint-async";
const scannedRoots = ["bounded-contexts", "contracts", "infrastructure", "deployables", "packages"];

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

// Splits the configured `lint:async` command into its options and scanned roots,
// so the fixtures run through the same entrypoint and configuration as the repo.
function lintAsyncCommand() {
  const [command, ...args] = readJson("package.json").scripts["lint:async"].split(/\s+/);
  const configIndex = args.indexOf("-c");
  return { command, options: args.slice(0, configIndex + 2), roots: args.slice(configIndex + 2) };
}

function runConfiguredOxlint(options, targets) {
  const oxlintPackage = createRequire(path.join(repoRoot, "package.json")).resolve("oxlint/package.json");
  const bin = path.join(path.dirname(oxlintPackage), readJson(path.relative(repoRoot, oxlintPackage)).bin.oxlint);
  return spawnSync(process.execPath, [bin, ...options, "--format=json", ...targets], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("lint:async", () => {
  it("scans every workspace root with only the two promise rules", () => {
    const { command, options, roots } = lintAsyncCommand();
    const config = readJson(".oxlintrc.json");

    expect(command).toBe("oxlint");
    expect(options).toEqual(["-c", ".oxlintrc.json"]);
    expect(roots).toEqual(scannedRoots);
    expect(scannedRoots.some((root) => fixtureRoot.startsWith(`${root}/`))).toBe(false);
    expect(Object.values(config.categories).every((severity) => severity === "off")).toBe(true);
    expect(config.options).toEqual({ typeAware: true, denyWarnings: true });
    expect(config.rules).toEqual({
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
    });
  });

  it("lint-async rejects floating and misused promises", () => {
    const { options } = lintAsyncCommand();
    const result = runConfiguredOxlint(options, [fixtureRoot]);
    const findings = JSON.parse(result.stdout).diagnostics.map((diagnostic) => ({
      file: diagnostic.filename.replaceAll("\\", "/"),
      rule: diagnostic.code,
    }));

    expect(result.status, result.stderr).toBe(1);
    expect(findings.sort((left, right) => left.file.localeCompare(right.file))).toEqual([
      { file: `${fixtureRoot}/floating.ts`, rule: "typescript(no-floating-promises)" },
      { file: `${fixtureRoot}/misused.ts`, rule: "typescript(no-misused-promises)" },
    ]);
  });
});
