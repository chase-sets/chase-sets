import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { collectFiles } from "./lib/files.mjs";
import { scanPlaywrightArtifactUploads } from "./playwright-artifact-upload-fence.mjs";
import {
  observeGitIdentity,
  prepareHostedResponsiveEvidenceArtifact,
  responsiveEvidenceGrepsForSuiteBatch,
  validateResponsiveEvidenceArtifacts,
} from "./validate-responsive-evidence-artifacts.mjs";

const roots = [];
const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const retryProbeConfig = path.join(repoRoot, "scripts/fixtures/responsive-evidence-retry/playwright.config.mjs");
const playwrightCli = createRequire(import.meta.url).resolve("@playwright/test/cli");
// Each retry probe runs a browserless Playwright child process with one retry.
const retryProbeTimeout = 120_000;

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("responsive evidence artifact validation", () => {
  it("accepts the registered mixed hosted batch and rejects unknown suite IDs", () => {
    expect(responsiveEvidenceGrepsForSuiteBatch("catalog_admin_modeling,tcgplayer_connector_extension")).toEqual([
      "@catalog-admin-modeling",
      "@tcgplayer-connector-extension-authority",
    ]);
    expect(() => responsiveEvidenceGrepsForSuiteBatch("catalog_admin_modeling,unknown")).toThrow(
      "Unknown E2E suite 'unknown'.",
    );
  });

  it("selects no responsive claims for a command-only batch", async () => {
    const root = await fixture();
    await rm(path.join(root, "artifacts/playwright/test-results"), { recursive: true, force: true });
    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: responsiveEvidenceGrepsForSuiteBatch("tcgplayer_connector_extension"),
      producer: { ...successfulProducer(), suiteBatch: "tcgplayer_connector_extension" },
      producerLogPath: await producerLog(root),
      gitIdentity: syntheticGitIdentity(),
    });
    expect(result).toMatchObject({ publish: false, violations: [], expectedClaimIds: [], files: [] });
  });

  it("retains required web evidence when a command suite shares the batch", async () => {
    const root = await fixture();
    await rm(path.join(root, screenshotPath));
    const suiteBatch = "marketplace_browse,tcgplayer_connector_extension";
    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: responsiveEvidenceGrepsForSuiteBatch(suiteBatch),
      producer: { ...successfulProducer(), suiteBatch },
      producerLogPath: await producerLog(root),
      gitIdentity: syntheticGitIdentity(),
    });
    expect(result.publish).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("required screenshot payload"));
  });

  it("accepts a complete successful payload with no trace declaration", async () => {
    const root = await fixture();

    const result = await validateResponsiveEvidenceArtifacts({ repoRoot: root, expectedClaimIds: ["claim"] });

    expect(result.violations).toEqual([]);
    expect(result.manifests).toHaveLength(1);
  });

  it("fails closed when later cleanup erases the successful payload", async () => {
    const root = await fixture();
    await rm(path.join(root, "artifacts/playwright/test-results"), { recursive: true, force: true });

    const result = await validateResponsiveEvidenceArtifacts({ repoRoot: root, expectedClaimIds: ["claim"] });

    expect(result.violations).toContainEqual(expect.stringContaining("required responsive evidence payload"));
  });

  it("rejects a top-level unknown runtime field", async () => {
    const root = await fixture();
    await mutateRuntime(root, (runtime) => {
      runtime.unknown = true;
    });

    const result = await validateResponsiveEvidenceArtifacts({ repoRoot: root, expectedClaimIds: ["claim"] });

    expect(result.violations).toContainEqual(expect.stringContaining("unknown top-level fields"));
    expect(result.violations).toContainEqual(expect.stringContaining("required responsive evidence payload"));
  });

  it("rejects a nested unknown field, including a fictitious zero-trace binding", async () => {
    const root = await fixture();
    await mutateRuntime(root, (runtime) => {
      runtime.artifacts.traceBinding = { path: "trace.zip" };
    });

    const result = await validateResponsiveEvidenceArtifacts({ repoRoot: root, expectedClaimIds: ["claim"] });

    expect(result.violations).toContainEqual(expect.stringContaining("artifacts must use the closed nested schema"));
  });

  it("rejects a manifest directory with a missing screenshot payload", async () => {
    const root = await fixture();
    await rm(path.join(root, screenshotPath));

    const result = await validateResponsiveEvidenceArtifacts({ repoRoot: root, expectedClaimIds: ["claim"] });

    expect(result.violations).toContainEqual(expect.stringContaining("required screenshot payload"));
  });

  it("rejects a stale source claim digest and association", async () => {
    const root = await fixture();
    const sourceFile = path.join(root, sourceManifestPath);
    const source = JSON.parse(await readFile(sourceFile, "utf8"));
    source.claims[0].route.name = "changed source route";
    await writeFile(sourceFile, JSON.stringify(source), "utf8");

    const result = await validateResponsiveEvidenceArtifacts({ repoRoot: root, expectedClaimIds: ["claim"] });

    expect(result.violations).toContainEqual(expect.stringContaining("route.name is stale or substituted"));
    expect(result.violations).toContainEqual(expect.stringContaining("sourceClaimSha256 is stale or substituted"));
  });

  it("rejects a substituted screenshot by digest", async () => {
    const root = await fixture();
    await writeFile(path.join(root, screenshotPath), "substituted screenshot", "utf8");

    const result = await validateResponsiveEvidenceArtifacts({ repoRoot: root, expectedClaimIds: ["claim"] });

    expect(result.violations).toContainEqual(expect.stringContaining("screenshot.sha256 is stale or substituted"));
  });

  it("rejects duplicate and cross-claim runtime artifact association", async () => {
    const root = await fixture();
    const first = JSON.parse(await readFile(path.join(root, runtimeManifestPath), "utf8"));
    const duplicatePath = "artifacts/playwright/test-results/other/claim.manifest.json";
    first.artifacts.manifest.path = duplicatePath;
    await write(root, duplicatePath, JSON.stringify(first));

    const result = await validateResponsiveEvidenceArtifacts({ repoRoot: root, expectedClaimIds: ["claim"] });

    expect(result.violations).toContainEqual(expect.stringContaining("duplicate runtime manifest"));
    expect(result.violations).toContainEqual(expect.stringContaining("duplicate cross-claim"));
  });

  it("stages only complete successful registered payloads behind the raw Playwright fence", async () => {
    const root = await fixture();
    const outputRoot = "artifacts/hosted-responsive-evidence";
    const originalManifest = await readFile(path.join(root, runtimeManifestPath), "utf8");
    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: responsiveEvidenceGrepsForSuiteBatch("marketplace_browse,tcgplayer_connector_extension"),
      producer: { ...successfulProducer(), suiteBatch: "marketplace_browse,tcgplayer_connector_extension" },
      producerLogPath: await producerLog(root),
      gitIdentity: syntheticGitIdentity(),
      outputRoot,
    });

    expect(result).toMatchObject({ publish: true, violations: [], expectedClaimIds: ["claim"] });
    expect(JSON.parse(await readFile(path.join(root, outputRoot, "provenance.json"), "utf8"))).toMatchObject({
      schemaVersion: "hosted-responsive-evidence/v2",
      producer: {
        outcome: "success",
        runId: 123,
        runAttempt: 2,
        jobIndex: 3,
        suiteBatch: "marketplace_browse,tcgplayer_connector_extension",
      },
      claims: [{ claimId: "claim" }],
    });
    expect(await readFile(path.join(root, outputRoot, "captures/claim/claim.png"), "utf8")).toBe("screenshot");
    expect(await readFile(path.join(root, outputRoot, "captures/claim/claim.manifest.json"), "utf8")).toBe(
      originalManifest,
    );
    expect(result.files).toEqual([
      "captures/claim/claim.manifest.json",
      "captures/claim/claim.png",
      "provenance.json",
      "style-evidence.log",
    ]);
    expect(await readFile(path.join(root, outputRoot, "style-evidence.log"), "utf8")).not.toContain("SYNTHETIC_SECRET");

    const workflow = await readFile(path.join(repoRoot, ".github/workflows/platform-pr.yml"), "utf8");
    const e2eJob = workflow.slice(workflow.indexOf("  e2e-tests:"), workflow.indexOf("\n  build:"));
    const fence = scanPlaywrightArtifactUploads({ root: repoRoot });

    expect(e2eJob).toContain('pnpm run test:e2e:suite "${{ matrix.suite_batch }}"');
    expect(e2eJob).toMatch(/uses: actions\/checkout@[^\n]+\r?\n\s+with:\r?\n\s+fetch-depth: 2\r?\n/);
    expect(e2eJob).toContain("id: responsive-evidence-checkout");
    expect(e2eJob).toContain("RESPONSIVE_EVIDENCE_EVENT_BASE_SHA:");
    expect(e2eJob).toContain("RESPONSIVE_EVIDENCE_EXECUTED_BASE_SHA:");
    expect(e2eJob).toContain("RESPONSIVE_EVIDENCE_SOURCE_HEAD_TREE_SHA:");
    expect(e2eJob).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(e2eJob).toContain(
      "name: responsive-evidence-${{ github.run_id }}-${{ github.run_attempt }}-${{ strategy.job-index }}",
    );
    expect(e2eJob).toContain("path: artifacts/hosted-responsive-evidence");
    expect(e2eJob).toContain("if-no-files-found: error");
    expect(e2eJob).toContain("if: steps.responsive-evidence.outputs.publish == 'true'");
    expect(e2eJob).not.toContain("artifacts/playwright/report");
    expect(e2eJob).not.toContain("artifacts/playwright/test-results");
    expect(fence.status).toBe("pass");
    expect(fence.findings).toEqual([]);
  });

  it("rejects canonical-artifact-directory-masks-missing-payload despite a successful producer", async () => {
    const root = await fixture();
    await write(root, "artifacts/hosted-responsive-evidence/captures/claim/claim.png", "decoy canonical payload");
    await rm(path.join(root, screenshotPath));

    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer: successfulProducer(),
      producerLogPath: await producerLog(root),
      gitIdentity: syntheticGitIdentity(),
    });

    expect(result.publish).toBe(false);
    expect(result.violations).toContainEqual(expect.stringContaining("required screenshot payload"));
    expect(existsSync(path.join(root, "artifacts/hosted-responsive-evidence"))).toBe(false);
  });

  it.each([
    ["failed producer", { outcome: "failure" }, syntheticGitIdentity(), "producer outcome"],
    ["missing run attempt", { runAttempt: 0 }, syntheticGitIdentity(), "producer.runAttempt"],
    ["wrong producer head", {}, { ...syntheticGitIdentity(), sourceHead: "4".repeat(40) }, "source head"],
  ])("publishes nothing for a %s", async (_name, producerPatch, gitIdentity, violation) => {
    const root = await fixture();

    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer: { ...successfulProducer(), ...producerPatch },
      producerLogPath: await producerLog(root),
      gitIdentity,
    });

    expect(result.publish).toBe(false);
    expect(result.violations.join("\n")).toContain(violation);
    expect(existsSync(path.join(root, "artifacts/hosted-responsive-evidence"))).toBe(false);
  });

  it("accepts the final successful producer line after an unchanged retry", async () => {
    const root = await fixture();
    const log = await producerLog(root);
    await writeFile(
      log,
      "× 1 [marketplace-chromium] › claim.spec.ts:1:1 › claim @marketplace-browse (1ms)\n" +
        "± 1 [marketplace-chromium] › claim.spec.ts:1:1 › claim @marketplace-browse (retry #1) (1ms)\n" +
        "1 flaky\n",
      "utf8",
    );

    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer: successfulProducer(),
      producerLogPath: log,
      gitIdentity: syntheticGitIdentity(),
    });

    expect(result).toMatchObject({ publish: true, violations: [] });
  });
});

