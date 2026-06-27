import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBoundedContextsSection,
  buildDeployablesSection,
  syncReadmeManifestSections,
} from "./generate-readme-manifest-sections.mjs";

const temporaryRoots = [];

function createTempRepo() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-readme-"));
  temporaryRoots.push(rootDir);
  writeFileSync(
    path.join(rootDir, "README.md"),
    `# Test

## Bounded Contexts

old contexts

## Deployables

old deployables

## Prerequisites

Done.
`,
  );
  return rootDir;
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { force: true, recursive: true });
  }
});

describe("buildBoundedContextsSection", () => {
  it("generates the root README bounded-context list from context manifests", () => {
    const rootDir = createTempRepo();
    writeJson(path.join(rootDir, "bounded-contexts", "catalog", "context.json"), {
      contextName: "catalog",
      packageName: "@chase-sets/catalog",
      ownedNouns: ["catalog-item", "category"],
    });
    writeJson(path.join(rootDir, "bounded-contexts", "identity", "context.json"), {
      contextName: "identity",
      packageName: "@chase-sets/identity",
      ownedNouns: ["user", "account"],
    });

    expect(buildBoundedContextsSection({ repoRoot: rootDir })).toContain(
      "- `catalog` ([README](bounded-contexts/catalog/README.md), `@chase-sets/catalog`): owned nouns `catalog-item`, `category`.",
    );
    expect(buildBoundedContextsSection({ repoRoot: rootDir })).toContain(
      "- `identity` ([README](bounded-contexts/identity/README.md), `@chase-sets/identity`): owned nouns `user`, `account`.",
    );
  });
});

describe("buildDeployablesSection", () => {
  it("generates the root README deployable list from package manifests", () => {
    const rootDir = createTempRepo();
    writeJson(path.join(rootDir, "deployables", "marketplace", "package.json"), {
      name: "@chase-sets/app-marketplace-web",
      scripts: { test: "vitest", build: "vite build" },
    });
    writeJson(path.join(rootDir, "deployables", "marketplace-seed-testing", "package.json"), {
      name: "@chase-sets/marketplace-seed-testing",
      scripts: { "test:db": "vitest" },
    });

    const section = buildDeployablesSection({ repoRoot: rootDir });

    expect(section).toContain(
      "- `deployables/marketplace` (`@chase-sets/app-marketplace-web`): package scripts `build`, `test`.",
    );
    expect(section).toContain(
      "- `deployables/marketplace-seed-testing` (`@chase-sets/marketplace-seed-testing`): package scripts `test:db`.",
    );
  });
});

describe("syncReadmeManifestSections", () => {
  it("fails check mode when the generated README sections are stale", () => {
    const rootDir = createTempRepo();
    writeJson(path.join(rootDir, "bounded-contexts", "catalog", "context.json"), {
      contextName: "catalog",
      packageName: "@chase-sets/catalog",
      ownedNouns: ["catalog-item"],
    });

    expect(() => syncReadmeManifestSections({ repoRoot: rootDir, check: true })).toThrow(
      "README.md has stale generated manifest sections",
    );
  });

  it("updates README and then passes check mode", () => {
    const rootDir = createTempRepo();
    writeJson(path.join(rootDir, "bounded-contexts", "catalog", "context.json"), {
      contextName: "catalog",
      packageName: "@chase-sets/catalog",
      ownedNouns: ["catalog-item"],
    });
    writeJson(path.join(rootDir, "deployables", "marketplace", "package.json"), {
      name: "@chase-sets/app-marketplace-web",
      scripts: { dev: "react-router dev" },
    });

    syncReadmeManifestSections({ repoRoot: rootDir });

    expect(() => syncReadmeManifestSections({ repoRoot: rootDir, check: true })).not.toThrow();
  });
});
