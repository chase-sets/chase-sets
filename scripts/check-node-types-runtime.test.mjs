import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectNodeTypesRuntimeVerification } from "./check-node-types-runtime.mjs";

const fixtureRoots = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFixtureRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "node-types-runtime-"));
  fixtureRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

function fixtureRepo(siblingTypesRange) {
  return writeFixtureRepo({
    "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - "tools/*"\n',
    "package.json": { name: "fixture-root", engines: { node: "24.x" }, devDependencies: { "@types/node": "^24.19.1" } },
    "apps/web/package.json": { name: "@fixture/web", devDependencies: { "@types/node": "^24.19.1" } },
    "apps/no-node-types/package.json": { name: "@fixture/no-node-types", dependencies: { yaml: "^2.8.4" } },
    "tools/new-extension/package.json": {
      name: "@fixture/new-extension",
      devDependencies: { "@types/node": siblingTypesRange },
    },
  });
}

describe("check-node-types-runtime", () => {
  it("keeps every repo workspace @types/node declaration on the engines.node major", () => {
    const result = collectNodeTypesRuntimeVerification();

    expect(result.failures).toEqual([]);
    expect(result.runtimeMajor).toBe(24);
    expect(result.manifestPaths).toContain("package.json");
    expect(result.declarations.map((declaration) => declaration.manifestPath)).toContain("package.json");
  });

  it("fails when a sibling manifest discovered from the workspace definition declares another major", () => {
    const result = collectNodeTypesRuntimeVerification(fixtureRepo("^25.3.3"));

    expect(result.manifestPaths).toEqual([
      "apps/no-node-types/package.json",
      "apps/web/package.json",
      "package.json",
      "tools/new-extension/package.json",
    ]);
    expect(result.failures).toEqual([
      'tools/new-extension/package.json devDependencies @types/node "^25.3.3" is major 25; engines.node runtime is major 24.',
    ]);
  });

  it("passes when every discovered manifest declares the engines.node major", () => {
    const result = collectNodeTypesRuntimeVerification(fixtureRepo("^24.1.0"));

    expect(result.failures).toEqual([]);
    expect(result.declarations.map(({ manifestPath, major }) => [manifestPath, major])).toEqual([
      ["apps/web/package.json", 24],
      ["package.json", 24],
      ["tools/new-extension/package.json", 24],
    ]);
  });

  it("fails closed on ranges and workspace patterns it cannot compare", () => {
    const root = fixtureRepo(">=24");
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "tools/*"\n  - "nested/**"\n');

    expect(collectNodeTypesRuntimeVerification(root).failures).toEqual([
      'pnpm-workspace.yaml package pattern "nested/**" is not a directory or "<dir>/*" glob.',
      'tools/new-extension/package.json devDependencies @types/node ">=24" must name exactly one major.',
    ]);
  });
});
