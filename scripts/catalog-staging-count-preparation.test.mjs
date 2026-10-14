import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { scrydexCountQuery } from "../bounded-contexts/catalog/features/source-observations/api/providers/scrydex/adapter.ts";
import { rehearsalCountPreparationApprovalSchemaVersion } from "../bounded-contexts/catalog/features/scope-sync-batches/domain/rehearsal-count-preparation-receipt.ts";
import { runCountPreparation, validateCountPreparationFile } from "./catalog-staging-count-preparation.mjs";
import { stagingRefreshOverlapWorkflowFiles } from "./staging-refresh-preflight-config.mjs";
import { scanPlaywrightArtifactUploads } from "./playwright-artifact-upload-fence.mjs";

const workflowFile = ".github/workflows/catalog-staging-count-preparation.yml";
const workflowSource = readFileSync(resolve(workflowFile), "utf8");
const workflow = () => parseYaml(workflowSource);
const receiptFile = "artifacts/catalog-count-preparation/receipt.json";
const origin = "https://admin.staging.chasesets.com";
const sha = "a".repeat(40);
const now = "2026-10-14T12:00:00.000Z";
const token = "synthetic-session-token-0123456789";
const email = "synthetic-admin@example.invalid";
const password = "synthetic-password-value";
const canonicalEmail = "${{ vars.CATALOG_ADMIN_E2E_EMAIL || secrets.PLATFORM_ADMIN_EMAIL || '' }}";
const canonicalPassword = "${{ secrets.CATALOG_ADMIN_E2E_PASSWORD || secrets.PLATFORM_ADMIN_PASSWORD || '' }}";
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryReceipt() {
  const directory = mkdtempSync(join(tmpdir(), "count-preparation-"));
  temporaryDirectories.push(directory);
  return join(directory, "receipt.json");
}

function assertPreparationIsolated(document) {
  expect(Object.keys(document.on)).toEqual(["workflow_dispatch"]);
  expect(document.permissions).toEqual({ contents: "read" });
  expect(document.concurrency).toEqual({ group: "platform-staging-mutating-operations", "cancel-in-progress": false });
  expect(Object.keys(document.jobs)).toEqual(["admit-reviewed-sha", "prepare-counts"]);
  const gate = document.jobs["admit-reviewed-sha"];
  const job = document.jobs["prepare-counts"];
  expect(gate.environment).toBeUndefined();
  expect(gate.steps).toHaveLength(1);
  expect(JSON.stringify(gate)).not.toMatch(/secrets\.|vars\./);
  expect(job.needs).toBe("admit-reviewed-sha");
  expect(job.if).toBe("needs.admit-reviewed-sha.result == 'success'");
  expect(job.environment).toBe("staging");
  expect(job.env).toBeUndefined();
  expect(job.secrets).toBeUndefined();
  const credentialed = job.steps.filter((step) => /secrets\.|vars\./.test(JSON.stringify(step)));
  expect(credentialed.map((step) => step.id)).toEqual(["prepare", "receipt"]);
  for (const step of credentialed) {
    expect(step.env.CATALOG_ADMIN_E2E_EMAIL).toBe(canonicalEmail);
    expect(step.env.CATALOG_ADMIN_E2E_PASSWORD).toBe(canonicalPassword);
    expect(Object.keys(step.env).filter((name) => /secrets\.|vars\./.test(step.env[name]))).toEqual([
      "CATALOG_ADMIN_E2E_EMAIL",
      "CATALOG_ADMIN_E2E_PASSWORD",
    ]);
  }
  expect(JSON.stringify(document)).not.toMatch(/SCRYDEX_|playwright/i);
  const [checkout, setup, prepare, receipt, upload, ...rest] = job.steps;
  expect(rest).toEqual([]);
  expect(checkout.with).toEqual({ "persist-credentials": false });
  expect(setup.uses).toBe("./.github/actions/setup-pnpm-workspace");
  expect(prepare.run).toBe("pnpm exec tsx scripts/catalog-staging-count-preparation.mjs run");
  expect(receipt.if).toBe("${{ always() && steps.prepare.outcome != 'skipped' }}");
  expect(receipt.run).toBe(
    `pnpm exec tsx scripts/catalog-staging-count-preparation.mjs validate --file ${receiptFile}`,
  );
  expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
  expect(upload.if).toBe("${{ always() && steps.receipt.outcome == 'success' }}");
  expect(upload.with.path).toBe(receiptFile);
  expect(upload.with["if-no-files-found"]).toBe("error");
}

