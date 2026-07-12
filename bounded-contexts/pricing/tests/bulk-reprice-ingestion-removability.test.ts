import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * m113 #4328's design constraint: bulk reprice ingestion is a removable
 * on-ramp -- "one directory + a documented list of mount lines" (see
 * docs/bulk-reprice-ingestion.md). This test is the
 * grep-proof: it scans every source file in the repo for a reference to the
 * feature directory and fails if anything outside the documented mount
 * points shows up.
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const featureDirName = "bulk-reprice-ingestion";
const scanRoots = ["bounded-contexts", "deployables", "infrastructure", "contracts", "packages"];
const sourceExtensions = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js"]);
const skippedDirectoryNames = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);

/** Files allowed to reference the feature -- the documented mount points from docs/bulk-reprice-ingestion.md. */
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
    "deployables/platform-worker/src/main.ts",
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
});

function statSyncSafe(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
