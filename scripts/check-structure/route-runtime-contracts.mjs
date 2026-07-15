import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const routeSourcePattern = /\.(?:ts|tsx)$/;
const testSourcePattern = /\.(?:test|spec)\.(?:ts|tsx)$/;
const forbiddenPatterns = [
  { kind: "direct-load-after-write", pattern: /\bloadAfterWrite\s*\(/ },
  { kind: "route-owned-intent-dispatch", pattern: /\b(?:const|let)\s+intent\s*=/ },
];

async function routeSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return routeSourceFiles(entryPath);
      return routeSourcePattern.test(entry.name) && !testSourcePattern.test(entry.name) ? [entryPath] : [];
    }),
  );
  return files.flat();
}

export async function collectRouteRuntimeContractViolations({ rootDir }) {
  const boundedContextsDir = path.join(rootDir, "bounded-contexts");
  const contexts = await readdir(boundedContextsDir, { withFileTypes: true });
  const routeDirectories = contexts
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(boundedContextsDir, entry.name, "routes"));
  const files = (
    await Promise.all(
      routeDirectories.map(async (directory) => {
        try {
          return await routeSourceFiles(directory);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
          throw error;
        }
      }),
    )
  ).flat();

  const violations = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const rule of forbiddenPatterns) {
      if (rule.pattern.test(source)) {
        violations.push({ file: path.relative(rootDir, file).replaceAll("\\", "/"), kind: rule.kind });
      }
    }
  }
  return violations;
}
