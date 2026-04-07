import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildRoutesFileContent,
  buildWrapperContent,
  deployableRouteConfig,
  generatedComment,
  resolveDeployableRoutePaths,
} from "./deployable-route-support.mjs";

const repoRoot = process.cwd();
const boundedContextsRoot = path.join(repoRoot, "bounded-contexts");
const routeExportNames = [
  "loader",
  "clientLoader",
  "action",
  "clientAction",
  "meta",
  "links",
  "headers",
  "handle",
  "shouldRevalidate",
  "ErrorBoundary",
  "HydrateFallback",
];

async function resolveRouteSourcePath(contextRoot, fileExport) {
  const basePath = path.join(contextRoot, fileExport.replace(/^\.\//, ""));
  const candidates = [
    `${basePath}.tsx`,
    `${basePath}.ts`,
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.ts"),
  ];

  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next supported source file path.
    }
  }

  throw new Error(`Could not resolve route source for ${fileExport} under ${contextRoot}.`);
}

async function readRouteExportNames(contextRoot, fileExport) {
  const sourcePath = await resolveRouteSourcePath(contextRoot, fileExport);
  const content = await readFile(sourcePath, "utf8");

  return routeExportNames.filter((name) => {
    const functionPattern = new RegExp(
      `export\\s+(?:async\\s+)?function\\s+${name}\\b`,
      "m",
    );
    const variablePattern = new RegExp(
      `export\\s+(?:const|let|var)\\s+${name}\\b`,
      "m",
    );
    const reExportPattern = new RegExp(
      `export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`,
      "m",
    );

    return (
      functionPattern.test(content) ||
      variablePattern.test(content) ||
      reExportPattern.test(content)
    );
  });
}

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
        contextRoot,
        packageName: packageJson.name,
        deployableContributions: manifest.deployableContributions ?? [],
      });
    } catch {
      // Ignore conceptual or incomplete contexts with no package/manifest pair.
    }
  }

  return manifests;
}

async function syncWrapperFiles(deployable, routes) {
  const config = resolveDeployableRoutePaths(repoRoot, deployable);

  await mkdir(config.routesDir, { recursive: true });
  const expectedFiles = new Set();

  for (const route of routes) {
    const wrapperPath = path.join(config.routesDir, `${route.routeId}.tsx`);
    expectedFiles.add(path.basename(wrapperPath));
    const exportNames = await readRouteExportNames(route.contextRoot, route.fileExport);
    await writeFile(
      wrapperPath,
      buildWrapperContent(route.packageName, route, exportNames),
      "utf8",
    );
  }

  const existingEntries = await readdir(config.routesDir, { withFileTypes: true });
  for (const entry of existingEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".tsx")) {
      continue;
    }

    const filePath = path.join(config.routesDir, entry.name);
    const content = await readFile(filePath, "utf8");
    if (!content.startsWith(generatedComment)) {
      continue;
    }

    if (!expectedFiles.has(entry.name)) {
      await rm(filePath);
    }
  }

  await writeFile(config.routesFile, buildRoutesFileContent(routes), "utf8");
}

async function main() {
  const manifests = await loadContextManifests();
  const routesByDeployable = new Map();

  for (const manifest of manifests) {
    for (const contribution of manifest.deployableContributions) {
      const currentRoutes = routesByDeployable.get(contribution.deployable) ?? [];
      currentRoutes.push(
        ...contribution.routes.map((route) => ({
          ...route,
          placement: route.placement ?? "layout",
          packageName: manifest.packageName,
          contextRoot: manifest.contextRoot,
          sourceContext: manifest.contextName,
        })),
      );
      routesByDeployable.set(contribution.deployable, currentRoutes);
    }
  }

  for (const [deployable, routes] of routesByDeployable.entries()) {
    routes.sort((left, right) => left.routePath.localeCompare(right.routePath));
    await syncWrapperFiles(deployable, routes);
  }

  for (const deployable of Object.keys(deployableRouteConfig)) {
    const config = resolveDeployableRoutePaths(repoRoot, deployable);

    if (!routesByDeployable.has(deployable)) {
      await writeFile(
        config.routesFile,
        buildRoutesFileContent([]),
        "utf8",
      );
    }
  }

  console.log(
    `Generated deployable route adapters for ${[...routesByDeployable.keys()].sort().join(", ")}.`,
  );
}

void main().catch((error) => {
  console.error("Route generation failed.", error);
  process.exitCode = 1;
});
