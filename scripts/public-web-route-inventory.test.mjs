import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  derivePublicWebRouteInventory,
  generatedHelpCatalogPath,
  trackedFileRule,
} from "./public-web-route-inventory.mjs";
import { repoRoot } from "./lib/repo.mjs";

const restoredFiles = new Map();
const temporaryRoots = [];

function replaceTracked(relativePath, replacement) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!restoredFiles.has(absolutePath)) restoredFiles.set(absolutePath, readFileSync(absolutePath, "utf8"));
  writeFileSync(absolutePath, replacement, "utf8");
}

afterEach(() => {
  for (const [filePath, original] of restoredFiles) writeFileSync(filePath, original, "utf8");
  restoredFiles.clear();
  for (const rootDir of temporaryRoots.splice(0)) rmSync(rootDir, { force: true, recursive: true });
});

function write(rootDir, relativePath, content) {
  const absolutePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

function independentlyReadPublicWebRoutes() {
  const manifests = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((candidate) => /^bounded-contexts\/[^/]+\/context\.json$/.test(candidate));
  return manifests.flatMap((manifestPath) =>
    JSON.parse(readFileSync(path.join(repoRoot, manifestPath), "utf8"))
      .deployableContributions.filter((contribution) => contribution.deployable === "public-web")
      .flatMap((contribution) => contribution.routes.map((route) => route.routeId)),
  );
}

describe("public-web route inventory", () => {
  it("derives the complete real-source surface and an exclusive partition", () => {
    const inventory = derivePublicWebRouteInventory({ rootDir: repoRoot });
    expect(inventory.sources.manifests).toHaveLength(independentlyReadPublicWebRoutes().length);
    expect(
      inventory.sources.manifests.every((source) =>
        /^bounded-contexts\/[^/]+\/context\.json deployableContributions\[\d+\]\.routes\[\d+\]$/.test(source),
      ),
    ).toBe(true);
    expect(inventory.members.filter((member) => member.kind === "EXPANDED")).toHaveLength(inventory.counts.EXPANDED);
    expect(inventory.counts.CONCRETE + inventory.counts.EXPANDED + inventory.counts.INDETERMINATE).toBe(
      inventory.members.length,
    );
    expect(new Set(inventory.members.map((member) => member.memberId)).size).toBe(inventory.members.length);
    expect(inventory.trackedFileRule).toBe(trackedFileRule);
  });

  it("uses the classifier default arm to fail closed for an unknown shape", () => {
    const manifestPath = "bounded-contexts/pricing/context.json";
    const original = readFileSync(path.join(repoRoot, manifestPath), "utf8");
    const manifest = JSON.parse(original);
    manifest.deployableContributions
      .find((contribution) => contribution.deployable === "public-web")
      .routes.push({
        routeId: "unknown-shape-control",
        routePath: "unknown/:shape",
        routeType: "route",
        fileExport: "./routes/unknown",
        sourceContext: "pricing",
      });
    replaceTracked(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const member = derivePublicWebRouteInventory({ rootDir: repoRoot }).members.find(
      (candidate) => candidate.memberId === "unknown-shape-control",
    );
    expect(member).toMatchObject({ kind: "INDETERMINATE" });
    expect(member.reason).toContain("no authoritative enumeration");
  });

  it("reads only authoritative context manifests and ignores unrelated tracked JSON", () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-public-route-inventory-"));
    temporaryRoots.push(rootDir);
    write(
      rootDir,
      "bounded-contexts/arbitrary-context/context.json",
      JSON.stringify({
        deployableContributions: [
          {
            deployable: "public-web",
            routes: [{ routeId: "manifest-control", routePath: "manifest-control" }],
          },
        ],
      }),
    );
    write(rootDir, "unrelated/malformed.json", "{ malformed");
    write(rootDir, "unrelated/array-fixture.json", "[]\n");
    write(rootDir, generatedHelpCatalogPath, "export const helpArticles = [];\n");
    execFileSync("git", ["init", "--quiet"], { cwd: rootDir });
    execFileSync("git", ["add", "."], { cwd: rootDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: rootDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: rootDir });
    execFileSync("git", ["commit", "--quiet", "-m", "tracked fixture"], { cwd: rootDir });
    expect(derivePublicWebRouteInventory({ rootDir }).members).toEqual(
      expect.arrayContaining([expect.objectContaining({ memberId: "manifest-control", kind: "CONCRETE" })]),
    );
  });

  it("picks up a mounted route and catalog article from the real tree without list edits", () => {
    const manifestPath = "bounded-contexts/pricing/context.json";
    const catalogPath = generatedHelpCatalogPath;
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, manifestPath), "utf8"));
    manifest.deployableContributions
      .find((contribution) => contribution.deployable === "public-web")
      .routes.push({
        routeId: "route-tree-control",
        routePath: "tree-control",
        routeType: "route",
        fileExport: "./routes/tree-control",
        sourceContext: "pricing",
      });
    replaceTracked(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const catalog = readFileSync(path.join(repoRoot, catalogPath), "utf8");
    replaceTracked(
      catalogPath,
      catalog.replace(
        "\n] as const",
        '\n  { slug: "tree-control", category: "testing", href: "/help/testing/tree-control" },\n] as const',
      ),
    );
    const members = derivePublicWebRouteInventory({ rootDir: repoRoot }).members;
    expect(members).toEqual(expect.arrayContaining([expect.objectContaining({ memberId: "route-tree-control" })]));
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memberId: "help-article:testing:tree-control", kind: "EXPANDED" }),
      ]),
    );
  });

  it.each([
    [
      "malformed manifest JSON",
      "bounded-contexts/pricing/context.json",
      "{ bad json",
      "bounded-contexts/pricing/context.json",
    ],
    [
      "array authoritative context manifest",
      "bounded-contexts/pricing/context.json",
      "[]",
      "bounded-contexts/pricing/context.json",
    ],
    [
      "malformed generated catalog",
      generatedHelpCatalogPath,
      "export const helpArticles = [",
      generatedHelpCatalogPath,
    ],
  ])("fails closed for %s", (_name, file, content, diagnostic) => {
    replaceTracked(file, content);
    expect(() => derivePublicWebRouteInventory({ rootDir: repoRoot })).toThrow(diagnostic);
  });

  it("fails closed when the generated catalog source is missing", () => {
    expect(() =>
      derivePublicWebRouteInventory({ rootDir: repoRoot, catalogPath: "missing-generated-catalog.ts" }),
    ).toThrow("missing-generated-catalog.ts");
  });
});
