import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanPlaywrightArtifactUploads } from "./playwright-artifact-upload-fence.mjs";
import {
  prepareHostedResponsiveEvidenceArtifact,
  validateResponsiveEvidenceArtifacts,
} from "./validate-responsive-evidence-artifacts.mjs";

const roots = [];
const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("responsive evidence artifact validation", () => {
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
      selectedGreps: ["@marketplace-browse"],
      producer: successfulProducer(),
      producerLogPath: await producerLog(root),
      gitIdentity: syntheticGitIdentity(),
      outputRoot,
    });

    expect(result).toMatchObject({ publish: true, violations: [], expectedClaimIds: ["claim"] });
    expect(JSON.parse(await readFile(path.join(root, outputRoot, "provenance.json"), "utf8"))).toMatchObject({
      schemaVersion: "hosted-responsive-evidence/v1",
      producer: { outcome: "success", runId: 123, runAttempt: 2, jobIndex: 3 },
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
    expect(e2eJob).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(e2eJob).toContain("path: artifacts/hosted-responsive-evidence");
    expect(e2eJob).toContain("if-no-files-found: error");
    expect(e2eJob).toContain("if: steps.responsive-evidence.outputs.publish == 'true'");
    expect(e2eJob).not.toContain("artifacts/playwright/report");
    expect(e2eJob).not.toContain("artifacts/playwright/test-results");
    expect(fence.status).toBe("pass");
    expect(fence.findings).toEqual([]);
  });

  it("publishes nothing when the successful producer payload is incomplete", async () => {
    const root = await fixture();
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
    ["wrong producer head", {}, { ...syntheticGitIdentity(), sourceHead: "4".repeat(40) }, "source head"],
    ["non-shallow checkout without parents", {}, { ...syntheticGitIdentity(), checkoutParents: [] }, "neither exposes"],
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

  it("records an exact shallow checkout boundary when Git cannot expose merge parents", async () => {
    const root = await fixture();

    const result = await prepareHostedResponsiveEvidenceArtifact({
      repoRoot: root,
      selectedGreps: ["@marketplace-browse"],
      producer: successfulProducer(),
      producerLogPath: await producerLog(root),
      gitIdentity: { ...syntheticGitIdentity(), checkoutParents: [], shallow: true, sourceHeadTree: null },
    });

    expect(result).toMatchObject({ publish: true, violations: [] });
    expect(
      JSON.parse(await readFile(path.join(root, "artifacts/hosted-responsive-evidence/provenance.json"), "utf8")),
    ).toMatchObject({ git: { checkoutParents: [], shallow: true, sourceHeadTree: null } });
  });
});

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
    sourceHeadSha: "2".repeat(40),
    baseSha: "3".repeat(40),
  };
}

function syntheticGitIdentity() {
  return {
    checkoutCommit: "1".repeat(40),
    checkoutTree: "5".repeat(40),
    checkoutParents: ["3".repeat(40), "2".repeat(40)],
    shallow: false,
    sourceHead: "2".repeat(40),
    sourceHeadTree: "6".repeat(40),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
