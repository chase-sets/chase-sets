import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const productionSurfaceRoots = [
  "bounded-contexts/public-presence/features/policies/ui",
  "bounded-contexts/public-presence/routes/marketplace",
];

const policySurfaceShape =
  /\b(?:[A-Za-z][A-Za-z0-9]*PolicyArtifact|PolicyArtifactPage|PolicyArtifactRouteAdapter|TermsOfServicePage)\b|chase-sets:policy-publication-status|features\/policies\/ui\/[^"']+/;

const forbiddenPendingPostureShapes = [
  {
    name: "pending effective-date localization key",
    pattern: /publicPresence\.info\.[A-Za-z0-9-]+\.metadata\.effectivePending/g,
  },
  {
    name: "pending counsel-banner localization key",
    pattern: /publicPresence\.info\.[A-Za-z0-9-]+\.counselPending\.[A-Za-z0-9-]+/g,
  },
  {
    name: "pending effective-date literal",
    pattern: /Effective date pending counsel approval/g,
  },
];

function isProductionSource(relativePath) {
  return /\.(?:ts|tsx)$/.test(relativePath) && !/\.test\.(?:ts|tsx)$/.test(relativePath);
}

function isCanonicalPublicationPostureMapper(source) {
  return (
    source.includes("export function resolvePolicyArtifactPublicationPosture") &&
    source.includes("export function buildPolicyArtifactPageCopy") &&
    source.includes('publicationStatus !== "published"') &&
    source.includes("effectiveAt === null") &&
    source.includes("copy.effectivePendingText") &&
    source.includes("copy.formatEffectiveText")
  );
}

function pendingPostureMatches(source) {
  return forbiddenPendingPostureShapes.flatMap(({ name, pattern }) =>
    [...source.matchAll(pattern)].map((match) => ({ name, value: match[0], index: match.index ?? 0 })),
  );
}

/**
 * Shape-based guard for the complete artifact-backed policy production
 * surface. Adapter and route filenames are deliberately not enumerated: any
 * current or future source matching an artifact/page/meta/import shape is
 * enrolled automatically.
 */
export function findPublicPolicyPostureViolations(sourceRecords) {
  const guardedRecords = sourceRecords.filter(
    ({ relativePath, source }) =>
      isProductionSource(relativePath) && (policySurfaceShape.test(source) || pendingPostureMatches(source).length > 0),
  );
  const canonicalMappers = guardedRecords.filter(({ source }) => isCanonicalPublicationPostureMapper(source));
  const violations = [];

  if (canonicalMappers.length !== 1) {
    violations.push(
      `bounded-contexts/public-presence/features/policies/ui: expected exactly one canonical publication-state mapper/builder; found ${canonicalMappers.length}`,
    );
  }

  for (const record of guardedRecords) {
    if (canonicalMappers.includes(record)) {
      continue;
    }

    for (const match of pendingPostureMatches(record.source)) {
      const line = record.source.slice(0, match.index).split("\n").length;
      violations.push(
        `${record.relativePath}:${line}: ${match.name} '${match.value}' must be derived by the canonical publication-state mapper/builder`,
      );
    }
  }

  return {
    guardedFiles: guardedRecords.map(({ relativePath }) => relativePath).sort(),
    canonicalMapperFiles: canonicalMappers.map(({ relativePath }) => relativePath).sort(),
    violations,
  };
}

export async function readPublicPolicyPostureSources({ repoRoot }) {
  const sourceRecords = [];
  for (const relativeRoot of productionSurfaceRoots) {
    const absoluteRoot = path.resolve(repoRoot, relativeRoot);
    for (const absolutePath of await listFiles(absoluteRoot)) {
      const relativePath = path.relative(repoRoot, absolutePath).replaceAll("\\", "/");
      if (!isProductionSource(relativePath)) {
        continue;
      }
      sourceRecords.push({ relativePath, source: await readFile(absolutePath, "utf8") });
    }
  }
  return sourceRecords;
}

export async function validatePublicPolicyPosture({ repoRoot }) {
  return findPublicPolicyPostureViolations(await readPublicPolicyPostureSources({ repoRoot }));
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}
