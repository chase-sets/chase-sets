import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();
const radixPattern = /@radix-ui/;
const radixScanRoots = [
  "package-lock.json",
  "packages/design-system/package.json",
  "packages/design-system/src",
  "deployables/design-system-showcase/src"
];
const generatedPathFragments = [
  "/build/",
  "/.react-router/types/",
  "artifacts/structure-metrics.json"
];

function* sourceFiles(path) {
  if (!existsSync(path)) {
    return;
  }

  const entries = readdirSync(path, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(path, entry.name);

    if (entry.isDirectory()) {
      yield* sourceFiles(entryPath);
      continue;
    }

    if (/\.(json|ts|tsx|mts|mjs|js|jsx|css|md)$/.test(entry.name)) {
      yield entryPath;
    }
  }
}

function assertNoRadixReferences() {
  const offenders = [];

  for (const root of radixScanRoots) {
    const absoluteRoot = join(repoRoot, root);
    const files = existsSync(absoluteRoot) && readdirSync(repoRoot, { withFileTypes: true })
      ? root.endsWith(".json")
        ? [absoluteRoot]
        : [...sourceFiles(absoluteRoot)]
      : [];

    for (const file of files) {
      const contents = readFileSync(file, "utf8");
      if (radixPattern.test(contents)) {
        offenders.push(relative(repoRoot, file));
      }
    }
  }

  if (offenders.length > 0) {
    throw new Error(`Radix UI references remain in migrated design-system files:\n${offenders.join("\n")}`);
  }
}

function assertNoGeneratedArtifactChurn() {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  const offenders = status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/\\/g, "/"))
    .filter((path) => generatedPathFragments.some((fragment) => path.includes(fragment)));

  if (offenders.length > 0) {
    throw new Error(`Generated output is modified and should not be committed:\n${offenders.join("\n")}`);
  }
}

assertNoRadixReferences();
assertNoGeneratedArtifactChurn();

console.log("Design-system migration guard passed.");
