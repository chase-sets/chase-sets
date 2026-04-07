import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildRuntimeFileContent,
  deployableRuntimeConfig,
  resolveDeployableRuntimePath,
} from "./deployable-runtime-support.mjs";

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
        apiDeployables: manifest.apiDeployables ?? [],
        runtimeDeployables: manifest.runtimeDeployables ?? manifest.apiDeployables ?? [],
        sourceRuntimeDeployables: manifest.sourceRuntimeDeployables ?? [],
        hostPorts: manifest.hostPorts ?? [],
      });
    } catch {
      // Ignore conceptual or incomplete contexts with no package/manifest pair.
    }
  }

  return manifests;
}

async function main() {
  const manifests = await loadContextManifests();

  for (const deployable of Object.keys(deployableRuntimeConfig)) {
    const contexts = manifests
      .filter(
        (manifest) =>
          manifest.runtimeDeployables.includes(deployable) ||
          manifest.sourceRuntimeDeployables.includes(deployable),
      )
      .map((manifest) => ({
        ...manifest,
        deployable,
        runtimeRole: manifest.runtimeDeployables.includes(deployable)
          ? "active"
          : "source-only",
      }))
      .sort((left, right) => left.contextName.localeCompare(right.contextName));

    await writeFile(
      resolveDeployableRuntimePath(repoRoot, deployable),
      buildRuntimeFileContent(contexts),
      "utf8",
    );
  }

  console.log(
    `Generated deployable runtime inventories for ${Object.keys(deployableRuntimeConfig).join(", ")}.`,
  );
}

void main().catch((error) => {
  console.error("Runtime generation failed.", error);
  process.exitCode = 1;
});