describe("hosted evidence from synthetic Git merge checkouts", () => {
  it("accepts a synthetic pull-request checkout whose executed base advanced after the event snapshot", async () => {
    const { root, producer, executedBaseSha } = await mergeCheckout(2, { advanceBase: true });
    const gitIdentity = observeGitIdentity(root, producer.sourceHeadSha);
    expect(producer.eventBaseSha).not.toBe(executedBaseSha);
    expect(gitIdentity.checkoutParents).toEqual([executedBaseSha, producer.sourceHeadSha]);

    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer,
      producerLogPath: await producerLog(root),
      gitIdentity,
    });

    expect(result).toMatchObject({ publish: true, violations: [], expectedClaimIds: ["claim"] });
  });

  it.each([2, null])("accepts a synthetic unchanged-base pull-request checkout at depth %s", async (depth) => {
    const { root, producer, sourceHeadTree, checkoutTree } = await mergeCheckout(depth);
    const gitIdentity = observeGitIdentity(root, producer.sourceHeadSha);
    expect(producer.eventBaseSha).toBe(producer.executedBaseSha);
    expect(gitIdentity).toEqual({
      checkoutCommit: producer.checkoutSha,
      checkoutTree,
      checkoutParents: [producer.executedBaseSha, producer.sourceHeadSha],
      executedBase: producer.executedBaseSha,
      executedBaseTree: producer.executedBaseTreeSha,
      shallow: depth !== null,
      sourceHead: producer.sourceHeadSha,
      sourceHeadTree,
    });
    expect(sourceHeadTree).toMatch(/^[0-9a-f]{40}$/);
    expect(sourceHeadTree).not.toBe(checkoutTree);

    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer,
      producerLogPath: await producerLog(root),
      gitIdentity,
    });

    expect(result).toMatchObject({ publish: true, violations: [], expectedClaimIds: ["claim"] });
    const provenance = JSON.parse(
      await readFile(path.join(root, "artifacts/hosted-responsive-evidence/provenance.json"), "utf8"),
    );
    expect(provenance.producer).toEqual(producer);
    expect(provenance.git).toEqual(gitIdentity);
  });

  it("rejects a synthetic depth-1 checkout with hidden source and executed-base identities", async () => {
    const { root, producer } = await mergeCheckout(1);
    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer,
      producerLogPath: await producerLog(root),
      gitIdentity: observeGitIdentity(root, producer.sourceHeadSha),
    });

    expect(result).toMatchObject({ publish: false, files: [] });
    expect(result.violations).toContain("pull-request evidence checkout must expose exactly two ordered parents.");
    expect(result.violations).toContain("pull-request evidence requires an observed source head tree.");
    expect(existsSync(path.join(root, "artifacts/hosted-responsive-evidence"))).toBe(false);
  });

  it.each([
    ["sourceHeadSha", "pull-request evidence source head is not the second checkout parent."],
    ["executedBaseSha", "pull-request evidence executed base is not the first checkout parent."],
  ])("rejects a forged %s relationship", async (field, violation) => {
    const { root, producer } = await mergeCheckout(2);
    producer[field] = producer.checkoutSha;
    const gitIdentity = observeGitIdentity(root, producer.sourceHeadSha);
    expect(gitIdentity.checkoutParents).toHaveLength(2);
    expect(gitIdentity.checkoutParents).not.toContain(producer[field]);
    expect(gitIdentity.sourceHeadTree).toMatch(/^[0-9a-f]{40}$/);

    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer,
      producerLogPath: await producerLog(root),
      gitIdentity,
    });

    expect(result).toMatchObject({ publish: false, files: [] });
    expect(result.violations).toContain(violation);
    expect(existsSync(path.join(root, "artifacts/hosted-responsive-evidence"))).toBe(false);
  });

  it("rejects a synthetic unrelated executed base", async () => {
    const { root, producer } = await mergeCheckout(2);
    producer.executedBaseSha = "f".repeat(40);

    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer,
      producerLogPath: await producerLog(root),
      gitIdentity: observeGitIdentity(root, producer.sourceHeadSha),
    });

    expect(result).toMatchObject({ publish: false, files: [] });
    expect(result.violations).toContain(
      "responsive evidence producer executed base does not match the observed first checkout parent.",
    );
  });

  it("rejects observed parents when the source head tree cannot be resolved", async () => {
    const { root, producer } = await mergeCheckout(null);
    // The local deep clone owns independent loose objects; remove only its source commit.
    // HEAD still exposes both real parent IDs, but Git can no longer resolve the source tree.
    await rm(path.join(root, ".git/objects", producer.sourceHeadSha.slice(0, 2), producer.sourceHeadSha.slice(2)));
    const gitIdentity = observeGitIdentity(root, producer.sourceHeadSha);
    expect(gitIdentity.checkoutParents).toEqual([producer.executedBaseSha, producer.sourceHeadSha]);
    expect(gitIdentity.sourceHeadTree).toBeNull();

    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer,
      producerLogPath: await producerLog(root),
      gitIdentity,
    });

    expect(result).toMatchObject({ publish: false, files: [] });
    expect(result.violations).toContain("pull-request evidence requires an observed source head tree.");
    expect(existsSync(path.join(root, "artifacts/hosted-responsive-evidence"))).toBe(false);
  });

  it("accepts a synthetic merge-group checkout bound to its exact checkout tree and event base", async () => {
    const { root, producer } = await mergeGroupCheckout(2);
    const gitIdentity = observeGitIdentity(root, producer.sourceHeadSha);
    expect(gitIdentity.checkoutParents).toEqual([producer.eventBaseSha]);

    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer,
      producerLogPath: await producerLog(root),
      gitIdentity,
    });

    expect(result).toMatchObject({ publish: true, violations: [], expectedClaimIds: ["claim"] });
  });

  it.each([
    ["wrong source", { sourceHeadSha: "f".repeat(40), sourceHeadTreeSha: "e".repeat(40) }],
    ["wrong event base", { eventBaseSha: "f".repeat(40) }],
  ])("rejects a synthetic merge-group %s", async (_name, patch) => {
    const { root, producer: validProducer } = await mergeGroupCheckout(2);
    const producer = { ...validProducer, ...patch };
    const observedSource = _name === "wrong source" ? validProducer.checkoutSha : producer.sourceHeadSha;
    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer,
      producerLogPath: await producerLog(root),
      gitIdentity: observeGitIdentity(root, observedSource),
    });

    expect(result).toMatchObject({ publish: false, files: [] });
    expect(result.violations).toContain(
      _name === "wrong source"
        ? "merge-group evidence source must be the exact executed checkout and tree."
        : "merge-group evidence event base does not match the executed first parent.",
    );
  });

  it.each([
    ["checkoutSha"],
    ["checkoutTreeSha"],
    ["checkoutParentShas"],
    ["executedBaseSha"],
    ["executedBaseTreeSha"],
    ["sourceHeadTreeSha"],
  ])("rejects forged synthetic checkout identity field %s", async (field) => {
    const { root, producer } = await mergeCheckout(2);
    producer[field] = field === "checkoutParentShas" ? ["f".repeat(40)] : "f".repeat(40);
    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer,
      producerLogPath: await producerLog(root),
      gitIdentity: observeGitIdentity(root, producer.sourceHeadSha),
    });

    expect(result).toMatchObject({ publish: false, files: [] });
    expect(result.violations.length).toBeGreaterThan(0);
    expect(existsSync(path.join(root, "artifacts/hosted-responsive-evidence"))).toBe(false);
  });

  it.each([
    ["checkoutSha"],
    ["checkoutTreeSha"],
    ["checkoutParentShas"],
    ["executedBaseSha"],
    ["executedBaseTreeSha"],
    ["sourceHeadSha"],
    ["sourceHeadTreeSha"],
    ["eventBaseSha"],
  ])("rejects missing synthetic producer identity field %s", async (field) => {
    const { root, producer } = await mergeCheckout(2);
    delete producer[field];
    const observedSource = field === "sourceHeadSha" ? "f".repeat(40) : producer.sourceHeadSha;

    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer,
      producerLogPath: await producerLog(root),
      gitIdentity: observeGitIdentity(root, observedSource),
    });

    expect(result).toMatchObject({ publish: false, files: [] });
    expect(result.violations).toContain(`responsive evidence producer.${field} is invalid.`);
  });

  it.each([
    ["checkoutTreeSha", "not-a-sha"],
    ["checkoutParentShas", "not-an-array"],
  ])("rejects malformed synthetic producer identity field %s", async (field, value) => {
    const { root, producer } = await mergeCheckout(2);
    producer[field] = value;
    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer,
      producerLogPath: await producerLog(root),
      gitIdentity: observeGitIdentity(root, producer.sourceHeadSha),
    });

    expect(result).toMatchObject({ publish: false, files: [] });
    expect(result.violations).toContain(`responsive evidence producer.${field} is invalid.`);
  });
});

