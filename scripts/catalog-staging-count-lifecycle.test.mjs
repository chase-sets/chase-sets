import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { z } from "../bounded-contexts/catalog/node_modules/zod/index.js";
import {
  countCaptureFreezeInputSchema,
  countCapturePlannerInputSchema,
} from "../bounded-contexts/catalog/features/scope-sync-batches/api/count-capture-lifecycle";
import {
  captureExitCode,
  captureActionDeadlineMs,
  captureResponseByteCap,
  addCookieMarkers,
  watchSessionMarkers,
  persistCaptureReceipt,
  settleCaptureReceipt,
  captureActionInPage,
  captureRunnerIdentity,
  captureUploadIdentity,
  completeStopReceipt,
  validateCaptureUpload,
} from "./catalog-staging-count-lifecycle.mjs";
import { writeCountCaptureArtifact } from "../bounded-contexts/catalog/features/scope-sync-batches/api/count-capture-artifact.ts";
import {
  syntheticCountCaptureAuthority,
  syntheticCountLifecycleStopReceipt,
} from "../bounded-contexts/catalog/features/scope-sync-batches/tests/count-lifecycle-receipt-fixture.ts";

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

describe("capture receipt contracts", () => {
  it("retains rotated cookie markers in the runner scan set", async () => {
    const module = await import("./catalog-staging-count-lifecycle.mjs");
    const markers = new Set(["initial-cookie"]);
    module.addCookieMarkers(markers, [{ value: "rotated-cookie" }]);
    expect(markers).toEqual(new Set(["initial-cookie", "rotated-cookie"]));
  });
  it("harvests a rotated response cookie before upload and refuses the value-free artifact", async () => {
    const marker = "rotated-cookie-marker";
    let onResponse;
    const context = {
      on: (event, handler) => {
        if (event === "response") onResponse = handler;
      },
      cookies: async () => [{ value: marker }],
    };
    const forbidden = new Set();
    const harvest = watchSessionMarkers(context, forbidden);
    onResponse();
    await Promise.allSettled([...harvest.cookieReads]);
    expect(forbidden).toContain(marker);
    const identity = captureRunnerIdentity({
      GITHUB_ACTIONS: "true",
      ADMIN_WEB_URL: "https://admin.staging.chasesets.com",
      GITHUB_SHA: "a".repeat(40),
      EXPECTED_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      CATALOG_STAGING_PROVIDER_UAT_SCOPE: "scope-sync-count-lifecycle",
      CATALOG_CAPTURE_DISPATCH_ID: marker,
      CATALOG_CAPTURE_SCOPE_RECORD_ID: "synthetic-scope",
      CATALOG_CAPTURE_AUTHORITY: JSON.stringify(syntheticCountCaptureAuthority()),
    });
    const receipt = completeStopReceipt(
      {
        schemaVersion: "scope-sync-count-lifecycle-stop/v1",
        stoppedAt: "2026-10-13T08:06:00.000Z",
        phase: "baseline",
        reason: "capture-stopped",
        evidence: {},
      },
      identity,
    );
    const root = await mkdtemp(join(tmpdir(), "count-capture-upload-"));
    roots.push(root);
    await expect(
      persistCaptureReceipt(receipt, forbidden, { seal: join(root, "seal.json") }, root, identity),
    ).rejects.toThrow();
    await expect(readFile(join(root, "seal.json"))).rejects.toThrow();
  });
  it("keeps the runner phase when a deadline closes the browser context", () => {
    const receipt = {
      schemaVersion: "scope-sync-count-lifecycle-stop/v1",
      phase: "acquisition",
      reason: "capture-stopped",
    };
    expect(settleCaptureReceipt(receipt)).toBe(receipt);
  });
  it.each(["authority-unbound", "deployment-unknown", "capture-stopped", "missing-observation"])(
    "derives the classification for %s",
    (reason) => {
      const authority = syntheticCountCaptureAuthority();
      const receipt = completeStopReceipt(
        {
          schemaVersion: "scope-sync-count-lifecycle-stop/v1",
          stoppedAt: "2026-10-13T08:06:00.000Z",
          phase: "baseline",
          reason,
          evidence: {},
        },
        { sha: authority.runnerSha, run: "123", attempt: "1", dispatchId: authority.dispatchId, authority },
      );
      expect(receipt.classification.reasons).toContain(reason);
      expect(receipt.classification.verdict).toBe(reason === "capture-stopped" ? "FAILED" : "INCOMPLETE");
    },
  );
  it("uses the nested verdict for the CLI exit", async () => {
    const module = await import("./catalog-staging-count-lifecycle.mjs");
    expect(module.captureExitCode({ classification: { verdict: "CONFORMING" } })).toBe(0);
    expect(module.captureExitCode({ classification: { verdict: "INCOMPLETE" } })).toBe(1);
    expect(module.captureExitCode({ classification: { verdict: "FAILED" } })).toBe(1);
  });
  it("leaves explicit headroom over the largest valid freeze receipt", () => {
    expect(captureResponseByteCap).toBeGreaterThan(128_000 + JSON.stringify({ receipt: null }).length);
    expect(captureActionDeadlineMs).toBeGreaterThan(0);
  });
  it("dry-validates all ten request bodies against the deployed route schemas without sending them", async () => {
    const authority = syntheticCountCaptureAuthority();
    const fields = {
      scopeRecordId: "synthetic-scope",
      quoteId: "00000000-0000-4000-8000-000000000001",
      countFingerprint: "a".repeat(64),
      planFingerprint: "b".repeat(64),
      collection: JSON.stringify(authority.collection),
    };
    const requests = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({}), { headers: { "cache-control": "no-store" } });
    });
    for (const intent of [
      "capture-baseline",
      "capture-initial-notice",
      "capture-usage",
      "count-quote",
      "capture-quote-readback",
      "capture-final-notice",
      "count-acquire",
      "preview",
      "pre-confirm-planner-read",
      "capture-freeze",
    ])
      await captureActionInPage({
        apiPath: "/api/catalog/scope-sync-batches",
        intent,
        fields,
        authority,
        runId: "123",
        runAttempt: "1",
        deadlineMs: 1_000,
        byteCap: captureResponseByteCap,
        fetchImpl,
      });
    expect(requests).toHaveLength(10);
    const empty = z.object({}).strict();
    const schemas = [
      z.object({ scopeRecordId: z.string().min(1), authority: z.unknown() }).strict(),
      empty,
      empty,
      countCapturePlannerInputSchema,
      empty,
      empty,
      z.object({ quoteId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
      countCapturePlannerInputSchema,
      countCapturePlannerInputSchema.extend({ planFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
      countCaptureFreezeInputSchema,
    ];
    schemas.forEach((schema, index) => expect(schema.safeParse(requests[index]).success).toBe(true));
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
    CATALOG_CAPTURE_AUTHORITY: JSON.stringify(syntheticCountCaptureAuthority()),
  };
  const stop = syntheticCountLifecycleStopReceipt();
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
    await writeFile(seal, JSON.stringify({ identity: captureUploadIdentity(captureRunnerIdentity(boundEnv)), sha256 }));
    return { root, boundEnv, artifact, seal };
  }
  it("keeps an honest incomplete receipt uploadable without calling it conforming", async () => {
    const { root, boundEnv, seal } = await fixture();
    expect(await validateCaptureUpload(boundEnv, root)).toMatchObject({
      valid: true,
      classification: { verdict: "INCOMPLETE" },
    });
    expect((await readFile(seal, "utf8")).length).toBeLessThan(2048);
    expect(await readFile(seal, "utf8")).not.toContain("deployment");
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
  it("refuses content containing a non-empty credential marker", async () => {
    const { root, boundEnv } = await fixture();
    const marker = "rotated-cookie-marker";
    const envWithMarker = { ...boundEnv, CATALOG_ADMIN_E2E_EMAIL: marker };
    await writeFile(join(root, "artifacts/catalog-count-lifecycle/receipt.json"), marker);
    await expect(validateCaptureUpload(envWithMarker, root)).rejects.toThrow();
  });
  it.each(["ADMIN_WEB_URL", "GITHUB_ACTIONS", "EXPECTED_SHA", "CATALOG_STAGING_PROVIDER_UAT_SCOPE"])(
    "refuses invalid capture %s before browser launch",
    (key) => {
      expect(() => captureRunnerIdentity({ ...env, [key]: "invalid" })).toThrow("count-capture-runner-refused");
    },
  );
});
