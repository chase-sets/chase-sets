import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildLifecycleFileContent,
  deployableLifecycleConfig,
  resolveDeployableLifecyclePath,
} from "./deployable-lifecycle-support.mjs";

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
        deployable: null,
        packageName: packageJson.name,
        runtimeDeployables: manifest.runtimeDeployables ?? manifest.apiDeployables ?? [],
        seedRequirements: manifest.seedRequirements ?? [],
      });
    } catch {
      // Ignore conceptual or incomplete contexts with no package/manifest pair.
    }
  }

  return manifests;
}

async function main() {
  const manifests = await loadContextManifests();

  for (const deployable of Object.keys(deployableLifecycleConfig)) {
    const contexts = manifests
      .filter((manifest) => manifest.runtimeDeployables.includes(deployable))
      .map((manifest) => ({ ...manifest, deployable }))
      .sort((left, right) => left.contextName.localeCompare(right.contextName));

    await writeFile(
      resolveDeployableLifecyclePath(repoRoot, deployable),
      buildLifecycleFileContent(contexts),
      "utf8",
    );
  }

  console.log(
    `Generated deployable lifecycle inventories for ${Object.keys(deployableLifecycleConfig).join(", ")}.`,
  );
}

void main().catch((error) => {
  console.error("Lifecycle generation failed.", error);
  process.exitCode = 1;
});