describe("responsive evidence from a retried Playwright capture", () => {
  const probeRoots = [];
  let retried;

  beforeAll(async () => {
    retried = await retryProbe("retried-pass", probeRoots);
  }, retryProbeTimeout);
  afterAll(async () => Promise.all(probeRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("keeps a manifest from each attempt when Playwright retries a capture test", () => {
    console.info(`retried-capture probe output tree:\n${retried.files.join("\n")}`);
    expect(retried.status, retried.output).toBe(0);
    expect(retried.output).toMatch(/^\s*1 flaky$/m);
    expect(retried.captures.map((capture) => capture.attempt)).toEqual([0, 1]);
    const [first, retry] = retried.captures;
    expect(retry.directory).toBe(`${first.directory}-retry1`);
  });

  it("accepts only the final attempt's manifest and publishes only its payload", async () => {
    expect(
      retried.captures.map((capture) => capture.attempt),
      retried.output,
    ).toEqual([0, 1]);
    const [earlier, final] = retried.captures;
    const validation = await validateResponsiveEvidenceArtifacts({
      repoRoot: retried.root,
      expectedClaimIds: [retried.claim.id],
    });
    expect(validation).toMatchObject({ violations: [], manifests: [final.path], ignoredManifests: [earlier.path] });

    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: retried.root,
      selectedGreps: [retried.claim.testTitle],
      producer: { ...successfulProducer(), outcome: retried.status === 0 ? "success" : "failure" },
      producerLogPath: retried.log,
      gitIdentity: syntheticGitIdentity(),
    });
    const capture = `captures/${retried.claim.id}/${retried.claim.id}`;
    const published = path.join(retried.root, "artifacts/hosted-responsive-evidence");
    expect(result).toMatchObject({ publish: true, violations: [], expectedClaimIds: [retried.claim.id] });
    expect(result.files).toEqual([
      `${capture}.manifest.json`,
      `${capture}.png`,
      "provenance.json",
      "style-evidence.log",
    ]);
    expect(await readFile(path.join(published, `${capture}.manifest.json`), "utf8")).toBe(
      await readFile(path.join(retried.root, final.path), "utf8"),
    );
    expect(await readFile(path.join(published, `${capture}.png`), "utf8")).toBe(
      "responsive evidence retry probe attempt 1\n",
    );
    const provenance = JSON.parse(await readFile(path.join(published, "provenance.json"), "utf8"));
    expect(provenance.claims[0].producerSuccessLine).toContain("(retry #1)");
  });
});

