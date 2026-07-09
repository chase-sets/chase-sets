import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectFiles } from "./lib/files.mjs";
import { repoRoot } from "./lib/repo.mjs";

const directTypescriptImportPattern =
  /(?:from\s+["']typescript["']|require\(["']typescript["']\)|import\(["']typescript["']\))/;

describe("compiler API script toolchain", () => {
  it("keeps script compiler API imports behind the pinned workspace facade", async () => {
    const scriptFiles = await collectFiles(path.join(repoRoot, "scripts"), {
      extensions: new Set([".mjs", ".cjs", ".js"]),
    });

    const directImports = scriptFiles
      .filter((filePath) => directTypescriptImportPattern.test(readFileSync(filePath, "utf8")))
      .map((filePath) => path.relative(repoRoot, filePath));

    expect(directImports).toEqual([]);
  });

  it("pins the script compiler API dependency independently from the root tsc toolchain", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "packages", "typescript-compiler-api", "package.json"), "utf8"),
    );

    expect(packageJson.dependencies).toMatchObject({
      "typescript-api": "npm:@typescript/typescript6@^6.0.0",
    });
    expect(packageJson.dependencies).not.toHaveProperty("typescript");
  });
});
