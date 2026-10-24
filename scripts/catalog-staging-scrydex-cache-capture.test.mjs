import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { runScrydexCacheCapture } from "../bounded-contexts/catalog/features/scope-sync-batches/api/scrydex-cache-capture-runner.ts";
import {
  scrydexCacheCaptureArtifactPath,
  scrydexCacheCaptureQueryHrefUnit,
  scrydexCacheCaptureUnits,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-cache-capture.ts";
import { listCatalogProviderProfileVersionReviews } from "../bounded-contexts/catalog/features/source-observations/api/providers/provider-profile-review.ts";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
} from "../bounded-contexts/catalog/features/source-observations/api/providers/registry.ts";
import { classifyCountCaptureJob, readCountCaptureWorkflowCapabilities } from "./catalog-count-capture-deployment.mjs";
import {
  appendCaptureOutputs,
  capture,
  captureExitCode,
  captureReadByteCaps,
  captureRunnerIdentity,
  emptyCaptureTally,
  fenceCaptureRoute,
  readCatalogJsonInPage,
  resolveScrydexCacheCaptureQueryHref,
  selectCaptureDeployment,
  validateCaptureUpload,
  writeCaptureArtifact,
} from "./catalog-staging-scrydex-cache-capture.mjs";

const workflowSource = readFileSync(resolve(".github/workflows/catalog-staging-provider-uat.yml"), "utf8");
const workflow = () => parse(workflowSource);
const origin = "https://admin.staging.chasesets.com";
const credentialKeys = ["CATALOG_ADMIN_E2E_EMAIL", "CATALOG_ADMIN_E2E_PASSWORD", "GH_TOKEN"];
const synthetic = {
  CATALOG_ADMIN_E2E_EMAIL: "synthetic-capture-admin@example.invalid",
  CATALOG_ADMIN_E2E_PASSWORD: "synthetic-capture-password-marker",
  GH_TOKEN: "synthetic-capture-actions-token",
};
const directories = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "scrydex-cache-capture-"));
  directories.push(directory);
  return directory;
}

function runnerEnv(overrides = {}) {
  return {
    GITHUB_ACTIONS: "true",
    ADMIN_WEB_URL: origin,
    GITHUB_SHA: "a".repeat(40),
    EXPECTED_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123456",
    GITHUB_RUN_ATTEMPT: "1",
    CATALOG_STAGING_PROVIDER_UAT_SCOPE: "scrydex-cache-capture",
    RUNNER_TEMP: temporaryDirectory(),
    ...synthetic,
    ...overrides,
  };
}

// Evaluates the workflow's `a == 'b' && c != 'd'` job conditions; any other
// syntax fails the test rather than being guessed.
function conditionHolds(expression, context) {
  return expression.split("&&").every((term) => {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*(==|!=)\s*'([^']*)'\s*$/.exec(term);
    if (!match || !(match[1] in context)) throw new Error(`unsupported condition: ${term}`);
    return match[2] === "==" ? context[match[1]] === match[3] : context[match[1]] !== match[3];
  });
}

function jobsSelectedFor(document, journeyScope) {
  if (journeyScope === "scrydex-force-refresh-bounded") return ["scrydex-force-refresh-bounded"];
  if (journeyScope === "scrydex-cache-capture") return ["scrydex-cache-capture"];
  const context = { "inputs.journey_scope": journeyScope, "needs.admit-reviewed-sha.result": "success" };
  const resolves = conditionHolds(document.jobs["resolve-provider-uat-plan"].if, context);
  context["needs.resolve-provider-uat-plan.result"] = resolves ? "success" : "skipped";
  return ["resolve-provider-uat-plan", "staging-provider-uat", "scope-sync-count-lifecycle"].filter((name) =>
    conditionHolds(document.jobs[name].if, context),
  );
}

