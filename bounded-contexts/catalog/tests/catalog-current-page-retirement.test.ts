import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const retiredFileFragments = [
  ["integration", "management", "page"].join("-"),
  ["integration", "management", "profile", "previews"].join("-"),
  ["source", "observation", "list", "page"].join("-"),
];
const retiredFiles = retiredFileFragments.flatMap((fileName) =>
  [".tsx", ".test.tsx", ".test.ts"].map((extension) =>
    resolve(repoRoot, "bounded-contexts/catalog/features/source-observations/ui", `${fileName}${extension}`),
  ),
);
const retiredRouteModule = resolve(
  repoRoot,
  "bounded-contexts/catalog/routes/admin",
  ["source", "observations"].join("-") + ".tsx",
);

const retiredLiterals = [
  retiredFileFragments[0]!,
  retiredFileFragments[1]!,
  retiredFileFragments[2]!,
  ["Integration", "Management", "Page"].join(""),
  ["Source", "Observation", "List", "Page"].join(""),
  "catalog.features.sourceObservations.ui." + ["integration", "Management", "Page"].join(""),
  "catalog.features.sourceObservations.ui." + "integrations.",
  "catalog.features.sourceObservations.ui." + "list.",
  '"' + ["/catalog", "source-observations"].join("/") + '"',
  "current " + ["two", "page"].join("-"),
  "old-" + "page",
];

const scanRoots = [
  "bounded-contexts/catalog/docs",
  "bounded-contexts/catalog/features/source-observations/ui",
  "bounded-contexts/catalog/routes/admin",
  "bounded-contexts/catalog/tests",
  "contracts/localization/locales/en/catalog.ts",
  "contracts/localization/locales/en/catalog",
  "deployables/admin-web/e2e",
  "packages/design-system/DENSE_ADMIN_WORKBENCH.md",
  "packages/design-system/SECTION_NAVIGATION.md",
  "scripts/e2e-suites.mjs",
  "scripts/tcgplayer-integration-hardening.test.mjs",
];

describe("Catalog retired admin page guard", () => {
  it("removes retired page modules and the standalone list route contribution", () => {
    for (const file of [...retiredFiles, retiredRouteModule]) {
      expect(existsSync(file), file).toBe(false);
    }

    const context = JSON.parse(readFileSync(resolve(repoRoot, "bounded-contexts/catalog/context.json"), "utf8")) as {
      deployableContributions: Array<{ routes: Array<{ routeId: string; routePath: string; fileExport: string }> }>;
      shellContributions: Array<{ key: string; href: string }>;
    };
    const routes = context.deployableContributions.flatMap((contribution) => contribution.routes);
    const sourceObservationRouteId = ["source", "observations"].join("-");

    expect(routes.map((route) => route.routeId)).not.toContain(sourceObservationRouteId);
    expect(routes.map((route) => route.fileExport)).not.toContain("./routes/admin/" + sourceObservationRouteId);
    expect(context.shellContributions.map((entry) => entry.key)).not.toContain(sourceObservationRouteId);
    expect(context.shellContributions.map((entry) => entry.href)).not.toContain("/" + sourceObservationRouteId);
  });

  it("keeps rebuilt launch surfaces free of retired page anchors", () => {
    const offenders: string[] = [];

    for (const file of scanFiles(scanRoots)) {
      const source = readFileSync(file, "utf8");
      for (const literal of retiredLiterals) {
        if (source.includes(literal)) {
          offenders.push(`${relative(file)} contains ${JSON.stringify(literal)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

function scanFiles(roots: readonly string[]): string[] {
  return roots.flatMap((root) => {
    const absoluteRoot = resolve(repoRoot, root);
    if (!existsSync(absoluteRoot)) {
      return [];
    }
    const stats = statSync(absoluteRoot);
    if (stats.isFile()) {
      return [absoluteRoot];
    }

    return walk(absoluteRoot);
  });
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return walk(entryPath);
    }
    if (!/\.(?:ts|tsx|mjs|json|md)$/.test(entry.name)) {
      return [];
    }
    return [entryPath];
  });
}

function relative(file: string): string {
  return file.replace(repoRoot + "\\", "").replaceAll("\\", "/");
}