describe("retried-capture fail-closed controls", () => {
  it(
    "rejects one claim captured by two tests when only one of them retried",
    async () => {
      const probe = await retryProbe("two-tests");
      expect(probe.status, probe.output).toBe(0);
      expect(probe.captures.map((capture) => capture.attempt)).toEqual([0, 0, 1]);

      const result = await validateResponsiveEvidenceArtifacts({
        repoRoot: probe.root,
        expectedClaimIds: [probe.claim.id],
      });

      expect(result.violations).toContainEqual(
        expect.stringContaining(`duplicate runtime manifest for claim '${probe.claim.id}'`),
      );
      expect(result.manifests).toHaveLength(2);
      expect(result.manifests).toContain(probe.captures[2].path);
      expect(result.ignoredManifests).toHaveLength(1);
    },
    retryProbeTimeout,
  );

  it(
    "rejects two captures of one claim in one attempt",
    async () => {
      const probe = await retryProbe("two-captures-one-attempt");
      expect(probe.status, probe.output).toBe(0);
      expect(probe.captures.map((capture) => capture.attempt)).toEqual([0, 0]);
      expect(probe.captures[0].directory).toBe(probe.captures[1].directory);

      const result = await validateResponsiveEvidenceArtifacts({
        repoRoot: probe.root,
        expectedClaimIds: [probe.claim.id],
      });

      expect(result.violations).toContainEqual(
        expect.stringContaining(`duplicate runtime manifest for claim '${probe.claim.id}'`),
      );
      expect(result.ignoredManifests).toEqual([]);
    },
    retryProbeTimeout,
  );

  it(
    "publishes nothing when the retried capture's final attempt failed",
    async () => {
      const probe = await retryProbe("failed-final-attempt");
      expect(probe.status, probe.output).toBe(1);
      expect(probe.captures.map((capture) => capture.attempt)).toEqual([0, 1]);
      const hostedArtifact = {
        repoRoot: probe.root,
        selectedGreps: [probe.claim.testTitle],
        producerLogPath: probe.log,
        gitIdentity: syntheticGitIdentity(),
      };

      const failed = await prepareHostedResponsiveEvidenceArtifact({
        ...hostedArtifact,
        producer: { ...successfulProducer(), outcome: "failure" },
      });
      // A misreported outcome still cannot publish: no producer line reports a passing attempt.
      const misreported = await prepareHostedResponsiveEvidenceArtifact({
        ...hostedArtifact,
        producer: successfulProducer(),
      });

      expect(failed).toMatchObject({ publish: false, files: [] });
      expect(failed.violations).toContain("responsive evidence producer outcome must be 'success', got 'failure'.");
      expect(misreported).toMatchObject({ publish: false, files: [] });
      expect(misreported.violations).toContainEqual(
        expect.stringContaining(
          `expected exactly one successful producer line for '${probe.claim.testTitle}', found 0`,
        ),
      );
      expect(existsSync(path.join(probe.root, "artifacts/hosted-responsive-evidence"))).toBe(false);
    },
    retryProbeTimeout,
  );

  it(
    "ignores an earlier attempt's capture when the passing retry captured nothing",
    async () => {
      const probe = await retryProbe("earlier-attempt-only");
      expect(probe.status, probe.output).toBe(0);
      expect(probe.captures.map((capture) => capture.attempt)).toEqual([0]);
      expect(probe.directories).toHaveLength(2);

      const result = await validateResponsiveEvidenceArtifacts({
        repoRoot: probe.root,
        expectedClaimIds: [probe.claim.id],
      });

      expect(result.manifests).toEqual([]);
      expect(result.ignoredManifests).toEqual([probe.captures[0].path]);
      expect(result.violations).toContainEqual(
        expect.stringContaining(`required responsive evidence payload for claim '${probe.claim.id}' is missing`),
      );
    },
    retryProbeTimeout,
  );
});