function assertCaptureJobIsolated(document) {
  const job = document.jobs["scrydex-cache-capture"];
  expect(job.needs).toEqual(["admit-reviewed-sha", "scrydex-force-refresh-bounded"]);
  expect(job.if).toContain("needs.scrydex-force-refresh-bounded.outputs.refresh_outcome == 'complete'");
  expect(job.environment).toBe("staging");
  expect(job.permissions).toEqual({ contents: "read", actions: "read" });
  expect(job.env).toEqual({
    ADMIN_WEB_URL: "${{ inputs.admin_web_url }}",
    EXPECTED_SHA: "${{ inputs.expected_sha }}",
    CATALOG_STAGING_PROVIDER_UAT_SCOPE: "scrydex-cache-capture",
  });
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout.with).toEqual({ ref: "${{ inputs.expected_sha }}", "persist-credentials": false });
  const run = job.steps.find((step) => step.id === "capture");
  const validate = job.steps.find((step) => step.id === "capture-receipt");
  expect(run.run).toBe("pnpm exec tsx scripts/catalog-staging-scrydex-cache-capture.mjs capture");
  expect(validate.run).toBe("pnpm exec tsx scripts/catalog-staging-scrydex-cache-capture.mjs validate");
  expect(validate.if).toBe("${{ always() && steps.capture.outcome != 'skipped' }}");
  for (const step of [run, validate]) {
    expect(step.env).toEqual({
      CATALOG_ADMIN_E2E_EMAIL: "${{ vars.CATALOG_ADMIN_E2E_EMAIL || secrets.PLATFORM_ADMIN_EMAIL || '' }}",
      CATALOG_ADMIN_E2E_PASSWORD: "${{ secrets.CATALOG_ADMIN_E2E_PASSWORD || secrets.PLATFORM_ADMIN_PASSWORD || '' }}",
      GH_TOKEN: "${{ github.token }}",
    });
  }
  for (const step of job.steps.filter((candidate) => candidate !== run && candidate !== validate)) {
    for (const key of credentialKeys) expect(step.env?.[key], `${step.name ?? step.uses} holds ${key}`).toBeUndefined();
  }
  const uploads = job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(uploads.map((upload) => upload.if)).toEqual([
    "${{ always() && steps.capture.outcome == 'success' && steps.capture-receipt.outcome == 'success' && steps.capture-receipt.outputs.capture_status == 'complete' }}",
    "${{ always() && steps.capture-receipt.outcome == 'success' && steps.capture-receipt.outputs.capture_status == 'governed-unknown' }}",
  ]);
  expect(uploads.map((upload) => upload.with.name)).toEqual([
    "catalog-scrydex-cache-capture-${{ github.run_id }}-${{ github.run_attempt }}",
    "catalog-scrydex-cache-capture-diagnostic-${{ github.run_id }}-${{ github.run_attempt }}",
  ]);
  for (const upload of uploads) {
    expect(upload.with.path).toBe(scrydexCacheCaptureArtifactPath);
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(job.steps.indexOf(upload)).toBeGreaterThan(job.steps.indexOf(validate));
  }
}

describe("Scrydex cache capture workflow", () => {
  it("leaves the real no-options default unchanged and runs only the capture job when selected", () => {
    const document = workflow();
    const scope = document.on.workflow_dispatch.inputs.journey_scope;
    expect(scope.default).toBe("one-piece-launch");
    expect(scope.options).toContain("scrydex-cache-capture");
    expect(jobsSelectedFor(document, scope.default)).toEqual(["resolve-provider-uat-plan", "staging-provider-uat"]);
    expect(jobsSelectedFor(document, "scrydex-cache-capture")).toEqual(["scrydex-cache-capture"]);
    expect(jobsSelectedFor(document, "scope-sync-count-lifecycle")).toEqual(["scope-sync-count-lifecycle"]);
    expect(document.concurrency).toEqual({
      group: "platform-staging-mutating-operations",
      "cancel-in-progress": false,
    });
  });

  it("isolates credentials, the Actions read grant and the two gated uploads in the capture job", () => {
    assertCaptureJobIsolated(workflow());
    const document = workflow();
    expect(document.permissions).toEqual({ contents: "read" });
    expect(document.jobs["staging-provider-uat"].permissions).toBeUndefined();
    for (const mutate of [
      (d) =>
        (d.jobs["scrydex-cache-capture"].steps.find((s) => s.uses?.startsWith("actions/upload-artifact@")).if =
          "${{ always() }}"),
      (d) => (d.jobs["scrydex-cache-capture"].steps.at(-1).with.path = "artifacts/catalog-scrydex-cache-capture"),
      (d) => (d.jobs["scrydex-cache-capture"].env.GH_TOKEN = "${{ github.token }}"),
      (d) => (d.jobs["scrydex-cache-capture"].permissions.actions = "write"),
      (d) => (d.jobs["scrydex-cache-capture"].steps.find((s) => s.id === "capture-receipt").if = "${{ always() }}"),
    ]) {
      const mutant = workflow();
      mutate(mutant);
      expect(() => assertCaptureJobIsolated(mutant)).toThrow();
    }
  });

  it("classifies the capture job as unable to mutate staging, so it never voids a deployment binding", async () => {
    const definitions = readCountCaptureWorkflowCapabilities(workflowSource);
    expect(await classifyCountCaptureJob(definitions, "Scrydex Cache Capture")).toBe("non-mutating");
  });

  it("admits the capture only for the exact staging origin before any credential job", () => {
    const script = workflow().jobs["admit-reviewed-sha"].steps[0].with.script;
    const failuresFor = (target) => {
      const failures = [];
      runInNewContext(script, {
        process: {
          env: {
            EXPECTED_SHA: "a".repeat(40),
            RUN_SHA: "a".repeat(40),
            CONFIRMATION: "run catalog staging provider uat",
            JOURNEY_SCOPE: "scrydex-cache-capture",
            ADMIN_WEB_URL: target,
          },
        },
        core: { setFailed: (message) => failures.push(message) },
      });
      return failures;
    };
    expect(failuresFor(origin)).toEqual([]);
    for (const target of ["https://admin.chasesets.com", `${origin}/`, "http://admin.staging.chasesets.com"]) {
      expect(failuresFor(target), target).toHaveLength(1);
    }
  });
});