function runAdmission(document, env) {
  const failures = [];
  runInNewContext(document.jobs["admit-reviewed-sha"].steps[0].with.script, {
    process: { env },
    core: { setFailed: (message) => failures.push(message) },
  });
  return failures;
}

describe("catalog staging count preparation workflow (#9591)", () => {
  it("isolates preparation: admission before job-local credentials, one validated receipt upload", () => {
    assertPreparationIsolated(workflow());
    const mutants = [
      (document) => delete document.jobs["prepare-counts"].needs,
      (document) => (document.jobs["prepare-counts"].if = "always()"),
      (document) => (document.jobs["prepare-counts"].env = { CATALOG_ADMIN_E2E_PASSWORD: canonicalPassword }),
      (document) => (document.jobs["prepare-counts"].steps[1].env = { CATALOG_ADMIN_E2E_PASSWORD: canonicalPassword }),
      (document) => (document.jobs["admit-reviewed-sha"].environment = "staging"),
      (document) => (document.jobs["prepare-counts"].steps[4].if = "always()"),
      (document) => (document.jobs["prepare-counts"].steps[4].with.path = "artifacts/catalog-count-preparation/"),
      (document) => (document.jobs["prepare-counts"].steps[2].env.SCRYDEX_API_KEY = "${{ secrets.SCRYDEX_API_KEY }}"),
      (document) =>
        document.jobs["prepare-counts"].steps.push({
          uses: "actions/upload-artifact@x",
          with: { path: "test-results" },
        }),
    ];
    for (const mutate of mutants) {
      const document = workflow();
      mutate(document);
      expect(() => assertPreparationIsolated(document), mutate.toString()).toThrow();
    }
  });

  it("executes the admission gate against confirmation, immutable SHA and exact staging origin", () => {
    const valid = {
      EXPECTED_SHA: sha,
      RUN_SHA: sha,
      CONFIRMATION: "prepare catalog staging counts",
      ADMIN_WEB_URL: origin,
    };
    expect(runAdmission(workflow(), valid)).toEqual([]);
    expect(runAdmission(workflow(), { ...valid, EXPECTED_SHA: sha.toUpperCase() })).toEqual([]);
    for (const patch of [
      { EXPECTED_SHA: "" },
      { EXPECTED_SHA: "b".repeat(40) },
      { EXPECTED_SHA: "main" },
      { CONFIRMATION: "prepare catalog staging count" },
      { ADMIN_WEB_URL: "https://admin.chasesets.com" },
      { ADMIN_WEB_URL: `${origin}/` },
    ])
      expect(runAdmission(workflow(), { ...valid, ...patch }), JSON.stringify(patch)).not.toEqual([]);
  });

  it("keeps UAT and capture unchanged and enrolls only shared staging registrations", () => {
    const uat = readFileSync(resolve(".github/workflows/catalog-staging-provider-uat.yml"), "utf8");
    expect(uat).not.toMatch(/count-preparation|counts\/(quote|acquire)/);
    expect(readFileSync(resolve("scripts/catalog-integration-reset.test.mjs"), "utf8")).toContain(
      `  "${workflowFile}",`,
    );
    expect(stagingRefreshOverlapWorkflowFiles).toContain(workflowFile);
    const fence = scanPlaywrightArtifactUploads();
    expect(fence.status).toBe("pass");
    expect(fence.uploads.filter((upload) => upload.file === workflowFile).map((upload) => upload.paths)).toEqual([
      [receiptFile],
    ]);
  });

  it("runbook assigns preparation before each pass's reservation and start and preserves R/C/G/D/I", () => {
    const runbook = readFileSync(resolve("docs/runbooks/catalog-game-provider-sync-operations.md"), "utf8");
    const preparation = runbook.indexOf("**Count preparation precedes each pass's reservation and start.**");
    const start = runbook.indexOf("1. **Start.** Dispatch `journey_scope=full-game-start`");
    expect(preparation).toBeGreaterThan(runbook.indexOf("### Whole-game rehearsal"));
    expect(preparation).toBeLessThan(start);
    const paragraph = runbook.slice(preparation, start);
    for (const phrase of [
      workflowFile,
      receiptFile,
      "Link the receipt in the domain packet",
      "R, C, G, D and I, the start refusals and every existing blocker are unchanged",
      "grants no preview, confirm or reservation authority",
      "never a top-up",
      "Pass 2 needs its own preparation authority",
    ])
      expect(paragraph).toContain(phrase);
  });
});