async function mergeCheckout(depth, { advanceBase = false } = {}) {
  const source = await fixture();
  const git = (...args) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Synthetic evidence test");
  git("config", "user.email", "synthetic@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-m", "Synthetic initial payload");
  git("checkout", "-b", "source");
  await write(source, "source.txt", "Synthetic source change\n");
  git("add", ".");
  git("commit", "-m", "Synthetic source head");
  const sourceHeadSha = git("rev-parse", "HEAD");
  const sourceHeadTree = git("show", "-s", "--format=%T", "HEAD");
  git("checkout", "main");
  await write(source, "base.txt", "Synthetic base change\n");
  git("add", ".");
  git("commit", "-m", "Synthetic base head");
  const eventBaseSha = git("rev-parse", "HEAD");
  if (advanceBase) {
    await write(source, "advanced-base.txt", "Synthetic base advance after event snapshot\n");
    git("add", ".");
    git("commit", "-m", "Synthetic executed base advance");
  }
  const executedBaseSha = git("rev-parse", "HEAD");
  const executedBaseTreeSha = git("show", "-s", "--format=%T", "HEAD");
  git("merge", "--no-ff", "source", "-m", "Synthetic pull-request merge");
  const checkoutSha = git("rev-parse", "HEAD");
  const checkoutTree = git("show", "-s", "--format=%T", "HEAD");
  const root = await mkdtemp(path.join(os.tmpdir(), "responsive-merge-checkout-"));
  roots.push(root);
  // file:// forces the upload-pack shallow boundary rather than a local object copy.
  git(
    "clone",
    "--config=core.autocrlf=false",
    ...(depth === null ? ["--no-hardlinks", source] : [`--depth=${depth}`, pathToFileURL(source).href]),
    root,
  );
  return {
    root,
    producer: {
      ...successfulProducer(),
      checkoutSha,
      checkoutTreeSha: checkoutTree,
      checkoutParentShas: [executedBaseSha, sourceHeadSha],
      executedBaseSha,
      executedBaseTreeSha,
      sourceHeadSha,
      sourceHeadTreeSha: sourceHeadTree,
      eventBaseSha,
    },
    executedBaseSha,
    sourceHeadTree,
    checkoutTree,
  };
}

