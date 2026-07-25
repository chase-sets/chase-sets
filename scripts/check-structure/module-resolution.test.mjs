import { describe, expect, it } from "vitest";
import { resolveModule } from "./module-resolution.mjs";

const workspacePackages = new Map([
  [
    "@chase-sets/example",
    {
      root: "packages/example",
      exports: {
        ".": "./index.ts",
        "./exact": "./src/exact",
        "./*": "./src/*.ts",
      },
    },
  ],
]);

const existingPaths = new Set([
  "bounded-contexts/example/explicit.ts",
  "bounded-contexts/example/inferred.ts",
  "bounded-contexts/example/directory/index.ts",
  "bounded-contexts/example/module.mts",
  "packages/example/index.ts",
  "packages/example/src/exact/index.mts",
  "packages/example/src/wildcard.ts",
]);

function resolve(importerPath, specifierText) {
  return resolveModule({ importerPath, specifierText, workspacePackages, existingPaths });
}

describe("SQL execution module resolution", () => {
  it.each([
    ["relative with extension", "./explicit.ts", { kind: "repo", path: "bounded-contexts/example/explicit.ts" }],
    ["relative extension inferred", "./inferred", { kind: "repo", path: "bounded-contexts/example/inferred.ts" }],
    ["directory index inferred", "./directory", { kind: "repo", path: "bounded-contexts/example/directory/index.ts" }],
    ["mts candidate", "./module", { kind: "repo", path: "bounded-contexts/example/module.mts" }],
    ["bare workspace package", "@chase-sets/example", { kind: "repo", path: "packages/example/index.ts" }],
    [
      "exact package subpath",
      "@chase-sets/example/exact",
      { kind: "repo", path: "packages/example/src/exact/index.mts" },
    ],
    [
      "wildcard package subpath",
      "@chase-sets/example/wildcard",
      { kind: "repo", path: "packages/example/src/wildcard.ts" },
    ],
    ["non-workspace bare specifier", "hono", { kind: "external" }],
    ["node specifier", "node:path", { kind: "external" }],
  ])("%s", (_label, specifierText, expected) => {
    expect(resolve("bounded-contexts/example/source.ts", specifierText)).toEqual(expected);
  });

  it("rejects a relative path escaping above the repository root", () => {
    expect(resolve("source.ts", "../outside")).toEqual({ kind: "unresolved", reason: "path-escapes-repository" });
  });

  it("reports a missing candidate", () => {
    expect(resolve("bounded-contexts/example/source.ts", "./absent")).toEqual({
      kind: "unresolved",
      reason: "missing-file",
    });
  });

  it("reports an unmatched workspace subpath", () => {
    const packagesWithoutWildcard = new Map([
      ["@chase-sets/example", { root: "packages/example", exports: { ".": "./index.ts" } }],
    ]);
    expect(
      resolveModule({
        importerPath: "bounded-contexts/example/source.ts",
        specifierText: "@chase-sets/example/absent",
        workspacePackages: packagesWithoutWildcard,
        existingPaths,
      }),
    ).toEqual({ kind: "unresolved", reason: "workspace-export-not-found" });
  });
});
