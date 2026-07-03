import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { checkPackageExportTargets, collectExportTargets } from "./check-package-export-targets.mjs";

describe("package export target guard", () => {
  it("collects simple, conditional, and array fallback export targets", () => {
    expect(
      collectExportTargets({
        ".": {
          types: "./src/index.ts",
          import: ["./src/index.mjs", "./src/index.ts"],
        },
        "./styles.css": "./src/styles.css",
      }),
    ).toEqual([
      { exportPath: ". (types)", target: "./src/index.ts" },
      { exportPath: ". (import)", target: "./src/index.mjs" },
      { exportPath: ". (import)", target: "./src/index.ts" },
      { exportPath: "./styles.css", target: "./src/styles.css" },
    ]);
  });

  it("reports package-relative exports whose target file is missing", () => {
    const rootDir = path.join(tmpdir(), `package-export-targets-${process.pid}-${Date.now()}`);
    const packageDir = path.join(rootDir, "packages", "design-system");
    mkdirSync(path.join(packageDir, "src"), { recursive: true });
    writeFileSync(path.join(packageDir, "src", "index.ts"), "export const ok = true;\n");

    const result = checkPackageExportTargets({
      repoRoot: rootDir,
      workspaces: [
        {
          name: "@chase-sets/design-system",
          dir: packageDir,
          packageJsonPath: path.join(packageDir, "package.json"),
          packageJson: {
            exports: {
              ".": "./src/index.ts",
              "./missing": "./src/missing.ts",
            },
          },
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.checkedTargets.map((entry) => entry.exportPath)).toEqual([".", "./missing"]);
    expect(result.violations).toEqual([
      "packages/design-system/package.json: export ./missing target './src/missing.ts' does not resolve to packages/design-system/src/missing.ts.",
    ]);
  });

  it("accepts wildcard export targets when matching package files exist", () => {
    const rootDir = path.join(tmpdir(), `package-export-wildcards-${process.pid}-${Date.now()}`);
    const packageDir = path.join(rootDir, "bounded-contexts", "auth");
    mkdirSync(path.join(packageDir, "routes", "admin"), { recursive: true });
    writeFileSync(path.join(packageDir, "routes", "admin", "sessions.tsx"), "export const route = true;\n");

    const result = checkPackageExportTargets({
      repoRoot: rootDir,
      workspaces: [
        {
          name: "@chase-sets/auth",
          dir: packageDir,
          packageJsonPath: path.join(packageDir, "package.json"),
          packageJson: {
            exports: {
              "./routes/*": "./routes/*.tsx",
            },
          },
        },
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });
});