async function mergeGroupCheckout(depth) {
  const source = await fixture();
  const git = (...args) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Synthetic evidence test");
  git("config", "user.email", "synthetic@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-m", "Synthetic merge-group base");
  const eventBaseSha = git("rev-parse", "HEAD");
  const executedBaseTreeSha = git("show", "-s", "--format=%T", "HEAD");
  await write(source, "merge-group.txt", "Synthetic merge-group candidate\n");
  git("add", ".");
  git("commit", "-m", "Synthetic merge-group candidate");
  const checkoutSha = git("rev-parse", "HEAD");
  const checkoutTreeSha = git("show", "-s", "--format=%T", "HEAD");
  const root = await mkdtemp(path.join(os.tmpdir(), "responsive-merge-group-checkout-"));
  roots.push(root);
  git("clone", "--config=core.autocrlf=false", `--depth=${depth}`, pathToFileURL(source).href, root);
  return {
    root,
    producer: {
      ...successfulProducer(),
      eventName: "merge_group",
      checkoutSha,
      checkoutTreeSha,
      checkoutParentShas: [eventBaseSha],
      executedBaseSha: eventBaseSha,
      executedBaseTreeSha,
      sourceHeadSha: checkoutSha,
      sourceHeadTreeSha: checkoutTreeSha,
      eventBaseSha,
    },
  };
}

