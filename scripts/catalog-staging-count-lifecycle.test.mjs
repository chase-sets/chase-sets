import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { z } from "../bounded-contexts/catalog/node_modules/zod/index.js";
import {
  countCaptureCompleteInputSchema,
  countCaptureFreezeInputSchema,
  countCapturePlannerInputSchema,
} from "../bounded-contexts/catalog/features/scope-sync-batches/api/count-capture-lifecycle";
import {
  captureExitCode,
  capture,
  captureActionDeadlineMs,
  captureActionPaths,
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
import {
  countCaptureBoundaryWaitMs,
  runCountCaptureJourney,
} from "../bounded-contexts/catalog/features/scope-sync-batches/api/count-capture-runner.ts";
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
    const credentialKeys = ["CATALOG_ADMIN_E2E_EMAIL", "CATALOG_ADMIN_E2E_PASSWORD", "GH_TOKEN"];
    expect(Object.keys(run.env ?? {}).sort()).toEqual(credentialKeys.slice().sort());
    const validate = job.steps.find((step) => step.id === "capture-receipt");
    expect(validate.run).toContain("validate");
    expect(Object.keys(validate.env ?? {}).sort()).toEqual(credentialKeys.slice().sort());
    expect(Object.keys(job.env ?? {})).not.toEqual(expect.arrayContaining(credentialKeys));
    expect(Object.keys(document.env ?? {})).not.toEqual(expect.arrayContaining(credentialKeys));
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
  it("rejects withheld-credential mutants on both steps", () => {
    for (const id of ["capture", "capture-receipt"]) {
      for (const key of ["CATALOG_ADMIN_E2E_EMAIL", "CATALOG_ADMIN_E2E_PASSWORD", "GH_TOKEN"]) {
        const mutant = parse(source);
        const step = mutant.jobs["scope-sync-count-lifecycle"].steps.find((candidate) => candidate.id === id);
        delete step.env[key];
        expect(() => assertIsolated(mutant)).toThrow();
      }
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
  it("leaves explicit headroom over the largest valid completion receipt", () => {
    expect(captureResponseByteCap).toBeGreaterThan(128_000 + JSON.stringify({ receipt: null }).length);
    expect(captureActionDeadlineMs).toBeGreaterThan(0);
  });
  it("dry-validates all eleven request bodies against the deployed route schemas without sending them", async () => {
    const authority = syntheticCountCaptureAuthority();
    const fields = {
      scopeRecordId: "synthetic-scope",
      quoteId: "00000000-0000-4000-8000-000000000001",
      countFingerprint: "a".repeat(64),
      planFingerprint: "b".repeat(64),
      dispatchId: authority.dispatchId,
      runId: "00000000-0000-4000-8000-0000000000aa",
      collection: JSON.stringify(authority.collection),
    };
    const requests = [];
    const paths = [];
    const fetchImpl = vi.fn(async (url, options) => {
      paths.push(String(url).replace("/api/catalog/scope-sync-batches", ""));
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
      "capture-complete",
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
    expect(requests).toHaveLength(11);
    // Every body the runner can send goes to an allowlisted route, and only those.
    expect(new Set(paths)).toEqual(captureActionPaths);
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
      countCaptureCompleteInputSchema,
    ];
    schemas.forEach((schema, index) => expect(schema.safeParse(requests[index]).success).toBe(true));
    // The seal carries no collection; the superseded seal-and-assemble body is refused.
    expect(requests[9]).toEqual({ dispatchId: authority.dispatchId, runnerRunId: "123", runnerRunAttempt: 1 });
    expect(countCaptureFreezeInputSchema.safeParse({ ...requests[9], collection: authority.collection }).success).toBe(
      false,
    );
    expect(requests[10]).toEqual({
      runId: fields.runId,
      dispatchId: authority.dispatchId,
      runnerRunId: "123",
      runnerRunAttempt: 1,
      collection: authority.collection,
    });
    const { collection: _omitted, ...withoutCollection } = requests[10];
    expect(countCaptureCompleteInputSchema.safeParse(withoutCollection).success).toBe(false);
  });
  it("bounds the runner's boundary wait by the per-action deadline", () => {
    expect(countCaptureBoundaryWaitMs).toBe(captureActionDeadlineMs);
  });
  // The completion returns the receipt, so it carries the largest response.
  const completeArgs = (fetchImpl, deadlineMs = 1_000) => ({
    apiPath: "/api/catalog/scope-sync-batches",
    intent: "capture-complete",
    fields: { collection: "{}" },
    authority: null,
    runId: "123",
    runAttempt: "1",
    deadlineMs,
    byteCap: captureResponseByteCap,
    fetchImpl,
  });
  const streamed =
    (text, { endless = false } = {}) =>
    async (_url, init) => {
      const bytes = new TextEncoder().encode(text);
      const body = new ReadableStream({
        start(controller) {
          for (let at = 0; at < bytes.byteLength; at += 65_536) controller.enqueue(bytes.slice(at, at + 65_536));
          if (endless)
            init.signal?.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
          else controller.close();
        },
      });
      return { ok: true, headers: new Headers({ "cache-control": "no-store" }), body };
    };
  const wrapped = (n) => `{"receipt":"${"x".repeat(n)}"}`;
  it("accepts the largest valid completion response", async () => {
    const text = wrapped(captureResponseByteCap - 14);
    expect(Buffer.byteLength(text)).toBe(captureResponseByteCap);
    await expect(captureActionInPage(completeArgs(streamed(text)))).resolves.toEqual(JSON.parse(text));
  });
  it("refuses a response one byte over the cap", async () => {
    const text = wrapped(captureResponseByteCap + 1 - 14);
    expect(Buffer.byteLength(text)).toBe(captureResponseByteCap + 1);
    await expect(captureActionInPage(completeArgs(streamed(text)))).rejects.toThrow("capture-stopped");
  });
  it("stops headers followed by an endless body within the deadline", async () => {
    const outcome = await Promise.race([
      captureActionInPage(completeArgs(streamed('{"receipt":', { endless: true }), 50)).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    expect(outcome).toBe("rejected");
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
    CATALOG_ADMIN_E2E_EMAIL: "synthetic-admin@example.com",
    CATALOG_ADMIN_E2E_PASSWORD: "synthetic-password",
    GH_TOKEN: "synthetic-token",
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
  it("stamps the run identity on every uploaded runner stop", async () => {
    const identity = captureRunnerIdentity(env);
    const authority = JSON.parse(env.CATALOG_CAPTURE_AUTHORITY);
    const bound = { sha: identity.sha, dispatchId: identity.dispatchId, scopeRecordId: identity.scopeRecordId };
    const stops = [
      await runCountCaptureJourney({ ...bound, sha: "not-a-sha" }, vi.fn()),
      await runCountCaptureJourney(
        bound,
        vi.fn(async () => {
          throw new Error("synthetic-refusal");
        }),
      ),
    ];
    expect(stops.map((stop) => stop.reason)).toEqual(["authority-unbound", "capture-stopped"]);
    for (const stop of stops) {
      const root = await mkdtemp(join(tmpdir(), "count-capture-upload-"));
      roots.push(root);
      const completed = completeStopReceipt(stop, identity);
      const files = {
        artifact: join(root, "artifacts/catalog-count-lifecycle/receipt.json"),
        seal: join(root, "catalog-count-capture-upload.json"),
      };
      await persistCaptureReceipt(completed, new Set(), files, root, identity);
      const uploaded = JSON.parse(await readFile(files.artifact, "utf8"));
      expect(uploaded.attribution).toEqual({
        dispatchId: env.CATALOG_CAPTURE_DISPATCH_ID,
        runnerRunId: env.GITHUB_RUN_ID,
        runnerRunAttempt: Number(env.GITHUB_RUN_ATTEMPT),
        runnerSha: env.GITHUB_SHA,
        packetHash: authority.packetHash,
        reviewReceiptHash: authority.review.receiptHash,
        phases: [],
      });
      await expect(
        validateCaptureUpload(
          {
            ...env,
            CATALOG_ADMIN_E2E_EMAIL: "email",
            CATALOG_ADMIN_E2E_PASSWORD: "password",
            GH_TOKEN: "token",
            RUNNER_TEMP: root,
          },
          root,
        ),
      ).resolves.toBeDefined();
    }
  });
  it("rejects withheld-credential mutants on validation", async () => {
    const { root, boundEnv } = await fixture();
    for (const key of ["CATALOG_ADMIN_E2E_EMAIL", "CATALOG_ADMIN_E2E_PASSWORD", "GH_TOKEN"])
      await expect(
        validateCaptureUpload(
          {
            ...boundEnv,
            CATALOG_ADMIN_E2E_EMAIL: "email",
            CATALOG_ADMIN_E2E_PASSWORD: "password",
            GH_TOKEN: "token",
            [key]: undefined,
          },
          root,
        ),
      ).rejects.toThrow("count-capture-runner-refused");
  });
  it("rejects withheld-credential mutants on capture before browser launch", async () => {
    for (const key of ["CATALOG_ADMIN_E2E_EMAIL", "CATALOG_ADMIN_E2E_PASSWORD", "GH_TOKEN"])
      await expect(
        capture({
          ...env,
          RUNNER_TEMP: tmpdir(),
          CATALOG_ADMIN_E2E_EMAIL: "email",
          CATALOG_ADMIN_E2E_PASSWORD: "password",
          GH_TOKEN: "token",
          [key]: undefined,
        }),
      ).rejects.toThrow("count-capture-runner-refused");
  });
});