function countQueryFor(kind) {
  return scrydexCountQuery({
    environment: "staging",
    accountRevision: "synthetic",
    productDomain: "one-piece",
    profileKey: kind === "cards" ? "one-piece-card-print" : "one-piece-sealed-product",
    profileVersion: "2026.06.22",
    unitKey: `scrydex:one-piece:${kind === "cards" ? "single-card" : "sealed-product"}:source-observation-import`,
    kind,
    languageCode: "en",
    parentValue: "OP01",
  });
}

const quoteId = "00000000-0000-4000-8000-000000000001";
const quoted = {
  quoteId,
  fingerprint: "c".repeat(64),
  membershipFingerprint: "d".repeat(64),
  selection: { mode: "matching-scope", query: { productDomain: "one-piece", scopeKind: "set", languageCode: null } },
  authority: { fingerprint: "b".repeat(64), headroom: 40, allowed: true },
  targets: ["cards", "sealed"].map((kind) => ({
    scopeRecordId: "scope-op01",
    query: countQueryFor(kind),
    source: null,
    blocked: false,
  })),
  plannedCredits: 2,
  cap: 2,
  expiresAt: "2026-10-14T12:15:00.000Z",
  state: "quoted",
};
const acquired = {
  ...quoted,
  state: "complete",
  targets: quoted.targets.map((target, index) => ({
    ...target,
    source: {
      query: target.query,
      validationKind: "page-1-count",
      sourceId: `00000000-0000-4000-8000-00000000001${index}`,
      totalCount: index === 0 ? 121 : 7,
      pageSize: 100,
      returnedPage: 1,
      returnedItemCount: index === 0 ? 100 : 7,
      observedAt: now,
      expiresAt: "2026-10-14T12:15:00.000Z",
    },
  })),
};

// Credential-free stand-in for the staging Admin origin; no request leaves the process.
function fakeStagingAdmin({ signIn = () => Response.json({ sessionToken: token }) } = {}) {
  let state = quoted;
  const requests = [];
  const fetch = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    requests.push({
      origin: url.origin,
      method: init.method ?? "GET",
      path: url.pathname.replace(quoteId, ":id"),
      cookie: headers.get("cookie"),
      originHeader: headers.get("origin"),
      redirect: init.redirect,
    });
    if (url.pathname === "/api/auth/password-sign-in") return signIn();
    if (url.pathname.endsWith("/counts/quote")) return Response.json(quoted);
    if (url.pathname.endsWith("/counts/acquire")) {
      state = acquired;
      return Response.json(acquired);
    }
    if (url.pathname.endsWith(`/counts/quote/${quoteId}`)) return Response.json(state);
    return new Response(null, { status: 404 });
  });
  return { fetch, requests };
}

function runnerEnv(patch = {}) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_SHA: sha,
    EXPECTED_SHA: sha,
    GITHUB_RUN_ID: "123456",
    GITHUB_RUN_ATTEMPT: "1",
    ADMIN_WEB_URL: origin,
    CATALOG_COUNT_PREPARATION_MODE: "quote",
    CATALOG_COUNT_PREPARATION_DISPATCH_ID: "9224-pass1-one-piece",
    CATALOG_COUNT_PREPARATION_PASS: "1",
    CATALOG_COUNT_PREPARATION_PRODUCT_DOMAIN: "one-piece",
    CATALOG_COUNT_PREPARATION_LANGUAGE_CODE: "",
    CATALOG_COUNT_PREPARATION_CAP: "",
    CATALOG_COUNT_PREPARATION_APPROVAL: "",
    CATALOG_ADMIN_E2E_EMAIL: email,
    CATALOG_ADMIN_E2E_PASSWORD: password,
    ...patch,
  };
}