// Runs one scenario of scripts/fixtures/responsive-evidence-retry under the
// installed Playwright with --retries=1, inside a temporary repository root, and
// returns the real output tree. Each capture's screenshot names its attempt.
async function retryProbe(scenario, cleanup = roots) {
  const root = await mkdtemp(path.join(os.tmpdir(), "responsive-retry-probe-"));
  cleanup.push(root);
  const sourceText = await readFile(path.join(repoRoot, sourceManifestPath), "utf8");
  const claims = JSON.parse(sourceText).claims.filter((claim) => claim.kind === "claim");
  // A test-title grep for this claim selects no other claim.
  const claim = claims.find(
    (candidate) => claims.filter((other) => other.testTitle.includes(candidate.testTitle)).length === 1,
  );
  await write(root, sourceManifestPath, sourceText);
  await write(root, "playwright.config.ts", "export default {};\n");
  const outputRoot = path.join(root, "artifacts/playwright/test-results");
  const shallowBefore = await checkoutShallowState();
  const run = await runNode([playwrightCli, "test", "--config", retryProbeConfig, "--retries=1"], {
    ...process.env,
    PWTEST_CACHE_DIR: path.join(root, "playwright-transform-cache"),
    // Hosted producers run on Linux, where the list reporter always prints ✓ and ✘;
    // on Windows it prints them only inside Windows Terminal.
    WT_SESSION: process.env.WT_SESSION ?? "responsive-evidence-retry-probe",
    RESPONSIVE_EVIDENCE_RETRY_PROBE_ROOT: root,
    RESPONSIVE_EVIDENCE_RETRY_PROBE_OUTPUT_DIR: outputRoot,
    RESPONSIVE_EVIDENCE_RETRY_PROBE_CLAIM: claim.id,
    RESPONSIVE_EVIDENCE_RETRY_PROBE_SCENARIO: scenario,
  });
  expect(await checkoutShallowState(), "the retry probe changed this checkout's shallow state").toEqual(shallowBefore);
  const log = path.join(root, "producer.log");
  await writeFile(log, run.stdout, "utf8");

  const files = (await collectFiles(outputRoot))
    .map((file) => path.relative(outputRoot, file).replaceAll("\\", "/"))
    .sort();
  const captures = [];
  for (const file of files.filter((candidate) => candidate.endsWith(".manifest.json"))) {
    const runtime = JSON.parse(await readFile(path.join(outputRoot, file), "utf8"));
    const screenshot = await readFile(path.join(root, runtime.artifacts.screenshot.path), "utf8");
    captures.push({
      path: `artifacts/playwright/test-results/${file}`,
      directory: file.split("/")[0],
      attempt: Number(/attempt (\d+)/.exec(screenshot)?.[1]),
    });
  }
  captures.sort((left, right) => left.attempt - right.attempt || left.path.localeCompare(right.path, "en"));
  return {
    root,
    claim,
    status: run.status,
    output: `${run.stdout}${run.stderr}`.replace(/\u001b\[[0-9;]*m/g, ""),
    log,
    files,
    directories: [...new Set(files.filter((file) => file.includes("/")).map((file) => file.split("/")[0]))],
    captures,
  };
}

// Playwright runs its git-info plugin in the checkout holding the probe config;
// a fetch there can move the shallow boundary other script tests read.
async function checkoutShallowState() {
  const git = (...args) =>
    execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const shallowFile = path.resolve(repoRoot, git("rev-parse", "--git-path", "shallow"));
  return {
    shallow: git("rev-parse", "--is-shallow-repository"),
    boundary: existsSync(shallowFile) ? await readFile(shallowFile, "utf8") : null,
  };
}

// The checkout cwd lets a host heavy-admission guard attribute the child to this
// worktree; --config alone locates the fixture.
function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const sourceManifestPath = "infrastructure/playwright-evidence/responsive-evidence-manifest.json";
const runtimeManifestPath = "artifacts/playwright/test-results/run/claim.manifest.json";
const screenshotPath = "artifacts/playwright/test-results/run/claim.png";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "responsive-artifacts-"));
  roots.push(root);
  const claim = {
    kind: "claim",
    id: "claim",
    file: "deployables/marketplace/e2e/claim.spec.ts",
    testTitle: "claim @marketplace-browse",
    route: { name: "route", path: "/route" },
    fixture: { identity: "fixture:v1" },
    viewport: { width: 390, height: 844 },
    target: { identity: "target", selector: "main", populatedSelector: ":scope > *" },
    measurements: [
      {
        identity: "width",
        scope: "target",
        selector: ":scope",
        property: "width",
        assertion: { maximum: 390 },
      },
    ],
    artifact: "claim",
  };
  await write(
    root,
    sourceManifestPath,
    JSON.stringify({ contract: "fail-closed-responsive-evidence", schemaVersion: 1, claims: [claim] }),
  );
  await write(root, "playwright.config.ts", "export default {};\n");
  await write(root, screenshotPath, "screenshot");
  const runtime = {
    contract: "responsive-evidence-runtime",
    schemaVersion: 2,
    claimId: "claim",
    route: { ...claim.route, observed: claim.route.path },
    fixture: claim.fixture,
    viewport: claim.viewport,
    target: claim.target,
    assertions: [{ identity: "width", property: "width", expected: { maximum: 390 }, actual: 390 }],
    artifacts: {
      screenshot: { path: screenshotPath, sha256: sha256("screenshot") },
      manifest: { path: runtimeManifestPath },
      sourceClaimSha256: sha256(JSON.stringify(claim)),
      playwrightConfig: { path: "playwright.config.ts", sha256: sha256("export default {};\n") },
    },
  };
  await write(root, runtimeManifestPath, JSON.stringify(runtime));
  return root;
}

