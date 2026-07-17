import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * m113 #4328's design constraint: bulk reprice ingestion is a removable
 * on-ramp -- one feature directory behind one product mount (see the
 * feature README). This test is the
 * grep-proof: it scans every source file in the repo for a reference to the
 * feature directory and fails if anything outside the documented mount
 * points shows up.
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const featureDirName = "bulk-reprice-ingestion";
const scanRoots = ["bounded-contexts", "deployables", "infrastructure", "contracts", "packages"];
const sourceExtensions = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js"]);
const skippedDirectoryNames = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);

/** Composition-only files allowed to reference the feature, documented in the feature README. */
const allowedReferencingFiles = new Set(
  [
    "bounded-contexts/pricing/api.ts",
    "bounded-contexts/pricing/support/runtime-support/services.ts",
    "bounded-contexts/pricing/support/runtime-support/schema.ts",
    "bounded-contexts/pricing/support/request-support/inventory-sku-gateway.ts",
    "bounded-contexts/pricing/support/request-support/api-client.ts",
    "bounded-contexts/pricing/routes/marketplace/bulk-reprice.tsx",
    "bounded-contexts/pricing/support/route-support/bulk-reprice/loader.ts",
    "bounded-contexts/pricing/support/route-support/bulk-reprice/action.ts",
  ].map((relativePath) => path.normalize(relativePath)),
);

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];

  function walk(directory: string) {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" }) as Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = String(entry.name);
      if (entry.isDirectory()) {
        if (skippedDirectoryNames.has(name) || name.startsWith(".")) {
          continue;
        }
        // The feature directory's own files may freely reference each other via relative imports.
        if (name === featureDirName) {
          continue;
        }
        walk(path.join(directory, name));
        continue;
      }
      if (sourceExtensions.has(path.extname(name))) {
        files.push(path.join(directory, name));
      }
    }
  }

  walk(root);
  return files;
}

function importedFeatureBindings(source: string): readonly string[] {
  const bindings: string[] = [];
  const importPattern = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["'][^"']*${featureDirName}[^"']*["']`, "g");
  for (const match of source.matchAll(importPattern)) {
    for (const specifier of (match[1] ?? "").split(",")) {
      const parts = specifier.trim().split(/\s+as\s+/);
      const localName = parts.at(-1)?.trim();
      if (localName) {
        bindings.push(localName);
      }
    }
  }
  return bindings;
}

function countFeatureRouteRegistrations(source: string): number {
  return importedFeatureBindings(source).reduce((count, binding) => {
    const routePattern = new RegExp(`\\.route\\s*\\(\\s*[^,]+,\\s*${binding}\\s*\\(`, "g");
    return count + [...source.matchAll(routePattern)].length;
  }, 0);
}

describe("bulk reprice ingestion removability", () => {
  it("is referenced only from the documented mount points", () => {
    const violations: string[] = [];

    for (const scanRoot of scanRoots) {
      const absoluteRoot = path.join(repoRoot, scanRoot);
      if (!statSyncSafe(absoluteRoot)) {
        continue;
      }

      for (const file of collectSourceFiles(absoluteRoot)) {
        const relativePath = path.relative(repoRoot, file);
        if (relativePath.endsWith(".test.ts") || relativePath.endsWith(".test.tsx")) {
          continue;
        }

        const contents = readFileSync(file, "utf8");
        if (!contents.includes(featureDirName)) {
          continue;
        }
        // Only import/re-export/dynamic-import statements count as a real
        // cross-module reference -- a code comment mentioning the feature
        // name (like this very check, or docs/bulk-reprice-ingestion.md's own file paths) is fine.
        const importPattern = new RegExp(
          `(?:from\\s+["'][^"']*${featureDirName}[^"']*["']|import\\(["'][^"']*${featureDirName}[^"']*["']\\))`,
        );
        if (!importPattern.test(contents)) {
          continue;
        }

        const normalized = path.normalize(relativePath);
        if (!allowedReferencingFiles.has(normalized)) {
          violations.push(normalized);
        }
      }
    }

    expect(violations, `Unexpected references to features/${featureDirName}/ outside documented mount points`).toEqual(
      [],
    );
  });

  it("has no consumers in another feature slice", () => {
    const externalFeatureConsumers = [...allowedReferencingFiles].filter((relativePath) =>
      relativePath.split(path.sep).includes("features"),
    );

    expect(externalFeatureConsumers).toEqual([]);
  });

  it("has exactly one feature-factory route registration, regardless of mount path", () => {
    const apiSource = readFileSync(path.join(repoRoot, "bounded-contexts/pricing/api.ts"), "utf8");
    const registrations = scanRoots.flatMap((scanRoot) =>
      collectSourceFiles(path.join(repoRoot, scanRoot)).map((file) => ({
        file,
        count: countFeatureRouteRegistrations(readFileSync(file, "utf8")),
      })),
    );
    const featureReadme = readFileSync(
      path.join(repoRoot, "bounded-contexts/pricing/features/bulk-reprice-ingestion/api/README.md"),
      "utf8",
    );

    expect(registrations.reduce((total, registration) => total + registration.count, 0)).toBe(1);
    expect(
      countFeatureRouteRegistrations(
        `${apiSource}\napp.route("/account/mass-price", createBulkRepriceIngestionRoutes(services.bulkRepriceIngestion));`,
      ),
    ).toBe(2);
    expect(featureReadme).toContain("pricing.bulk-reprice-ingestion.enabled");
    expect(featureReadme).toContain("No other feature slice may import this feature directory");
  });
});

function statSyncSafe(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