const approval = JSON.stringify({
  schemaVersion: rehearsalCountPreparationApprovalSchemaVersion,
  dispatchId: "9224-pass1-one-piece",
  approvalId: "host-approval-1",
  approvedAt: now,
  pass: { passNumber: 1, productDomain: "one-piece", languageCode: null, scopeKind: "set" },
  quote: {
    quoteId,
    fingerprint: quoted.fingerprint,
    membershipFingerprint: quoted.membershipFingerprint,
    expiresAt: quoted.expiresAt,
  },
  plannedCredits: 2,
  perKindCost: { cards: 1, sealed: 1 },
  cap: 2,
  authority: { fingerprint: quoted.authority.fingerprint, headroom: 40, observedAt: now },
});

describe("catalog staging count preparation runner (credential-free integration)", () => {
  it("quote mode signs in, quotes once on the staging origin and writes a validated count-only receipt", async () => {
    const admin = fakeStagingAdmin();
    const receiptPath = temporaryReceipt();
    const env = runnerEnv();
    const result = await runCountPreparation({ env, fetch: admin.fetch, now: () => now, receiptPath });
    expect(result).toMatchObject({
      ok: true,
      summary: { mode: "quote", outcome: "quoted", quote: { plannedCredits: 2 } },
    });
    expect(admin.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/auth/password-sign-in",
      "POST /api/catalog/scope-sync-batches/counts/quote",
    ]);
    expect(admin.requests.every((request) => request.origin === origin && request.redirect === "manual")).toBe(true);
    expect(admin.requests[1]).toMatchObject({ cookie: `chase_sets_session=${token}`, originHeader: origin });
    const bytes = readFileSync(receiptPath, "utf8");
    for (const secret of [token, email, password]) expect(bytes).not.toContain(secret);
    expect(validateCountPreparationFile({ file: receiptPath, env })).toMatchObject({ ok: true, errors: [] });
  });

  it("acquire mode submits the approved quote once and reads the retained quote once", async () => {
    const admin = fakeStagingAdmin();
    const receiptPath = temporaryReceipt();
    const env = runnerEnv({ CATALOG_COUNT_PREPARATION_MODE: "acquire", CATALOG_COUNT_PREPARATION_APPROVAL: approval });
    const result = await runCountPreparation({ env, fetch: admin.fetch, now: () => now, receiptPath });
    expect(result).toMatchObject({ ok: true, summary: { outcome: "complete", sources: 2, debits: 2 } });
    expect(admin.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/auth/password-sign-in",
      "GET /api/catalog/scope-sync-batches/counts/quote/:id",
      "POST /api/catalog/scope-sync-batches/counts/acquire",
      "GET /api/catalog/scope-sync-batches/counts/quote/:id",
    ]);
    expect(validateCountPreparationFile({ file: receiptPath, env }).ok).toBe(true);
    const replay = await runCountPreparation({ env, fetch: admin.fetch, now: () => now, receiptPath });
    expect(replay).toMatchObject({ ok: false, summary: { outcome: "refused", refusal: "quote-not-pending" } });
    expect(admin.requests.filter((request) => request.path.endsWith("/acquire"))).toHaveLength(1);
  });

  it("refuses before any request: missing keys, provider credentials, origin, SHA, mode and unbound approval", async () => {
    const cases = [
      [{ CATALOG_ADMIN_E2E_PASSWORD: "" }, "admin-credential-missing:CATALOG_ADMIN_E2E_PASSWORD"],
      [
        { CATALOG_ADMIN_E2E_EMAIL: " ", CATALOG_ADMIN_E2E_PASSWORD: "" },
        "admin-credential-missing:CATALOG_ADMIN_E2E_EMAIL,CATALOG_ADMIN_E2E_PASSWORD",
      ],
      [{ SCRYDEX_API_KEY: "synthetic-provider-key" }, "provider-credential-present"],
      [{ ADMIN_WEB_URL: "https://admin.chasesets.com" }, "staging-origin-required"],
      [{ EXPECTED_SHA: "b".repeat(40) }, "expected-sha-mismatch"],
      [{ GITHUB_ACTIONS: "" }, "github-actions-required"],
      [{ CATALOG_COUNT_PREPARATION_MODE: "preview" }, "mode-invalid"],
      [{ CATALOG_COUNT_PREPARATION_PRODUCT_DOMAIN: "digimon" }, "pass-invalid"],
      [{ CATALOG_COUNT_PREPARATION_APPROVAL: approval }, "approval-not-allowed-in-quote-mode"],
      [{ CATALOG_COUNT_PREPARATION_MODE: "acquire" }, "approval-invalid"],
      [
        {
          CATALOG_COUNT_PREPARATION_MODE: "acquire",
          CATALOG_COUNT_PREPARATION_APPROVAL: approval.replace('"pass":{"passNumber":1', '"pass":{"passNumber":2'),
        },
        "approval-pass-mismatch",
      ],
      [
        {
          CATALOG_COUNT_PREPARATION_MODE: "acquire",
          CATALOG_COUNT_PREPARATION_APPROVAL: approval,
          CATALOG_COUNT_PREPARATION_CAP: "2",
        },
        "cap-not-allowed-in-acquire-mode",
      ],
    ];
    for (const [patch, code] of cases) {
      const admin = fakeStagingAdmin();
      const receiptPath = temporaryReceipt();
      const error = await runCountPreparation({
        env: runnerEnv(patch),
        fetch: admin.fetch,
        now: () => now,
        receiptPath,
      }).catch((failure) => failure);
      expect(error?.code, code).toBe(code);
      expect(String(error?.message)).not.toContain(password);
      expect(admin.fetch).not.toHaveBeenCalled();
    }
  });

  it("never follows a sign-in redirect", async () => {
    const admin = fakeStagingAdmin({
      signIn: () => new Response(null, { status: 307, headers: { location: "https://elsewhere.invalid/sign-in" } }),
    });
    const error = await runCountPreparation({
      env: runnerEnv(),
      fetch: admin.fetch,
      now: () => now,
      receiptPath: temporaryReceipt(),
    }).catch((failure) => failure);
    expect(error.code).toBe("admin-sign-in-failed:307");
    expect(admin.requests).toHaveLength(1);
    expect(admin.requests[0].redirect).toBe("manual");
  });
});

