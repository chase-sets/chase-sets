import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateResponsiveEvidenceSourceManifest } from "./check-structure/responsive-evidence-guard.mjs";
import { collectFiles, defaultSkippedDirectories } from "./lib/files.mjs";

const sourceManifestPath = "infrastructure/playwright-evidence/responsive-evidence-manifest.json";
const defaultArtifactRoot = "artifacts/playwright/test-results";
const defaultHostedArtifactRoot = "artifacts/hosted-responsive-evidence";
const shaPattern = /^[0-9a-f]{40}$/;

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

export async function prepareHostedResponsiveEvidenceArtifact({
  repoRoot,
  selectedGreps,
  producer,
  producerLogPath,
  gitIdentity,
  artifactRoot = defaultArtifactRoot,
  outputRoot = defaultHostedArtifactRoot,
}) {
  const destination = path.resolve(repoRoot, outputRoot);
  if (!isInside(repoRoot, destination)) {
    throw new Error(`Hosted responsive evidence output root must resolve inside the repository: ${outputRoot}`);
  }
  await rm(destination, { recursive: true, force: true });

  const violations = validateProducerIdentity(producer, gitIdentity);
  if (producer?.outcome !== "success") {
    violations.push(`responsive evidence producer outcome must be 'success', got '${producer?.outcome ?? "missing"}'.`);
  }
  if (violations.length > 0) {
    return { publish: false, violations, expectedClaimIds: [], files: [] };
  }

  const validation = await validateResponsiveEvidenceArtifacts({ repoRoot, selectedGreps, artifactRoot });
  if (validation.violations.length > 0) {
    return {
      publish: false,
      violations: validation.violations,
      expectedClaimIds: validation.expectedClaimIds,
      files: [],
    };
  }
  if (validation.expectedClaimIds.length === 0) {
    return { publish: false, violations: [], expectedClaimIds: [], files: [] };
  }

  const source = JSON.parse(await readFile(path.join(repoRoot, sourceManifestPath), "utf8"));
  const producerLog = stripAnsi(await readFile(producerLogPath, "utf8"));
  const manifestEntries = [];
  for (const runtimeRelativePath of validation.manifests) {
    const runtimeSource = path.join(repoRoot, runtimeRelativePath);
    const runtime = JSON.parse(await readFile(runtimeSource, "utf8"));
    const claim = source.claims.find((candidate) => candidate.id === runtime.claimId);
    const successLines = producerLog
      .split(/\r?\n/)
      .filter((line) => (line.includes("✓") || line.includes("±")) && line.includes(claim.testTitle));
    if (successLines.length !== 1) {
      violations.push(
        `${runtimeRelativePath}: expected exactly one successful producer line for '${claim.testTitle}', found ${successLines.length}.`,
      );
      continue;
    }

    const screenshotSource = path.resolve(repoRoot, runtime.artifacts.screenshot.path);
    const captureDirectory = path.join(destination, "captures", runtime.claimId);
    const runtimeDestination = path.join(captureDirectory, `${runtime.claimId}.manifest.json`);
    const screenshotDestination = path.join(captureDirectory, `${runtime.claimId}.png`);
    await mkdir(captureDirectory, { recursive: true });
    await copyFile(runtimeSource, runtimeDestination);
    await copyFile(screenshotSource, screenshotDestination);
    manifestEntries.push({
      claimId: runtime.claimId,
      testTitle: claim.testTitle,
      producerSuccessLine: successLines[0].trim(),
      sourceClaimSha256: runtime.artifacts.sourceClaimSha256,
      runtimeManifest: await fileRecord(destination, runtimeDestination),
      screenshot: await fileRecord(destination, screenshotDestination),
    });
  }

  if (violations.length > 0 || manifestEntries.length !== validation.expectedClaimIds.length) {
    await rm(destination, { recursive: true, force: true });
    return { publish: false, violations, expectedClaimIds: validation.expectedClaimIds, files: [] };
  }

  const styleEvidencePath = path.join(destination, "style-evidence.log");
  await writeFile(styleEvidencePath, extractBoundedStyleEvidence(producerLog), "utf8");
  const provenance = {
    schemaVersion: "hosted-responsive-evidence/v2",
    producer,
    git: gitIdentity,
    source: {
      manifest: { path: sourceManifestPath, sha256: await fileSha256(path.join(repoRoot, sourceManifestPath)) },
      playwrightConfig: {
        path: "playwright.config.ts",
        sha256: await fileSha256(path.join(repoRoot, "playwright.config.ts")),
      },
      producerLogSha256: await fileSha256(producerLogPath),
    },
    claims: manifestEntries.sort((left, right) => left.claimId.localeCompare(right.claimId, "en")),
    styleEvidence: await fileRecord(destination, styleEvidencePath),
  };
  const provenancePath = path.join(destination, "provenance.json");
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  const files = [
    provenancePath,
    styleEvidencePath,
    ...manifestEntries.flatMap((entry) => [entry.runtimeManifest.path, entry.screenshot.path]),
  ];
  return {
    publish: true,
    violations: [],
    expectedClaimIds: validation.expectedClaimIds,
    files: files.map((file) => (path.isAbsolute(file) ? relative(destination, file) : file)).sort(),
    outputRoot: relative(repoRoot, destination),
  };
}

