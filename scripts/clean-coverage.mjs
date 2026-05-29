import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const coverageRoots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages"];

function removeCoverageDirectories(rootDir) {
  if (!existsSync(rootDir)) {
    return 0;
  }

  let removedCount = 0;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name === "node_modules") {
      continue;
    }

    if (entry.name === "coverage") {
      rmSync(fullPath, { recursive: true, force: true });
      removedCount += 1;
      continue;
    }

    removedCount += removeCoverageDirectories(fullPath);
  }

  return removedCount;
}

const removedCount = coverageRoots.reduce(
  (total, coverageRoot) => total + removeCoverageDirectories(path.join(repoRoot, coverageRoot)),
  0,
);
rmSync(path.join(repoRoot, "artifacts", "coverage"), { recursive: true, force: true });
console.log(`Removed ${removedCount} workspace coverage director${removedCount === 1 ? "y" : "ies"}.`);
