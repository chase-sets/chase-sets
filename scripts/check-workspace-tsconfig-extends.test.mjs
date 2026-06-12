import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkWorkspaceTsconfigExtends } from "./check-workspace-tsconfig-extends.mjs";

const temporaryRoots = [];

function createTempRepo() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-tsconfig-"));
  temporaryRoots.push(rootDir);
  writeJson(rootDir, "tsconfig.base.json", { compilerOptions: { strict: true } });
  writeJson(rootDir, "tsconfig.vitest.json", {
    extends: "./tsconfig.base.json",
    compilerOptions: { types: ["vitest/globals"] },
  });
  return rootDir;
}

function writeJson(rootDir, relativePath, value) {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("checkWorkspaceTsconfigExtends", () => {
  it("accepts workspace tsconfigs that extend the root canonical configs", async () => {
    const rootDir = createTempRepo();
    writeJson(rootDir, "contracts/payments/tsconfig.json", {
      extends: "../../tsconfig.base.json",
      include: ["*.ts"],
    });
    writeText(
      rootDir,
      "bounded-contexts/payments/tests/tsconfig.json",
      `// JSONC comments are valid in tsconfig files.\n{\n  "extends": "../../../tsconfig.vitest.json",\n  "compilerOptions": {\n    "types": ["node", "vitest/globals"]\n  },\n  "include": ["../**/*.ts"]\n}\n`,
    );

    const result = await checkWorkspaceTsconfigExtends({ repoRoot: rootDir });

    expect(result.passed).toBe(true);
    expect(result.files).toEqual(["bounded-contexts/payments/tests/tsconfig.json", "contracts/payments/tsconfig.json"]);
  });

  it("rejects workspace tsconfigs that extend the root solution config", async () => {
    const rootDir = createTempRepo();
    writeJson(rootDir, "infrastructure/email/tsconfig.json", {
      extends: "../../tsconfig.json",
      include: ["*.ts"],
    });

    const result = await checkWorkspaceTsconfigExtends({ repoRoot: rootDir });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining("infrastructure/email/tsconfig.json: extends ../../tsconfig.json"),
    ]);
  });

  it("rejects exact local vitest globals types instead of the shared vitest config", async () => {
    const rootDir = createTempRepo();
    writeJson(rootDir, "contracts/money-movement/tsconfig.json", {
      extends: "../../tsconfig.vitest.json",
      compilerOptions: {
        types: ["vitest/globals"],
      },
      include: ["*.ts"],
    });

    const result = await checkWorkspaceTsconfigExtends({ repoRoot: rootDir });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining('replace compilerOptions.types ["vitest/globals"] with tsconfig.vitest.json'),
    ]);
  });
});
