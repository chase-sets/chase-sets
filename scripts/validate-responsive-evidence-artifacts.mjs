import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateResponsiveEvidenceSourceManifest } from "./check-structure/responsive-evidence-guard.mjs";
import { collectFiles, defaultSkippedDirectories } from "./lib/files.mjs";

const sourceManifestPath = "infrastructure/playwright-evidence/responsive-evidence-manifest.json";
const defaultArtifactRoot = "artifacts/playwright/test-results";

export async function validateResponsiveEvidenceArtifacts({
  repoRoot,
  selectedGreps = [],
  expectedClaimIds = [],
  artifactRoot = defaultArtifactRoot,
}) {
  const violations = [];
  const source = JSON.parse(await readFile(path.join(repoRoot, sourceManifestPath), "utf8"));
  const sourceViolations = validateResponsiveEvidenceSourceManifest(source);
  if (sourceViolations.length > 0) {
    return { violations: sourceViolations.map((entry) => `${sourceManifestPath}: ${entry}`), manifests: [] };
  }

  const expected = source.claims.filter((claim) => {
    if (claim.kind !== "claim") return false;
    if (expectedClaimIds.length > 0) return expectedClaimIds.includes(claim.id);
    if (selectedGreps.length > 0) return selectedGreps.some((grep) => claim.testTitle.includes(grep));
    return true;
  });
  const outputRoot = path.resolve(repoRoot, artifactRoot);
  const runtimeFiles = (
    await collectFiles(outputRoot, {
      extensions: new Set([".json"]),
      skippedDirectories: defaultSkippedDirectories,
    })
  ).filter((file) => file.endsWith(".manifest.json"));
  const manifests = [];

  for (const runtimeFile of runtimeFiles) {
    const relativeFile = relative(repoRoot, runtimeFile);
    let runtime;
    try {
      runtime = JSON.parse(await readFile(runtimeFile, "utf8"));
    } catch (error) {
      violations.push(
        `${relativeFile}: runtime manifest is unreadable: ${error instanceof Error ? error.message : error}`,
      );
      continue;
    }
    const runtimeViolations = validateRuntimeShape(runtime);
    violations.push(...runtimeViolations.map((entry) => `${relativeFile}: ${entry}`));
    if (runtimeViolations.length > 0) continue;
    manifests.push({ file: runtimeFile, relativeFile, runtime });
  }

  const expectedIds = new Set(expected.map((claim) => claim.id));
  const seenClaimIds = new Set();
  const seenAssociations = new Set();
  const seenArtifactPaths = new Set();
  const configPath = path.join(repoRoot, "playwright.config.ts");
  const configSha256 = await fileSha256(configPath);

  for (const entry of manifests) {
    const { runtime, relativeFile } = entry;
    const claim = source.claims.find((candidate) => candidate.id === runtime.claimId);
    if (!claim || claim.kind !== "claim") {
      violations.push(
        `${relativeFile}: runtime manifest references unknown or non-success claim '${runtime.claimId}'.`,
      );
      continue;
    }
    if (!expectedIds.has(claim.id)) {
      violations.push(`${relativeFile}: stale or cross-run artifact for unselected claim '${claim.id}'.`);
    }
    if (seenClaimIds.has(claim.id)) {
      violations.push(`${relativeFile}: duplicate runtime manifest for claim '${claim.id}'.`);
    }
    seenClaimIds.add(claim.id);

    const association = JSON.stringify([
      runtime.route.observed,
      runtime.fixture.identity,
      runtime.viewport.width,
      runtime.viewport.height,
      runtime.target.identity,
    ]);
    if (seenAssociations.has(association)) {
      violations.push(`${relativeFile}: duplicate cross-claim route+fixture+viewport+target association.`);
    }
    seenAssociations.add(association);

    requireEqual(runtime.route.name, claim.route.name, relativeFile, "route.name", violations);
    requireEqual(runtime.route.observed, claim.route.path, relativeFile, "route.observed", violations);
    requireEqual(runtime.fixture.identity, claim.fixture.identity, relativeFile, "fixture.identity", violations);
    requireEqual(runtime.viewport.width, claim.viewport.width, relativeFile, "viewport.width", violations);
    requireEqual(runtime.viewport.height, claim.viewport.height, relativeFile, "viewport.height", violations);
    requireEqual(runtime.target.identity, claim.target.identity, relativeFile, "target.identity", violations);
    requireEqual(runtime.target.selector, claim.target.selector, relativeFile, "target.selector", violations);
    requireEqual(
      runtime.target.populatedSelector,
      claim.target.populatedSelector,
      relativeFile,
      "target.populatedSelector",
      violations,
    );
    requireEqual(runtime.assertions.length, claim.measurements.length, relativeFile, "assertions.length", violations);
    const assertionIds = new Set();
    for (const assertion of runtime.assertions) {
      if (assertionIds.has(assertion.identity)) {
        violations.push(`${relativeFile}: duplicate runtime assertion '${assertion.identity}'.`);
      }
      assertionIds.add(assertion.identity);
      const measurement = claim.measurements.find((candidate) => candidate.identity === assertion.identity);
      if (!measurement) {
        violations.push(`${relativeFile}: runtime assertion '${assertion.identity}' is not bound to the source claim.`);
        continue;
      }
      requireEqual(
        assertion.property,
        measurement.property,
        relativeFile,
        `${assertion.identity}.property`,
        violations,
      );
      requireEqual(
        JSON.stringify(assertion.expected),
        JSON.stringify(measurement.assertion),
        relativeFile,
        `${assertion.identity}.expected`,
        violations,
      );
    }

    const expectedManifestPath = relative(repoRoot, entry.file);
    requireEqual(
      runtime.artifacts.manifest.path,
      expectedManifestPath,
      relativeFile,
      "artifacts.manifest.path",
      violations,
    );
    requireEqual(
      path.basename(runtime.artifacts.screenshot.path),
      `${claim.artifact}.png`,
      relativeFile,
      "artifacts.screenshot.path",
      violations,
    );
    requireEqual(
      path.basename(runtime.artifacts.manifest.path),
      `${claim.artifact}.manifest.json`,
      relativeFile,
      "artifacts.manifest.path",
      violations,
    );
    for (const artifactPath of [runtime.artifacts.screenshot.path, runtime.artifacts.manifest.path]) {
      if (seenArtifactPaths.has(artifactPath)) {
        violations.push(`${relativeFile}: duplicate artifact association '${artifactPath}'.`);
      }
      seenArtifactPaths.add(artifactPath);
    }

    const screenshotPath = path.resolve(repoRoot, runtime.artifacts.screenshot.path);
    if (!isInside(repoRoot, screenshotPath) || !existsSync(screenshotPath)) {
      violations.push(
        `${relativeFile}: required screenshot payload '${runtime.artifacts.screenshot.path}' is missing.`,
      );
    } else {
      requireEqual(
        await fileSha256(screenshotPath),
        runtime.artifacts.screenshot.sha256,
        relativeFile,
        "artifacts.screenshot.sha256",
        violations,
      );
    }
    requireEqual(
      runtime.artifacts.sourceClaimSha256,
      sha256(JSON.stringify(claim)),
      relativeFile,
      "artifacts.sourceClaimSha256",
      violations,
    );
    requireEqual(
      runtime.artifacts.playwrightConfig.path,
      "playwright.config.ts",
      relativeFile,
      "config path",
      violations,
    );
    requireEqual(
      runtime.artifacts.playwrightConfig.sha256,
      configSha256,
      relativeFile,
      "artifacts.playwrightConfig.sha256",
      violations,
    );
  }

  for (const claim of expected) {
    if (!seenClaimIds.has(claim.id)) {
      violations.push(
        `${artifactRoot}: required responsive evidence payload for claim '${claim.id}' is missing after the complete run.`,
      );
    }
  }

  return { violations, manifests: manifests.map((entry) => entry.relativeFile), expectedClaimIds: [...expectedIds] };
}