function validateProducerIdentity(producer, gitIdentity) {
  const violations = [];
  for (const field of ["repository", "workflow", "workflowRef", "eventName", "job", "suiteBatch"]) {
    if (!text(producer?.[field])) violations.push(`responsive evidence producer.${field} is required.`);
  }
  if (!new Set(["pull_request", "merge_group"]).has(producer?.eventName)) {
    violations.push("responsive evidence producer.eventName must be pull_request or merge_group.");
  }
  for (const field of ["runId", "runAttempt"]) {
    if (!Number.isSafeInteger(producer?.[field]) || producer[field] < 1) {
      violations.push(`responsive evidence producer.${field} must be a positive integer.`);
    }
  }
  if (!Number.isSafeInteger(producer?.jobIndex) || producer.jobIndex < 0) {
    violations.push("responsive evidence producer.jobIndex must be a non-negative integer.");
  }
  for (const field of [
    "workflowSha",
    "checkoutSha",
    "checkoutTreeSha",
    "executedBaseSha",
    "executedBaseTreeSha",
    "sourceHeadSha",
    "sourceHeadTreeSha",
    "eventBaseSha",
  ]) {
    if (!shaPattern.test(producer?.[field] ?? "")) violations.push(`responsive evidence producer.${field} is invalid.`);
  }
  if (
    !Array.isArray(producer?.checkoutParentShas) ||
    producer.checkoutParentShas.some((value) => !shaPattern.test(value))
  ) {
    violations.push("responsive evidence producer.checkoutParentShas is invalid.");
  }
  for (const field of ["checkoutCommit", "checkoutTree", "executedBase", "executedBaseTree", "sourceHead"]) {
    if (!shaPattern.test(gitIdentity?.[field] ?? "")) violations.push(`responsive evidence git.${field} is invalid.`);
  }
  if (gitIdentity?.sourceHeadTree !== null && !shaPattern.test(gitIdentity?.sourceHeadTree ?? "")) {
    violations.push("responsive evidence git.sourceHeadTree is invalid.");
  }
  if (
    !Array.isArray(gitIdentity?.checkoutParents) ||
    gitIdentity.checkoutParents.some((value) => !shaPattern.test(value))
  ) {
    violations.push("responsive evidence git.checkoutParents is invalid.");
  }
  if (typeof gitIdentity?.shallow !== "boolean") {
    violations.push("responsive evidence git.shallow must be boolean.");
  }
  if (producer?.checkoutSha !== gitIdentity?.checkoutCommit) {
    violations.push("responsive evidence producer checkout SHA does not match the observed checkout commit.");
  }
  if (producer?.checkoutTreeSha !== gitIdentity?.checkoutTree) {
    violations.push("responsive evidence producer checkout tree does not match the observed checkout tree.");
  }
  if (JSON.stringify(producer?.checkoutParentShas) !== JSON.stringify(gitIdentity?.checkoutParents)) {
    violations.push(
      "responsive evidence producer checkout parents do not match the observed ordered checkout parents.",
    );
  }
  if (producer?.executedBaseSha !== gitIdentity?.executedBase) {
    violations.push("responsive evidence producer executed base does not match the observed first checkout parent.");
  }
  if (producer?.executedBaseTreeSha !== gitIdentity?.executedBaseTree) {
    violations.push("responsive evidence producer executed base tree does not match the observed first-parent tree.");
  }
  if (producer?.sourceHeadSha !== gitIdentity?.sourceHead) {
    violations.push("responsive evidence producer source head does not match the observed source head.");
  }
  if (producer?.sourceHeadTreeSha !== gitIdentity?.sourceHeadTree) {
    violations.push("responsive evidence producer source head tree does not match the observed source tree.");
  }
  if (producer?.eventName === "pull_request") {
    const parents = Array.isArray(gitIdentity?.checkoutParents) ? gitIdentity.checkoutParents : [];
    if (parents.length !== 2) {
      violations.push("pull-request evidence checkout must expose exactly two ordered parents.");
    }
    if (parents[0] !== producer.executedBaseSha) {
      violations.push("pull-request evidence executed base is not the first checkout parent.");
    }
    if (parents[1] !== producer.sourceHeadSha) {
      violations.push("pull-request evidence source head is not the second checkout parent.");
    }
    if (!shaPattern.test(gitIdentity?.sourceHeadTree ?? "")) {
      violations.push("pull-request evidence requires an observed source head tree.");
    }
  } else if (producer?.eventName === "merge_group") {
    const parents = Array.isArray(gitIdentity?.checkoutParents) ? gitIdentity.checkoutParents : [];
    if (parents.length !== 1 || parents[0] !== producer.executedBaseSha) {
      violations.push("merge-group evidence must expose exactly one executed-base parent.");
    }
    if (producer.checkoutSha !== producer.sourceHeadSha || producer.checkoutTreeSha !== producer.sourceHeadTreeSha) {
      violations.push("merge-group evidence source must be the exact executed checkout and tree.");
    }
    if (producer.eventBaseSha !== producer.executedBaseSha) {
      violations.push("merge-group evidence event base does not match the executed first parent.");
    }
  }
  return violations;
}