describe("Scrydex cache capture runner identity and reads", () => {
  it("binds only the admitted staging run and refuses every other identity", () => {
    expect(captureRunnerIdentity(runnerEnv())).toEqual({
      sha: "a".repeat(40),
      runId: "123456",
      runAttempt: "1",
      journeyScope: "scrydex-cache-capture",
      origin: "admin.staging.chasesets.com",
    });
    for (const patch of [
      { GITHUB_ACTIONS: "false" },
      { ADMIN_WEB_URL: `${origin}/` },
      { EXPECTED_SHA: "b".repeat(40) },
      { GITHUB_RUN_ID: "0" },
      { GITHUB_RUN_ATTEMPT: "" },
      { CATALOG_STAGING_PROVIDER_UAT_SCOPE: "scope-sync-batch-preview-probe" },
      { RUNNER_TEMP: "" },
    ]) {
      expect(() => captureRunnerIdentity(runnerEnv(patch)), JSON.stringify(patch)).toThrow(
        "scrydex-cache-capture-refused",
      );
    }
  });

  it("derives each unit's cache-only queryHref from the deployed roster through the shipped builder", async () => {
    const items = await listCatalogProviderProfileVersionReviews({
      listProfileVersions: async () => catalogProviderIntegrationProfileVersions,
      countProfileVersionReferences: async () => 0,
    });
    const serialized = JSON.stringify({ items, total: items.length, count: items.length });
    expect(Buffer.byteLength(serialized) * 3).toBeLessThan(captureReadByteCaps.profiles);
    const deployed = JSON.parse(serialized).items;
    for (const { unitKey } of scrydexCacheCaptureUnits) {
      const href = resolveScrydexCacheCaptureQueryHref(deployed, unitKey);
      expect(scrydexCacheCaptureQueryHrefUnit(href), unitKey).toBe(unitKey);
      const params = new URL(href, origin).searchParams;
      const active = catalogProviderIntegrationProfileVersions.find(
        (version) => version.active && catalogProviderProfileVersionIngestionUnitKey(version) === unitKey,
      );
      expect(params.get("profileKey")).toBe(active.profileKey);
      expect(params.has("forceRefresh")).toBe(false);
    }
    expect(resolveScrydexCacheCaptureQueryHref([], scrydexCacheCaptureUnits[0].unitKey)).toBeNull();
  });

  it("reads one bounded, same-origin GET without following redirects", async () => {
    const body = (text) => new Response(text, { status: 200 });
    const fetchImpl = vi.fn(async () => body('{"items":[]}'));
    await expect(readCatalogJsonInPage({ path: "/api/x", deadlineMs: 1000, byteCap: 100, fetchImpl })).resolves.toEqual(
      {
        status: 200,
        text: '{"items":[]}',
      },
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
    await expect(
      readCatalogJsonInPage({
        path: "/api/x",
        deadlineMs: 1000,
        byteCap: 5,
        fetchImpl: async () => body("x".repeat(6)),
      }),
    ).rejects.toThrow("capture-read-refused");
    await expect(
      readCatalogJsonInPage({
        path: "/api/x",
        deadlineMs: 1000,
        byteCap: 100,
        fetchImpl: async () => new Response("unavailable", { status: 503 }),
      }),
    ).resolves.toEqual({ status: 503, text: "" });
    const hanging = (_path, init) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(
      readCatalogJsonInPage({ path: "/api/x", deadlineMs: 10, byteCap: 100, fetchImpl: hanging }),
    ).rejects.toThrow();
  });

  it("selects the deployed generation with the bounded window and keeps a stop value-free", async () => {
    const generation = {
      runId: "9000000001",
      runAttempt: 1,
      jobId: "9000000002",
      jobCompletedAt: "2026-10-20T15:00:00Z",
      deployedHead: "b".repeat(40),
    };
    const select = vi.fn(async () => ({
      stop: null,
      deployGeneration: generation,
      deployment: { imageDigest: `sha256:${"c".repeat(64)}` },
    }));
    await expect(selectCaptureDeployment("synthetic-token", select)).resolves.toEqual({
      generation: { ...generation, imageDigest: `sha256:${"c".repeat(64)}` },
      stop: null,
    });
    expect(select.mock.calls[0][0]).toMatchObject({
      token: "synthetic-token",
      maxAgeSeconds: 86_400,
      requestTimeoutMs: 30_000,
    });
    await expect(
      selectCaptureDeployment("synthetic-token", async () => ({
        stop: "deploy-in-progress",
        deployGeneration: null,
        deployment: null,
      })),
    ).resolves.toEqual({ generation: null, stop: "deploy-in-progress" });
  });
});

describe("Scrydex cache capture request fence", () => {
  function fakeRoute({ method = "GET", url, navigation = false, location }) {
    const calls = [];
    return {
      calls,
      route: {
        request: () => ({ method: () => method, url: () => url, isNavigationRequest: () => navigation }),
        abort: async (reason) => calls.push(["abort", reason]),
        fetch: async (options) => {
          calls.push(["fetch", options]);
          return { headers: () => (location ? { location } : {}) };
        },
        fulfill: async () => calls.push(["fulfill"]),
      },
    };
  }
  const optionUrl = `${origin}/api/catalog/source-observations/integration-options?providerKey=scrydex&queryKind=sets&limit=25&profileKey=one-piece-set-reference-data&ingestionUnitKey=scrydex%3Aone-piece%3Aset%3Areference-data&languageCode=en&cacheOnly=true`;

  it("fetches allowed reads without redirects and refuses a cross-origin Location", async () => {
    const tally = emptyCaptureTally();
    const allowed = fakeRoute({ url: optionUrl });
    await fenceCaptureRoute(allowed.route, "capture", tally);
    expect(allowed.calls).toEqual([["fetch", { maxRedirects: 0, maxRetries: 0 }], ["fulfill"]]);
    const redirected = fakeRoute({
      method: "POST",
      url: `${origin}/access/sign-in`,
      location: "https://elsewhere.invalid/x",
    });
    await fenceCaptureRoute(redirected.route, "sign-in", tally);
    expect(redirected.calls.at(-1)).toEqual(["abort", "blockedbyclient"]);
    expect(tally.requests).toMatchObject({ cacheOptionReads: 1, signIn: 1, fenceRefusals: 1 });
    expect(tally.fence).toEqual([{ method: "POST", path: "/access/sign-in", reason: "cross-origin-redirect" }]);
  });

  it("aborts mutations, TCGplayer and refresh reads before they leave the browser, and only blocks ambient reads", async () => {
    const tally = emptyCaptureTally();
    for (const [method, url, phase] of [
      ["POST", `${origin}/access/sign-out`, "capture"],
      ["GET", "https://www.tcgplayer.com/search", "sign-in"],
      ["GET", `${optionUrl}&forceRefresh=true`, "capture"],
    ]) {
      const { route, calls } = fakeRoute({ method, url });
      await fenceCaptureRoute(route, phase, tally);
      expect(calls).toEqual([["abort", "blockedbyclient"]]);
    }
    const ambient = fakeRoute({ url: `${origin}/catalog/scopes/sync-batches.data` });
    await fenceCaptureRoute(ambient.route, "capture", tally);
    expect(ambient.calls).toEqual([["abort", "blockedbyclient"]]);
    expect(tally.requests).toMatchObject({ fenceRefusals: 3, ambientReadsBlocked: 1, cacheOptionReads: 0 });
    expect(tally.fence.map(({ reason }) => reason)).toEqual(["mutation:POST", "tcgplayer", "api-read-outside-capture"]);
    expect(JSON.stringify(tally.fence)).not.toContain("?");
  });

  it("bounds the recorded refusals while counting every one", async () => {
    const tally = emptyCaptureTally();
    for (let index = 0; index < 60; index += 1) {
      await fenceCaptureRoute(fakeRoute({ method: "DELETE", url: `${origin}/x/${index}` }).route, "capture", tally);
    }
    expect(tally.requests.fenceRefusals).toBe(60);
    expect(tally.fence).toHaveLength(50);
  });
});

describe("Scrydex cache capture artifact", () => {
  async function governedUnknownReceipt(identity, fence = []) {
    return runScrydexCacheCapture({
      runner: identity,
      credentialsPresent: false,
      selectDeployment: async () => {
        throw new Error("not called");
      },
      signIn: async () => {
        throw new Error("not called");
      },
      read: async () => {
        throw new Error("not called");
      },
      resolveQueryHref: () => null,
      tally: () => ({ requests: { ...emptyCaptureTally().requests, fenceRefusals: fence.length }, fence }),
      now: () => "2026-10-20T16:00:00.000Z",
    });
  }

  it("writes one sealed receipt that validates and names its status for the upload gates", async () => {
    const env = runnerEnv();
    const workspace = temporaryDirectory();
    const identity = captureRunnerIdentity(env);
    const receipt = await governedUnknownReceipt(identity);
    await writeCaptureArtifact(receipt, Object.values(synthetic), env, workspace, identity);
    const bytes = await readFile(join(workspace, scrydexCacheCaptureArtifactPath));
    const verdict = await validateCaptureUpload(env, workspace);
    expect(verdict).toEqual({
      captureStatus: "governed-unknown",
      reasons: receipt.reasons.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const output = join(temporaryDirectory(), "github-output");
    await appendCaptureOutputs(verdict, output);
    expect(readFileSync(output, "utf8")).toBe(`capture_status=governed-unknown\ncapture_sha256=${verdict.sha256}\n`);
    await expect(writeCaptureArtifact(receipt, Object.values(synthetic), env, workspace, identity)).rejects.toThrow(
      "scrydex-cache-capture-refused",
    );
  });

  it("refuses to write a receipt that carries a credential marker", async () => {
    const env = runnerEnv();
    const workspace = temporaryDirectory();
    const identity = captureRunnerIdentity(env);
    const leaking = await governedUnknownReceipt(identity, [
      { method: "GET", path: `/x/${synthetic.CATALOG_ADMIN_E2E_PASSWORD}`, reason: "cross-origin" },
    ]);
    await expect(writeCaptureArtifact(leaking, Object.values(synthetic), env, workspace, identity)).rejects.toThrow(
      "scrydex-cache-capture-refused",
    );
    expect(() => readFileSync(join(workspace, scrydexCacheCaptureArtifactPath))).toThrow();
  });

  it.each([
    [
      "a tampered receipt",
      async (file) =>
        writeFile(file, (await readFile(file, "utf8")).replace("credentials-missing", "credentials-missing ")),
    ],
    ["a second file beside the receipt", async (file) => writeFileSync(join(file, "..", "extra.json"), "{}")],
    ["a removed receipt", async (file) => rmSync(file)],
  ])("refuses upload of %s", async (_name, mutate) => {
    const env = runnerEnv();
    const workspace = temporaryDirectory();
    const identity = captureRunnerIdentity(env);
    await writeCaptureArtifact(
      await governedUnknownReceipt(identity),
      Object.values(synthetic),
      env,
      workspace,
      identity,
    );
    await mutate(join(workspace, scrydexCacheCaptureArtifactPath));
    await expect(validateCaptureUpload(env, workspace)).rejects.toThrow("scrydex-cache-capture-refused");
  });

  it("refuses upload from another attempt and of a receipt containing a current credential value", async () => {
    const env = runnerEnv();
    const workspace = temporaryDirectory();
    const identity = captureRunnerIdentity(env);
    await writeCaptureArtifact(
      await governedUnknownReceipt(identity),
      Object.values(synthetic),
      env,
      workspace,
      identity,
    );
    await expect(validateCaptureUpload({ ...env, GITHUB_RUN_ATTEMPT: "2" }, workspace)).rejects.toThrow(
      "scrydex-cache-capture-refused",
    );
    await expect(validateCaptureUpload({ ...env, GH_TOKEN: "admin.staging.chasesets.com" }, workspace)).rejects.toThrow(
      "scrydex-cache-capture-refused",
    );
  });

  it("with a withheld credential makes no GitHub, browser or Admin call and publishes only a diagnostic", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network denied");
    });
    vi.stubGlobal("fetch", fetch);
    const env = runnerEnv({ CATALOG_ADMIN_E2E_PASSWORD: "" });
    const workspace = temporaryDirectory();
    const receipt = await capture(env, workspace);
    expect(fetch).not.toHaveBeenCalled();
    expect(receipt.captureStatus).toBe("governed-unknown");
    expect(receipt.reasons).toContain("credentials-missing");
    expect(captureExitCode(receipt)).toBe(1);
    await expect(validateCaptureUpload(env, workspace)).resolves.toMatchObject({ captureStatus: "governed-unknown" });
    expect(captureExitCode({ captureStatus: "complete" })).toBe(0);
  });
});