describe("catalog staging count preparation pre-upload gate", () => {
  it("validates only the exact regular receipt bound to the run and free of admitted credential values", async () => {
    const receiptPath = temporaryReceipt();
    const env = runnerEnv();
    await runCountPreparation({ env, fetch: fakeStagingAdmin().fetch, now: () => now, receiptPath });
    expect(validateCountPreparationFile({ file: receiptPath, env }).ok).toBe(true);
    expect(validateCountPreparationFile({ file: `${receiptPath}.missing`, env })).toMatchObject({
      ok: false,
      errors: ["receipt-missing"],
    });
    expect(
      validateCountPreparationFile({ file: receiptPath, env: { ...env, GITHUB_RUN_ATTEMPT: "2" } }).errors,
    ).toContain("identity-mismatch:runAttempt");
    expect(validateCountPreparationFile({ file: receiptPath, env: { ...env, GITHUB_SHA: "" } }).errors).toContain(
      "GITHUB_SHA-required",
    );
    writeFileSync(
      receiptPath,
      readFileSync(receiptPath, "utf8").replace("9224-pass1-one-piece", "synthetic-password-value"),
    );
    const leaked = validateCountPreparationFile({ file: receiptPath, env });
    expect(leaked.ok).toBe(false);
    expect(leaked.errors).toContain("forbidden-value");
    expect(JSON.stringify(leaked)).not.toContain(password);
    writeFileSync(receiptPath, "");
    expect(validateCountPreparationFile({ file: receiptPath, env }).ok).toBe(false);
  });
});