function extractBoundedStyleEvidence(log) {
  const scalarPrefixes = [
    "palette (",
    "populated CTA (",
    "admin workbench (",
    "brand foil stops (",
    "h1.font-display computed family:",
    ".font-heading computed family:",
  ];
  const retained = log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => scalarPrefixes.some((prefix) => line.startsWith(prefix)) || /^\d+ passed(?:\s|$)/.test(line));
  return retained.length === 0 ? "" : `${retained.join("\n")}\n`;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

async function fileRecord(root, file) {
  return { path: relative(root, file), bytes: (await readFile(file)).length, sha256: await fileSha256(file) };
}

export function observeGitIdentity(repoRoot, sourceHead) {
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    if (result.error || result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`);
    }
    return result.stdout.trim();
  };
  const sourceTree = spawnSync("git", ["show", "-s", "--format=%T", sourceHead], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const checkoutParents = git("show", "-s", "--diff-merges=off", "--format=%P", "HEAD").split(/\s+/).filter(Boolean);
  const executedBase = checkoutParents[0] ?? "";
  const executedBaseTree = spawnSync("git", ["show", "-s", "--format=%T", executedBase], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return {
    checkoutCommit: git("rev-parse", "HEAD"),
    checkoutTree: git("show", "-s", "--diff-merges=off", "--format=%T", "HEAD"),
    checkoutParents,
    executedBase,
    executedBaseTree: executedBaseTree.status === 0 ? executedBaseTree.stdout.trim() : null,
    shallow: git("rev-parse", "--is-shallow-repository") === "true",
    sourceHead,
    sourceHeadTree: sourceTree.status === 0 ? sourceTree.stdout.trim() : null,
  };
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
  const prepareHostedArtifact = process.argv.includes("--prepare-hosted-artifact");
  const suiteBatch = option(process.argv.slice(2), "--suite-batch");
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
  if (prepareHostedArtifact) {
    if (!suiteBatch) throw new Error("--suite-batch is required when preparing a hosted artifact.");
    const { e2eSuiteById } = await import("./e2e-suites.mjs");
    const suiteIds = suiteBatch
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const suites = suiteIds.map((suiteId) => {
      const suite = e2eSuiteById(suiteId);
      if (!suite || Array.isArray(suite.command)) throw new Error(`Unknown Playwright suite '${suiteId}'.`);
      return suite;
    });
    const sourceHeadSha = process.env.RESPONSIVE_EVIDENCE_SOURCE_HEAD_SHA ?? "";
    const producer = {
      outcome: process.env.RESPONSIVE_EVIDENCE_PRODUCER_OUTCOME ?? "",
      repository: process.env.GITHUB_REPOSITORY ?? "",
      workflow: process.env.GITHUB_WORKFLOW ?? "",
      workflowRef: process.env.GITHUB_WORKFLOW_REF ?? "",
      workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? "",
      eventName: process.env.GITHUB_EVENT_NAME ?? "",
      runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      job: process.env.GITHUB_JOB ?? "",
      jobIndex: Number(process.env.RESPONSIVE_EVIDENCE_JOB_INDEX),
      suiteBatch,
      checkoutSha: process.env.RESPONSIVE_EVIDENCE_CHECKOUT_SHA ?? "",
      checkoutTreeSha: process.env.RESPONSIVE_EVIDENCE_CHECKOUT_TREE_SHA ?? "",
      checkoutParentShas: (process.env.RESPONSIVE_EVIDENCE_CHECKOUT_PARENTS ?? "").split(/\s+/).filter(Boolean),
      executedBaseSha: process.env.RESPONSIVE_EVIDENCE_EXECUTED_BASE_SHA ?? "",
      executedBaseTreeSha: process.env.RESPONSIVE_EVIDENCE_EXECUTED_BASE_TREE_SHA ?? "",
      sourceHeadSha,
      sourceHeadTreeSha: process.env.RESPONSIVE_EVIDENCE_SOURCE_HEAD_TREE_SHA ?? "",
      eventBaseSha: process.env.RESPONSIVE_EVIDENCE_EVENT_BASE_SHA ?? "",
    };
    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot,
      selectedGreps: suites.map((suite) => suite.grep),
      producer,
      producerLogPath: process.env.RESPONSIVE_EVIDENCE_PRODUCER_LOG ?? "",
      gitIdentity: observeGitIdentity(repoRoot, sourceHeadSha),
      artifactRoot,
    });
    if (result.violations.length > 0) throw new Error(result.violations.join("\n"));
    if (process.env.GITHUB_OUTPUT) {
      await writeFile(
        process.env.GITHUB_OUTPUT,
        `publish=${result.publish}\nclaim-count=${result.expectedClaimIds.length}\n`,
        { encoding: "utf8", flag: "a" },
      );
    }
    console.log(
      result.publish
        ? `Hosted responsive evidence artifact: ${result.expectedClaimIds.length} complete registered claims staged.`
        : "Hosted responsive evidence artifact: no registered claims selected for this suite batch.",
    );
    return;
  }
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

function option(argv, name) {
  const prefix = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