async function mutateRuntime(root, callback) {
  const file = path.join(root, runtimeManifestPath);
  const runtime = JSON.parse(await readFile(file, "utf8"));
  callback(runtime);
  await writeFile(file, JSON.stringify(runtime), "utf8");
}

async function write(root, relativePath, contents) {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

async function producerLog(root) {
  const file = "producer.log";
  await write(
    root,
    file,
    "✓ 1 [marketplace-chromium] › claim.spec.ts:1:1 › claim @marketplace-browse (1ms)\n" +
      'palette (light): {"observed":{"background":"rgb(0, 0, 0)"},"expected":{"background":"rgb(0, 0, 0)"}}\n' +
      "1 passed (1s)\n" +
      "SYNTHETIC_SECRET=must-not-be-retained\n",
  );
  return path.join(root, file);
}

function successfulProducer() {
  return {
    outcome: "success",
    repository: "synthetic/example",
    workflow: "Synthetic PR",
    workflowRef: "synthetic/example/.github/workflows/pr.yml@refs/pull/1/merge",
    workflowSha: "7".repeat(40),
    eventName: "pull_request",
    runId: 123,
    runAttempt: 2,
    job: "evidence",
    jobIndex: 3,
    suiteBatch: "marketplace_browse",
    checkoutSha: "1".repeat(40),
    checkoutTreeSha: "5".repeat(40),
    checkoutParentShas: ["3".repeat(40), "2".repeat(40)],
    executedBaseSha: "3".repeat(40),
    executedBaseTreeSha: "4".repeat(40),
    sourceHeadSha: "2".repeat(40),
    sourceHeadTreeSha: "6".repeat(40),
    eventBaseSha: "3".repeat(40),
  };
}

function syntheticGitIdentity() {
  return {
    checkoutCommit: "1".repeat(40),
    checkoutTree: "5".repeat(40),
    checkoutParents: ["3".repeat(40), "2".repeat(40)],
    executedBase: "3".repeat(40),
    executedBaseTree: "4".repeat(40),
    shallow: false,
    sourceHead: "2".repeat(40),
    sourceHeadTree: "6".repeat(40),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
