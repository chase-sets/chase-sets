import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";

const repo = new URL("../../", import.meta.url);
const technicalWorkspaces = [
  "contracts/catalog-seed",
  "contracts/seller-attention-queue",
  "infrastructure/event-core-postgres",
  "infrastructure/platform-runtime",
  "packages/design-system",
];
const ownerCatalogs = [
  "contracts/localization/test-fixtures/localization/locales/en.ts",
  "contracts/seller-attention-queue/localization/locales/en.ts",
  "infrastructure/platform-runtime/localization/locales/en.ts",
  "packages/design-system/src/localization/locales/en.ts",
];

function imports(source) {
  return ts.preProcessFile(source, true, true).importedFiles.map(({ fileName }) => fileName);
}

function forbiddenLocalizationImports(file, source) {
  return imports(source).filter((specifier) => {
    if (specifier.startsWith(".")) {
      const target = path.posix.join(path.posix.dirname(file), specifier);
      return (
        /^contracts\/localization(?:\/index(?:\.[cm]?[jt]s)?)?$/.test(target) ||
        target.startsWith("contracts/localization/locales/")
      );
    }
    return specifier === "@chase-sets/localization" || specifier.startsWith("@chase-sets/localization/locales/");
  });
}

describe("technical localization ownership", () => {
  it("forbids the root and locale subpaths in technical workspaces", () => {
    const files = execFileSync("git", ["ls-files", "-z", "--", ...technicalWorkspaces], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: GIT_LISTING_MAX_BUFFER,
    })
      .split("\0")
      .filter((file) => /\.[cm]?[jt]sx?$/.test(file));

    expect(files.length).toBeGreaterThan(0);
    expect(
      files.flatMap((file) =>
        forbiddenLocalizationImports(file, readFileSync(new URL(file, repo), "utf8")).map(
          (specifier) => `${file}: ${specifier}`,
        ),
      ),
    ).toEqual([]);
  });

  it.each(ownerCatalogs)("keeps %s import-free", (file) => {
    expect(imports(readFileSync(new URL(file, repo), "utf8"))).toEqual([]);
  });

  it("rejects a root import fixture without rejecting the core import", () => {
    const fixture = readFileSync(new URL("./fixtures/technical-localization/root-import.ts", import.meta.url), "utf8");
    expect(forbiddenLocalizationImports("infrastructure/platform-runtime/http.ts", fixture)).toEqual([
      "@chase-sets/localization",
    ]);
  });
});