function validateRuntimeShape(runtime) {
  const violations = [];
  if (
    !closed(runtime, [
      "contract",
      "schemaVersion",
      "claimId",
      "route",
      "fixture",
      "viewport",
      "target",
      "assertions",
      "artifacts",
    ])
  ) {
    violations.push("runtime manifest contains missing or unknown top-level fields.");
    return violations;
  }
  if (runtime.contract !== "responsive-evidence-runtime" || runtime.schemaVersion !== 2 || !text(runtime.claimId)) {
    violations.push("runtime manifest contract, schemaVersion, or claimId is invalid.");
  }
  const nested = [
    [runtime.route, ["name", "path", "observed"], "route"],
    [runtime.fixture, ["identity"], "fixture"],
    [runtime.viewport, ["width", "height"], "viewport"],
    [runtime.target, ["identity", "selector", "populatedSelector"], "target"],
    [runtime.artifacts, ["screenshot", "manifest", "sourceClaimSha256", "playwrightConfig"], "artifacts"],
    [runtime.artifacts?.screenshot, ["path", "sha256"], "artifacts.screenshot"],
    [runtime.artifacts?.manifest, ["path"], "artifacts.manifest"],
    [runtime.artifacts?.playwrightConfig, ["path", "sha256"], "artifacts.playwrightConfig"],
  ];
  for (const [value, keys, label] of nested) {
    if (!closed(value, keys)) violations.push(`${label} must use the closed nested schema.`);
  }
  if (!Array.isArray(runtime.assertions) || runtime.assertions.length === 0) {
    violations.push("assertions must be a nonempty array.");
  } else {
    for (const assertion of runtime.assertions) {
      if (!closed(assertion, ["identity", "property", "expected", "actual"])) {
        violations.push("every assertion must use the closed schema.");
      }
      if (
        !closedAllowed(assertion?.expected, ["equals", "minimum", "maximum", "tolerance"]) ||
        !["equals", "minimum", "maximum"].some((key) => key in assertion.expected)
      ) {
        violations.push("every assertion.expected object must use the closed schema.");
      }
      if (!text(assertion?.identity) || !text(assertion?.property)) {
        violations.push("every assertion requires identity and property.");
      }
      if (!["number", "string", "boolean"].includes(typeof assertion?.actual)) {
        violations.push("every assertion requires a scalar actual value.");
      }
    }
  }
  for (const value of [
    runtime.route?.name,
    runtime.route?.path,
    runtime.route?.observed,
    runtime.fixture?.identity,
    runtime.target?.identity,
    runtime.target?.selector,
    runtime.target?.populatedSelector,
    runtime.artifacts?.screenshot?.path,
    runtime.artifacts?.manifest?.path,
    runtime.artifacts?.screenshot?.sha256,
    runtime.artifacts?.sourceClaimSha256,
    runtime.artifacts?.playwrightConfig?.path,
    runtime.artifacts?.playwrightConfig?.sha256,
  ]) {
    if (!text(value)) violations.push("runtime manifest contains a missing required text value.");
  }
  return [...new Set(violations)];
}

function requireEqual(actual, expected, file, field, violations) {
  if (actual !== expected) {
    violations.push(
      `${file}: ${field} is stale or substituted (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}).`,
    );
  }
}

function closed(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && sameKeys(Object.keys(value), keys);
}

function closedAllowed(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function sameKeys(actual, expected) {
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function relative(repoRoot, file) {
  return path.relative(repoRoot, file).replaceAll("\\", "/");
}

function isInside(repoRoot, file) {
  const relativePath = path.relative(repoRoot, file);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

async function fileSha256(file) {
  return sha256(await readFile(file));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const selectedGreps = process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--grep="))
    .map((arg) => arg.slice(7));
  const expectedClaimIds = process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--claim="))
    .map((arg) => arg.slice(8));
  const artifactRoot =
    process.argv
      .slice(2)
      .find((arg) => arg.startsWith("--artifact-root="))
      ?.slice("--artifact-root=".length) ?? defaultArtifactRoot;
  const result = await validateResponsiveEvidenceArtifacts({ repoRoot, selectedGreps, expectedClaimIds, artifactRoot });
  if (result.violations.length > 0) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `responsive evidence artifacts: ${result.manifests.length}/${result.expectedClaimIds.length} required runtime manifests and payloads validated.`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
