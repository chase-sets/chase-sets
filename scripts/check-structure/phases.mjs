import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const structureRulesDocPath = "docs/architecture/bounded-context-structure.md#rules-the-structure-gate-enforces";

export async function runManifestValidation(options) {
  const {
    contextManifests,
    validateContextManifest,
    validateDeployableRouteOwnership,
    validateDeployableApiMountOwnership,
    validateDeployableRuntimeOwnership,
    validateDeployableLifecycleOwnership,
    validateDeployableShellOwnership,
  } = options;

  for (const context of contextManifests.values()) {
    await validateContextManifest(context);
  }

  await validateDeployableRouteOwnership(contextManifests);
  await validateDeployableApiMountOwnership(contextManifests);
  await validateDeployableRuntimeOwnership(contextManifests);
  await validateDeployableLifecycleOwnership(contextManifests);
  await validateDeployableShellOwnership(contextManifests);
}

export async function runImportBoundaryValidation(options) {
  const { roots, walk, onDirectory, onFile } = options;

  for (const root of roots) {
    const { files, directories } = await walk(root);

    for (const directory of directories) {
      await onDirectory(directory);
    }

    for (const file of files) {
      await onFile(file);
    }
  }
}

export function writeStructureMetricsReport(options) {
  const { repoRoot, outputPath, metrics } = options;
  if (outputPath === "artifacts/structure-metrics.json" && process.env.STRUCTURE_METRICS_WRITE !== "1") {
    return;
  }

  const absoluteOutputPath = path.resolve(repoRoot, outputPath);

  mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
  writeFileSync(absoluteOutputPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}

export function reportStructureCheckResults(options) {
  const { violations, warnings } = options;

  if (violations.length > 0) {
    console.error("Structure check failed:\n");
    for (const violation of violations.sort()) {
      console.error(`- ${violation}`);
    }
    console.error(`\nSee ${structureRulesDocPath} for the enforced rules and fixes.`);
    return false;
  }

  if (warnings.length > 0) {
    console.warn("Structure check warnings:\n");
    for (const warning of warnings.sort()) {
      console.warn(`- ${warning}`);
    }
    console.warn("");
  }

  console.log("Structure check passed.");
  return true;
}
