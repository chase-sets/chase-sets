import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildApiMountFileContent,
  deployableApiMountConfig,
  resolveDeployableApiMountPath,
} from "./deployable-api-mount-support.mjs";

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
        apiDeployables: manifest.apiDeployables ?? [],
      });
    } catch {
      // Ignore conceptual or incomplete contexts with no package/manifest pair.
    }
  }

  return manifests;
}

async function main() {
  const manifests = await loadContextManifests();

  for (const deployable of Object.keys(deployableApiMountConfig)) {
    const contexts = manifests
      .filter((manifest) => manifest.apiDeployables.includes(deployable))
      .sort((left, right) => left.contextName.localeCompare(right.contextName));

    await writeFile(
      resolveDeployableApiMountPath(repoRoot, deployable),
      buildApiMountFileContent(contexts),
      "utf8",
    );
  }

  console.log(
    `Generated deployable API mount inventories for ${Object.keys(deployableApiMountConfig).join(", ")}.`,
  );
}

void main().catch((error) => {
  console.error("API mount generation failed.", error);
  process.exitCode = 1;
});
