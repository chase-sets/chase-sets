import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { captureRunnerIdentity, validateCaptureUpload } from "./catalog-staging-count-lifecycle.mjs";
import { writeCountCaptureArtifact } from "../bounded-contexts/catalog/features/scope-sync-batches/api/count-capture-artifact.ts";

describe("isolates capture", () => {
  const source = readFileSync(".github/workflows/catalog-staging-provider-uat.yml", "utf8");
  function assertIsolated(document) {
    const job = document.jobs["scope-sync-count-lifecycle"];
    expect(job).toBeDefined();
    expect(job.permissions).toEqual({ contents: "read", actions: "read" });
    expect(job.if).toContain("inputs.journey_scope == 'scope-sync-count-lifecycle'");
    expect(document.jobs["staging-provider-uat"].if).toContain("inputs.journey_scope != 'scope-sync-count-lifecycle'");
    expect(document.concurrency).toEqual({
      group: "platform-staging-mutating-operations",
      "cancel-in-progress": false,
    });
    const run = job.steps.find((step) => step.id === "capture");
    expect(run.run).toContain("catalog-staging-count-lifecycle");
    const validate = job.steps.find((step) => step.id === "capture-receipt");
    expect(validate.run).toContain("validate");
    const uploads = job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0].if).toContain("steps.capture-receipt.outcome == 'success'");
    expect(uploads[0].with.path).toBe("artifacts/catalog-count-lifecycle/receipt.json");
    expect(job.needs).toBe("admit-reviewed-sha");
    expect(job.environment).toBe("staging");
    expect(job.steps.find((step) => step.uses?.startsWith("actions/checkout@")).with.ref).toBe(
      "${{ inputs.expected_sha }}",
    );
    expect(document.jobs["resolve-provider-uat-plan"].if).toContain(
      "inputs.journey_scope != 'scope-sync-count-lifecycle'",
    );
    expect(document.jobs["staging-provider-uat"].permissions?.actions).toBeUndefined();
    expect(document.permissions.actions).toBeUndefined();
  }
  it("has a dedicated permission and upload boundary rather than a matrix grant", () => {
    assertIsolated(parse(source));
  });
  it("rejects validation-deleted and discovery/import selector bypass mutants", () => {
    const validationDeleted = parse(source);
    const job = validationDeleted.jobs["scope-sync-count-lifecycle"];
    expect(job).toBeDefined();
    job.steps = job.steps.filter((step) => step.id !== "capture-receipt");
    expect(() => assertIsolated(validationDeleted)).toThrow();
    for (const scope of ["scope-sync-batch-preview-probe", "full-game-start"]) {
      const mutant = parse(source);
      mutant.jobs["scope-sync-count-lifecycle"].if = `inputs.journey_scope == '${scope}'`;
      expect(() => assertIsolated(mutant)).toThrow();
    }
  });
});

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes("count-capture-upload-"))
      throw new Error("unsafe-test-cleanup");
    await rm(root, { recursive: true });
  }
});

describe("runner-owned upload proof", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    ADMIN_WEB_URL: "https://admin.staging.chasesets.com",
    GITHUB_SHA: "a".repeat(40),
    EXPECTED_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    CATALOG_STAGING_PROVIDER_UAT_SCOPE: "scope-sync-count-lifecycle",
    CATALOG_CAPTURE_DISPATCH_ID: "synthetic-dispatch",
    CATALOG_CAPTURE_SCOPE_RECORD_ID: "synthetic-scope",
  };
  const stop = {
    schemaVersion: "scope-sync-count-lifecycle-stop/v1",
    stoppedAt: "2026-10-13T08:00:00Z",
    phase: "baseline",
    reason: "authority-unbound",
    evidence: {},
  };
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "count-capture-upload-"));
    roots.push(root);
    const boundEnv = { ...env, RUNNER_TEMP: root };
    await writeCountCaptureArtifact(stop, ["synthetic-session-marker"], root);
    const artifact = join(root, "artifacts/catalog-count-lifecycle/receipt.json");
    const sha256 = createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex");
    const seal = join(root, "catalog-count-capture-upload.json");
    await writeFile(seal, JSON.stringify({ identity: captureRunnerIdentity(env), sha256 }));
    return { root, boundEnv, artifact, seal };
  }
  it("keeps an honest incomplete receipt uploadable without calling it conforming", async () => {
    const { root, boundEnv, seal } = await fixture();
    expect(await validateCaptureUpload(boundEnv, root)).toMatchObject({ valid: true, verdict: "INCOMPLETE" });
    expect(await readFile(seal, "utf8")).not.toContain("synthetic-session-marker");
  });
  it.each(["GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "CATALOG_CAPTURE_DISPATCH_ID"])(
    "refuses substituted %s at upload",
    async (key) => {
      const { root, boundEnv } = await fixture();
      await expect(
        validateCaptureUpload({ ...boundEnv, [key]: key === "GITHUB_SHA" ? "b".repeat(40) : "2" }, root),
      ).rejects.toThrow();
    },
  );
  it("refuses bytes changed after the in-memory session-marker scan", async () => {
    const { root, boundEnv, artifact } = await fixture();
    await writeFile(artifact, JSON.stringify({ ...stop, stoppedAt: "2026-10-13T08:01:00Z" }));
    await expect(validateCaptureUpload(boundEnv, root)).rejects.toThrow();
  });
  it("refuses traces even alongside a correctly sealed receipt", async () => {
    const { root, boundEnv, artifact } = await fixture();
    await writeFile(join(dirname(artifact), "trace.zip"), "synthetic-session-marker");
    await expect(validateCaptureUpload(boundEnv, root)).rejects.toThrow();
  });
  it.each(["ADMIN_WEB_URL", "GITHUB_ACTIONS", "EXPECTED_SHA", "CATALOG_STAGING_PROVIDER_UAT_SCOPE"])(
    "refuses invalid capture %s before browser launch",
    (key) => {
      expect(() => captureRunnerIdentity({ ...env, [key]: "invalid" })).toThrow("count-capture-runner-refused");
    },
  );
});
