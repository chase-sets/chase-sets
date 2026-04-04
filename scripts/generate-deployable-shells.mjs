import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildShellFileContent,
  deployableShellConfig,
  resolveDeployableShellPath,
} from "./deployable-shell-support.mjs";

const repoRoot = process.cwd();
const boundedContextsRoot = path.join(repoRoot, "bounded-contexts");

async function loadContextManifests() {
  const entries = await readdir(boundedContextsRoot, { withFileTypes: true });
  const manifests = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const contextRoot = path.join(boundedContextsRoot, entry.name);
    const packagePath = path.join(contextRoot, "package.json");
    const manifestPath = path.join(contextRoot, "context.json");

    try {
      const [packageJson, manifest] = await Promise.all([
        readFile(packagePath, "utf8").then((content) => JSON.parse(content)),
        readFile(manifestPath, "utf8").then((content) => JSON.parse(content)),
      ]);

      manifests.push({
        contextName: manifest.contextName,
        packageName: packageJson.name,
        shellContributions: manifest.shellContributions ?? [],
      });
    } catch {
      // Ignore conceptual or incomplete contexts with no package/manifest pair.
    }
  }

  return manifests;
}

async function main() {
  const manifests = await loadContextManifests();

  for (const deployable of Object.keys(deployableShellConfig)) {
    const contributions = manifests
      .flatMap((manifest) =>
        manifest.shellContributions
          .filter((contribution) => contribution.deployable === deployable)
          .map((contribution) => ({
            ...contribution,
            sourceContext: manifest.contextName,
            packageName: manifest.packageName,
          })),
      )
      .sort((left, right) =>
        left.slot === right.slot
          ? left.order === right.order
            ? left.key.localeCompare(right.key)
            : left.order - right.order
          : left.slot.localeCompare(right.slot),
      );

    await writeFile(
      resolveDeployableShellPath(repoRoot, deployable),
      buildShellFileContent(deployable, contributions),
      "utf8",
    );
  }

  console.log(
    `Generated deployable shell inventories for ${Object.keys(deployableShellConfig).join(", ")}.`,
  );
}

void main().catch((error) => {
  console.error("Shell inventory generation failed.", error);
  process.exitCode = 1;
});
