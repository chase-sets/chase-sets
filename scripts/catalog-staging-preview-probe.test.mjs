import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { catalogProviderIntegrationProfileVersions } from "../bounded-contexts/catalog/features/source-observations/api/providers/registry.ts";
import { catalogProviderProfileVersionIngestionUnitKey } from "../bounded-contexts/catalog/features/source-observations/api/providers/registry.ts";
import { listProviderScopeDiscoveryTargets } from "../bounded-contexts/catalog/features/provider-scope-discovery/api/discovery-targets.ts";
import { classifyProviderScopeDiscoveryTarget } from "../bounded-contexts/catalog/features/provider-scope-discovery/api/scope-observation-matcher.ts";
import { listCatalogProviderProfileVersionReviews } from "../bounded-contexts/catalog/features/source-observations/api/providers/provider-profile-review.ts";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../bounded-contexts/catalog/features/source-observations/ui/primary-workbench-read-model.ts";
import {
  buildScopeSyncBatchPreviewProbeReceipt,
  classifyScopeSyncBatchPreviewProbeRefresh,
  classifyScopeSyncBatchPreviewProbeRequest,
  deriveScopeSyncBatchPreviewProbeRoster,
  readScopeSyncBatchPreviewProbeDeployedRoster,
  scopeSyncBatchPreviewProbeArtifactPath,
  scopeSyncBatchPreviewProbeCredentialGate,
  scopeSyncBatchPreviewProbeFormIntent,
  scopeSyncBatchPreviewProbeJourneyScope,
  scopeSyncBatchPreviewProbeOriginGate,
  scopeSyncBatchPreviewProbeRows,
  summarizeScopeSyncBatchPreviewProbeInbox,
  summarizeScopeSyncBatchPreviewProbePreview,
  validateScopeSyncBatchPreviewProbeReceipt,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/preview-probe-receipt.ts";
import { validatePreviewProbeFile } from "./catalog-staging-preview-probe.mjs";
import {
  inspectPlaywrightArtifactUploadCorpus,
  scanPlaywrightArtifactUploads,
} from "./playwright-artifact-upload-fence.mjs";

const workflowFile = ".github/workflows/catalog-staging-provider-uat.yml";
const workflowSource = readFileSync(resolve(workflowFile), "utf8");
const identity = {
  sha: "a".repeat(40),
  runId: "123456",
  runAttempt: "1",
  retry: 0,
  journeyScope: scopeSyncBatchPreviewProbeJourneyScope,
  origin: "https://admin.staging.chasesets.com",
};
const expectedIdentity = { sha: identity.sha, runId: identity.runId, runAttempt: identity.runAttempt };
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workflow() {
  return parseYaml(workflowSource);
}

function resolveJourneyMatrix(source, scope) {
  const run = parseYaml(source).jobs["resolve-provider-uat-plan"].steps[0].run;
  for (const [, patterns, matrix] of run.matchAll(/^\s*([a-z0-9|*-]+)\)\s*\n\s*journey_matrix='([^']*)'/gm)) {
    if (patterns.split("|").includes(scope)) {
      return JSON.parse(matrix.replaceAll("${{ inputs.journey_scope }}", scope));
    }
  }
  return null;
}

function assertCredentialsThreaded(document) {
  const job = document.jobs["staging-provider-uat"];
  expect(job.env.CATALOG_ADMIN_E2E_EMAIL).toBe(
    "${{ vars.CATALOG_ADMIN_E2E_EMAIL || secrets.PLATFORM_ADMIN_EMAIL || '' }}",
  );
  expect(job.env.CATALOG_ADMIN_E2E_PASSWORD).toBe(
    "${{ secrets.CATALOG_ADMIN_E2E_PASSWORD || secrets.PLATFORM_ADMIN_PASSWORD || '' }}",
  );
  for (const step of job.steps) {
    for (const name of ["CATALOG_ADMIN_E2E_EMAIL", "CATALOG_ADMIN_E2E_PASSWORD"]) {
      expect(step.env?.[name], `${step.name ?? step.uses} must not override ${name}`).toBeUndefined();
    }
  }
}

function assertReceiptUploadGated(document) {
  const steps = document.jobs["staging-provider-uat"].steps;
  const runIndex = steps.findIndex((step) => step.id === "provider-uat");
  const validateIndex = steps.findIndex((step) => step.id === "preview-receipt");
  const uploads = steps.filter((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
  expect(runIndex).toBeGreaterThanOrEqual(0);
  expect(validateIndex).toBeGreaterThan(runIndex);
  const validate = steps[validateIndex];
  expect(validate.if).toContain("always()");
  expect(validate.if).toContain(`matrix.journey_scope == '${scopeSyncBatchPreviewProbeJourneyScope}'`);
  expect(validate.run).toBe(
    `pnpm exec tsx scripts/catalog-staging-preview-probe.mjs validate --file ${scopeSyncBatchPreviewProbeArtifactPath}`,
  );
  expect(uploads).toHaveLength(1);
  const upload = uploads[0];
  expect(steps.indexOf(upload)).toBeGreaterThan(validateIndex);
  expect(upload.if).toBe("${{ always() && steps.preview-receipt.outcome == 'success' }}");
  expect(upload.with.path).toBe(scopeSyncBatchPreviewProbeArtifactPath);
  expect(upload.with["if-no-files-found"]).toBe("error");
  expect(upload.with.name).toContain("${{ github.run_id }}-${{ github.run_attempt }}");
}

function preview(overrides = {}) {
  return {
    previewVersion: "scope-sync-batch-preview-v1",
    selection: {
      mode: "matching-scope",
      query: { productDomain: "pokemon", scopeKind: "expansion", languageCode: "en" },
    },
    budget: {
      maxScopesPerTurn: 1,
      defaultProviderConcurrency: 1,
      providerConcurrency: { scrydex: 1 },
      providerRequestLimits: { tcgdex: 1000, scrydex: 1000 },
      creditedProviderRequestLimits: { scrydex: 0 },
      providerFailureThreshold: 3,
    },
    planFingerprint: "fingerprint-1",
    status: "ready",
    confirmAllowed: true,
    counts: { scopes: 10, readyScopes: 10, blockedScopes: 0, providerUnits: 20 },
    providerUnitTotals: { tcgdex: 10, tcgplayer: 10 },
    providerRequestEstimates: { tcgdex: 20, tcgplayer: 10 },
    samples: [],
    blockers: [],
    resolvedAt: "2026-10-09T01:00:00.000Z",
    ...overrides,
  };
}

function previewResult(overrides = {}, rendered = undefined) {
  const response = preview(overrides);
  return summarizeScopeSyncBatchPreviewProbePreview({
    submitted: { productDomain: "pokemon", scopeKind: "expansion", languageCode: "en" },
    formBudget: { scrydexRequestLimit: "0" },
    response,
    error: null,
    renderedPlanFingerprint: rendered === undefined ? response.planFingerprint : rendered,
  });
}

const roster = deriveScopeSyncBatchPreviewProbeRoster(
  ["pokemon", "mtg", "yugioh", "one-piece", "lorcana"].map((domain) => ({
    providerKey: "tcgplayer",
    profileKey: "tcgplayer-synthetic",
    profileVersion: `${domain}-1`,
    ingestionUnitKey: `tcgplayer:${domain}:single-card:source-observation-import`,
    lifecycle: "active",
    active: true,
    profile: {
      capabilities: ["provider-option-query"],
      optionQueries: [{ queryKind: "sets", scope: "set-name", parentScope: null }],
    },
  })),
  "deployed-admin-profiles",
);

function refreshed(providerKey = "tcgplayer") {
  return classifyScopeSyncBatchPreviewProbeRefresh(
    {
      providerKey,
      clickedAt: "2026-10-09T00:00:00.000Z",
      before: { lastRunCompletedAt: "2026-10-08T00:00:00.000Z", lastRunStatus: "succeeded", lastRunError: null },
      after: { lastRunCompletedAt: "2026-10-09T00:00:05.000Z", lastRunStatus: "succeeded", lastRunError: null },
    },
    60_000,
  );
}

function inbox(totalCandidates = 4) {
  return summarizeScopeSyncBatchPreviewProbeInbox({
    generatedAt: "2026-10-09T00:00:00.000Z",
    counts: { totalGroups: 2, totalCandidates, highConfidenceCandidates: 1 },
  });
}

function receipt({ captures, rosterOverride = roster, identityOverride = identity, refusal = null } = {}) {
  return buildScopeSyncBatchPreviewProbeReceipt({
    identity: identityOverride,
    startedAt: "2026-10-09T00:00:00.000Z",
    finishedAt: "2026-10-09T00:10:00.000Z",
    roster: rosterOverride,
    captures:
      captures ??
      scopeSyncBatchPreviewProbeRows.map((row) => ({
        rowKey: row.rowKey,
        refresh: [refreshed()],
        inbox: inbox(),
        preview: previewResult(),
      })),
    providersClicked: ["tcgplayer"],
    fenceViolations: [],
    refusal,
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withPreview(rowKey, previewOutcome) {
  return receipt({
    captures: scopeSyncBatchPreviewProbeRows.map((row) => ({
      rowKey: row.rowKey,
      refresh: [refreshed()],
      inbox: inbox(),
      preview: row.rowKey === rowKey ? previewOutcome : previewResult(),
    })),
  });
}

function summarizeResponse(response) {
  return summarizeScopeSyncBatchPreviewProbePreview({
    submitted: { productDomain: "magic", scopeKind: "set", languageCode: null },
    formBudget: { scrydexRequestLimit: "0" },
    response,
    error: null,
    renderedPlanFingerprint: "fingerprint-1",
  });
}

function deletePath(target, path) {
  const segments = path.split(".");
  const last = segments.pop();
  delete segments.reduce((node, segment) => node[segment], target)[last];
}

const previewMetricFields = [
  "effectiveBudget",
  "selection",
  "confirmAllowed",
  "planFingerprint",
  "resolvedAt",
  "readyScopes",
  "blockedScopes",
  "participatingProviderUnits",
  "providerUnitTotals",
  "providerRequestEstimates",
  "blockerCounts",
];

function registryProfiles() {
  return catalogProviderIntegrationProfileVersions.map((version) => ({
    providerKey: version.providerKey,
    profileKey: version.profileKey,
    profileVersion: version.profileVersion,
    ingestionUnitKey: catalogProviderProfileVersionIngestionUnitKey(version),
    lifecycle: version.lifecycle,
    active: version.active,
    profile: version.profile,
  }));
}

// Profile reviews as the Catalog API lists them, composed by the same read-model
// builder the deployed daily and provider-detail loaders call, then serialized
// as the router hands loader data to the page.
async function registryReviews() {
  return listCatalogProviderProfileVersionReviews({
    listProfileVersions: async () => catalogProviderIntegrationProfileVersions,
    countProfileVersionReferences: async () => 0,
  });
}

function surfaceLoaderData(surface, requestUrl, reviews) {
  const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface(surface, {
    requestUrl,
    scopes: { items: [], total: 0, count: 0 },
    profileReviews: { items: reviews, total: reviews.length, count: reviews.length },
    controlPlaneOverview: null,
    canManageCatalog: true,
  });
  return clone({ route: { readModel } });
}

function providerDetailReader(reviews, reads, omittedUnitKey = null) {
  return async ({ providerKey, unitKey, profileVersion }) => {
    reads.push({ providerKey, unitKey, profileVersion });
    const url = new URL(`${identity.origin}/catalog/providers/${encodeURIComponent(providerKey)}`);
    url.searchParams.set("providerKey", providerKey);
    url.searchParams.set("unitKey", unitKey);
    if (profileVersion) url.searchParams.set("profileVersion", profileVersion);
    const visible =
      unitKey === omittedUnitKey ? reviews.filter((review) => review.ingestionUnitKey !== omittedUnitKey) : reviews;
    return surfaceLoaderData("health", url, visible);
  };
}

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "preview-probe-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("catalog staging Scope Sync Batch preview probe workflow (#9244)", () => {
  it("resolves the new selector to exactly its own isolated journey and keeps fan-outs unchanged", () => {
    const options = workflow().on.workflow_dispatch.inputs.journey_scope.options;
    expect(options).toContain(scopeSyncBatchPreviewProbeJourneyScope);
    expect(resolveJourneyMatrix(workflowSource, scopeSyncBatchPreviewProbeJourneyScope)).toEqual({
      include: [{ journey_scope: scopeSyncBatchPreviewProbeJourneyScope }],
    });
    for (const fanOut of ["m50-final-proof", "full-matrix-uat"]) {
      expect(JSON.stringify(resolveJourneyMatrix(workflowSource, fanOut))).not.toContain(
        scopeSyncBatchPreviewProbeJourneyScope,
      );
    }
    for (const option of options) expect(resolveJourneyMatrix(workflowSource, option), option).not.toBeNull();
    const withoutArm = workflowSource.replace("|scope-sync-batch-preview-probe)", ")");
    expect(resolveJourneyMatrix(withoutArm, scopeSyncBatchPreviewProbeJourneyScope)).toBeNull();
    expect(workflow().concurrency).toEqual({
      group: "platform-staging-mutating-operations",
      "cancel-in-progress": false,
    });
  });

  it("threads the existing admin credential mapping into the probe run and fails by name when withheld", () => {
    assertCredentialsThreaded(workflow());
    const run = workflow().jobs["staging-provider-uat"].steps.find((step) => step.id === "provider-uat");
    expect(run.run).toContain("deployables/admin-web/e2e/catalog-staging-provider-sync.uat.spec.ts");

    const withheld = workflow();
    delete withheld.jobs["staging-provider-uat"].env.CATALOG_ADMIN_E2E_PASSWORD;
    expect(() => assertCredentialsThreaded(withheld)).toThrow();
    const blanked = workflow();
    blanked.jobs["staging-provider-uat"].steps.find((step) => step.id === "provider-uat").env.CATALOG_ADMIN_E2E_EMAIL =
      "";
    expect(() => assertCredentialsThreaded(blanked)).toThrow();

    expect(scopeSyncBatchPreviewProbeCredentialGate({ email: "", password: "" })).toEqual({
      ok: false,
      reason: "admin-credential-missing:CATALOG_ADMIN_E2E_EMAIL,CATALOG_ADMIN_E2E_PASSWORD",
    });
    const named = scopeSyncBatchPreviewProbeCredentialGate({ email: "withheld-marker@example.invalid", password: " " });
    expect(named).toEqual({ ok: false, reason: "admin-credential-missing:CATALOG_ADMIN_E2E_PASSWORD" });
    expect(JSON.stringify(named)).not.toContain("withheld-marker");
    expect(scopeSyncBatchPreviewProbeCredentialGate({ email: "a@example.invalid", password: "p" })).toEqual({
      ok: true,
    });
  });

  it("uploads only the exact validated receipt and refuses directory, ungated and raw Playwright mutants", () => {
    assertReceiptUploadGated(workflow());
    const fence = scanPlaywrightArtifactUploads();
    expect(fence.status).toBe("pass");
    expect(fence.uploads.filter((upload) => upload.file === workflowFile).map((upload) => upload.paths)).toEqual([
      [scopeSyncBatchPreviewProbeArtifactPath],
    ]);

    const directory = workflow();
    directory.jobs["staging-provider-uat"].steps.at(-1).with.path = "artifacts/catalog-scale-probe";
    expect(() => assertReceiptUploadGated(directory)).toThrow();
    const ungated = workflow();
    ungated.jobs["staging-provider-uat"].steps.at(-1).if = "${{ always() }}";
    expect(() => assertReceiptUploadGated(ungated)).toThrow();
    const ignoreMissing = workflow();
    ignoreMissing.jobs["staging-provider-uat"].steps.at(-1).with["if-no-files-found"] = "ignore";
    expect(() => assertReceiptUploadGated(ignoreMissing)).toThrow();
    const corpus = Object.fromEntries(fence.census.files.map((file) => [file, readFileSync(resolve(file), "utf8")]));
    expect(inspectPlaywrightArtifactUploadCorpus(corpus).status).toBe("pass");
    corpus[workflowFile] = workflowSource.replace(
      `path: ${scopeSyncBatchPreviewProbeArtifactPath}`,
      "path: artifacts/playwright/test-results",
    );
    const raw = inspectPlaywrightArtifactUploadCorpus(corpus);
    expect(raw.status).toBe("fail");
    expect(raw.findings.map((finding) => finding.file)).toEqual([workflowFile]);
  });

  it("pre-upload validation refuses absent, masked, malformed, unbound and credential-bearing receipts", () => {
    const directory = temporaryDirectory();
    const file = join(directory, "catalog-scale-probe", "preview.json");
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: identity.sha,
      GITHUB_RUN_ID: identity.runId,
      GITHUB_RUN_ATTEMPT: identity.runAttempt,
      CATALOG_ADMIN_E2E_EMAIL: "probe-admin@example.invalid",
      CATALOG_ADMIN_E2E_PASSWORD: "probe-password-marker-9244",
    };
    expect(validatePreviewProbeFile({ file, env }).errors).toEqual([`receipt file ${file} is missing`]);

    mkdirSync(join(directory, "catalog-scale-probe"), { recursive: true });
    writeFileSync(join(directory, "catalog-scale-probe", "diagnostic.txt"), "nonempty directory, absent payload");
    expect(validatePreviewProbeFile({ file, env }).ok).toBe(false);

    writeFileSync(file, "{not json");
    expect(validatePreviewProbeFile({ file, env }).errors).toEqual([`receipt file ${file} is not readable JSON`]);

    writeFileSync(file, JSON.stringify(receipt()));
    expect(validatePreviewProbeFile({ file, env })).toMatchObject({
      ok: true,
      summary: { captureStatus: "complete", rows: 6 },
    });
    expect(validatePreviewProbeFile({ file, env: { ...env, GITHUB_SHA: "b".repeat(40) } }).errors).toContain(
      "identity.sha is not the admitted SHA",
    );
    expect(validatePreviewProbeFile({ file, env: { ...env, GITHUB_RUN_ATTEMPT: "2" } }).errors).toContain(
      "identity.runAttempt is not this attempt",
    );
    expect(validatePreviewProbeFile({ file, env: { ...env, GITHUB_RUN_ID: "" } }).errors).toContain(
      "GITHUB_RUN_ID is required to bind the receipt",
    );

    const leaked = receipt();
    leaked.rows[0].preview.blockers.push({ code: "x", providerKey: null, message: env.CATALOG_ADMIN_E2E_PASSWORD });
    writeFileSync(file, JSON.stringify(leaked));
    const result = validatePreviewProbeFile({ file, env });
    expect(result.errors).toContain("receipt contains a forbidden value");
    expect(JSON.stringify(result)).not.toContain(env.CATALOG_ADMIN_E2E_PASSWORD);
  });

  it("finds credential values in decoded receipt text, so JSON escaping cannot hide them", () => {
    const file = join(temporaryDirectory(), "preview.json");
    const env = (password) => ({
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: identity.sha,
      GITHUB_RUN_ID: identity.runId,
      GITHUB_RUN_ATTEMPT: identity.runAttempt,
      CATALOG_ADMIN_E2E_EMAIL: "probe-admin@example.invalid",
      CATALOG_ADMIN_E2E_PASSWORD: password,
    });
    const rejects = (leaked, password) => {
      writeFileSync(file, JSON.stringify(leaked));
      const result = validatePreviewProbeFile({ file, env: env(password) });
      expect(result.ok, JSON.stringify(password)).toBe(false);
      expect(result.errors).toContain("receipt contains a forbidden value");
      const printed = JSON.stringify({ ok: result.ok, summary: result.summary, errors: result.errors }, null, 2);
      expect(printed.includes(password) || printed.includes(JSON.stringify(password).slice(1, -1))).toBe(false);
      return result;
    };

    // The plain control and the quote/backslash markers survive the real
    // refusal summarizer into the receipt; all three must be refused.
    for (const password of ["PlainProbeMarker9244", 'Quote"ProbeMarker9244', "Back\\slash\\ProbeMarker9244"]) {
      const refused = summarizeScopeSyncBatchPreviewProbePreview({
        submitted: { productDomain: "magic", scopeKind: "set", languageCode: null },
        formBudget: {},
        response: null,
        error: `Admin rejected sign-in for ${password}`,
        renderedPlanFingerprint: null,
      });
      expect(refused.reason).toContain(password);
      const leaked = withPreview("magic", refused);
      expect(JSON.stringify(leaked)).toContain("ProbeMarker9244");
      rejects(leaked, password);
    }
    // Newline, tab and control characters are escaped in JSON too.
    for (const password of ["New\nLine\tProbeMarker9244", "Control\u0001ProbeMarker9244"]) {
      const leaked = clone(receipt());
      leaked.rows[0].preview.formBudget.note = `value ${password} value`;
      rejects(leaked, password);
    }
    // A marker used as a key is found, and a forbidden-looking key carrying it is never echoed.
    const keyed = clone(receipt());
    keyed.rows[0].preview.formBudget['Key"ProbeMarker9244'] = "1";
    rejects(keyed, 'Key"ProbeMarker9244');
    const secretKeyed = clone(receipt());
    secretKeyed.rows[0].preview.formBudget['Secret"ProbeMarker9244'] = "1";
    expect(rejects(secretKeyed, 'Secret"ProbeMarker9244').errors).toContain("receipt contains a forbidden key");
    // Short supplied values are not exempt.
    const short = clone(receipt());
    short.rows[0].preview.formBudget.note = "q7";
    rejects(short, "q7");

    writeFileSync(file, JSON.stringify(receipt()));
    expect(validatePreviewProbeFile({ file, env: env('Quote"ProbeMarker9244') })).toMatchObject({
      ok: true,
      errors: [],
    });
  });
});

describe("Scope Sync Batch preview probe receipt (#9244)", () => {
  it("accepts a complete six-row capture bound to its SHA, run, attempt and retry", () => {
    const complete = receipt();
    expect(complete.captureStatus).toBe("complete");
    expect(validateScopeSyncBatchPreviewProbeReceipt(complete, expectedIdentity)).toEqual({ ok: true, errors: [] });
    expect(complete.rows.map((row) => [row.rowKey, row.productDomain, row.scopeKind, row.languageCode])).toEqual([
      ["magic", "magic", "set", null],
      ["pokemon-en", "pokemon", "expansion", "en"],
      ["pokemon-ja", "pokemon", "expansion", "ja"],
      ["yugioh", "yugioh", "set", null],
      ["one-piece", "one-piece", "set", null],
      ["lorcana", "lorcana", "set", null],
    ]);
    expect(complete.rows.find((row) => row.rowKey === "pokemon-ja").gaps).toContain("discovery-language-gap:ja");
    for (const field of ["sha", "runId", "runAttempt", "retry"]) {
      const unbound = clone(complete);
      delete unbound.identity[field];
      expect(validateScopeSyncBatchPreviewProbeReceipt(unbound).ok, field).toBe(false);
    }
  });

  it("records empty, blocked, stale and refused previews honestly", () => {
    const empty = previewResult({
      status: "empty",
      confirmAllowed: false,
      counts: { scopes: 0, readyScopes: 0, blockedScopes: 0, providerUnits: 0 },
      blockers: [
        {
          code: "empty-selection",
          scopeRecordId: null,
          providerKey: null,
          message: "No eligible active Catalog Scope Records matched this selection.",
        },
      ],
    });
    expect(empty.eligibleScopeRecords).toEqual({
      count: 0,
      completeness: "complete",
      zeroReason: "No eligible active Catalog Scope Records matched this selection.",
    });
    const blocked = previewResult({
      status: "blocked",
      confirmAllowed: false,
      providerRequestEstimates: { scrydex: 24, tcgplayer: 10 },
      blockers: [
        {
          code: "credited-provider-budget-exceeded",
          scopeRecordId: null,
          providerKey: "scrydex",
          message: "scrydex estimated requests (24) exceed the configured batch limit (0).",
        },
      ],
    });
    expect(blocked.scrydex).toEqual({
      participating: true,
      requestEstimate: 24,
      creditLimit: 0,
      refusal: "scrydex estimated requests (24) exceed the configured batch limit (0).",
    });
    expect(previewResult().scrydex).toMatchObject({ participating: false, requestEstimate: null });
    expect(previewResult({}, "other-fingerprint")).toMatchObject({
      status: "stale",
      reason: "rendered-plan-fingerprint-mismatch",
    });
    const refused = summarizeScopeSyncBatchPreviewProbePreview({
      submitted: { productDomain: "magic", scopeKind: "set", languageCode: null },
      formBudget: {},
      response: null,
      error: "Catalog API failed at https://api.staging.example.invalid/x for admin@example.invalid",
      renderedPlanFingerprint: null,
    });
    expect(refused.status).toBe("refused");
    expect(refused.reason).toBe("Catalog API failed at [url] for [email]");
    expect(refused.eligibleScopeRecords).toEqual({ count: null, completeness: "unknown", zeroReason: null });

    const staleRows = receipt({
      captures: scopeSyncBatchPreviewProbeRows.map((row) => ({
        rowKey: row.rowKey,
        refresh: [refreshed()],
        inbox: inbox(),
        preview: row.rowKey === "magic" ? previewResult({}, null) : previewResult(),
      })),
    });
    expect(staleRows.captureStatus).toBe("incomplete");
    expect(staleRows.incompleteReasons).toEqual(["magic:preview-stale"]);
  });

  it("marks 5000 Scope Records and 1000 inbox proposals as caps, never totals", () => {
    const capped = previewResult({
      counts: { scopes: 5000, readyScopes: 5000, blockedScopes: 0, providerUnits: 9000 },
    });
    expect(capped.eligibleScopeRecords).toEqual({ count: 5000, completeness: "capped", zeroReason: null });
    expect(inbox(1000)).toMatchObject({ completeness: "capped", candidatesRead: 1000, languageSpecific: false });
    const forged = receipt({
      captures: scopeSyncBatchPreviewProbeRows.map((row) => ({
        rowKey: row.rowKey,
        refresh: [refreshed()],
        inbox: inbox(1000),
        preview: capped,
      })),
    });
    expect(validateScopeSyncBatchPreviewProbeReceipt(forged, expectedIdentity).ok).toBe(true);
    const asTotal = clone(forged);
    asTotal.rows[0].preview.eligibleScopeRecords.completeness = "complete";
    asTotal.rows[1].inbox.completeness = "within-bound";
    expect(validateScopeSyncBatchPreviewProbeReceipt(asTotal, expectedIdentity).errors).toEqual([
      "row magic matching-scope count at the bound must be capped",
      "row pokemon-en inbox at the row bound must be capped",
    ]);
  });

  it("keeps EN and JA Pokemon rows on one shared Scope Record set", () => {
    const shared = receipt();
    expect(shared.rows.find((row) => row.rowKey === "pokemon-en").scopeRecordSet.sharedWith).toBe("pokemon-ja");
    expect(shared.rows.find((row) => row.rowKey === "pokemon-ja").scopeRecordSet.sharedWith).toBe("pokemon-en");
    const unshared = clone(shared);
    unshared.rows.find((row) => row.rowKey === "pokemon-ja").scopeRecordSet.sharedWith = null;
    expect(validateScopeSyncBatchPreviewProbeReceipt(unshared, expectedIdentity).errors).toEqual([
      "row pokemon-ja must declare its shared Scope Record set",
    ]);
  });

  it("rejects missing or duplicate rows and a hand-set complete status over unread sources", () => {
    const missing = receipt({
      captures: scopeSyncBatchPreviewProbeRows
        .filter((row) => row.rowKey !== "lorcana")
        .map((row) => ({ rowKey: row.rowKey, refresh: [refreshed()], inbox: inbox(), preview: previewResult() })),
    });
    expect(missing.captureStatus).toBe("incomplete");
    expect(missing.incompleteReasons).toEqual([
      "lorcana:refresh-unknown:tcgplayer",
      "lorcana:inbox-unread",
      "lorcana:preview-unknown",
    ]);
    const forged = clone(missing);
    forged.captureStatus = "complete";
    forged.incompleteReasons = [];
    expect(validateScopeSyncBatchPreviewProbeReceipt(forged, expectedIdentity).errors).toContain(
      "complete capture has an unread source in row lorcana",
    );

    const dropped = clone(receipt());
    dropped.rows.pop();
    expect(validateScopeSyncBatchPreviewProbeReceipt(dropped, expectedIdentity).errors).toEqual(
      expect.arrayContaining(["rows must be the six unique probe rows", "row lorcana is missing"]),
    );
    const duplicated = clone(receipt());
    duplicated.rows[5] = clone(duplicated.rows[0]);
    expect(validateScopeSyncBatchPreviewProbeReceipt(duplicated, expectedIdentity).errors).toContain(
      "rows must be the six unique probe rows",
    );
  });

  it("treats failed, swallowed and stale refreshes as not refreshed", () => {
    const base = {
      providerKey: "scrydex",
      clickedAt: "2026-10-09T00:00:00.000Z",
      before: { lastRunCompletedAt: "2026-10-08T00:00:00.000Z", lastRunStatus: "succeeded", lastRunError: null },
    };
    expect(classifyScopeSyncBatchPreviewProbeRefresh({ ...base, after: base.before }, 60_000)).toMatchObject({
      status: "unknown",
      reason: "last-run-not-after-click",
    });
    expect(
      classifyScopeSyncBatchPreviewProbeRefresh(
        {
          ...base,
          before: null,
          after: { lastRunCompletedAt: "2026-10-08T23:00:00.000Z", lastRunStatus: "succeeded", lastRunError: null },
        },
        60_000,
      ),
    ).toMatchObject({ status: "unknown", reason: "last-run-not-after-click" });
    expect(
      classifyScopeSyncBatchPreviewProbeRefresh(
        {
          ...base,
          after: {
            lastRunCompletedAt: "2026-10-09T00:00:09.000Z",
            lastRunStatus: "failed",
            lastRunError: "timeout calling https://api.scrydex.example.invalid/sets",
          },
        },
        60_000,
      ),
    ).toMatchObject({ status: "failed", reason: "timeout calling [url]" });
    const failedRow = receipt({
      captures: scopeSyncBatchPreviewProbeRows.map((row) => ({
        rowKey: row.rowKey,
        refresh: [{ ...refreshed(), status: "failed", reason: "timeout" }],
        inbox: inbox(),
        preview: previewResult(),
      })),
    });
    expect(failedRow.captureStatus).toBe("complete");
    expect(failedRow.rows[0].gaps).toContain("refresh-failed:tcgplayer");
  });

  it("refuses zero-inferred Scrydex spend, unmeasured wall-clock rates, credential keys and retried captures", () => {
    const zero = clone(receipt());
    zero.spendDisclosure.scrydexLiveCallCount = 0;
    expect(validateScopeSyncBatchPreviewProbeReceipt(zero, expectedIdentity).errors).toEqual([
      "scrydexLiveCallCount must stay unknown",
    ]);
    const rate = clone(receipt());
    rate.rows[0].preview.wallClock = { estimate: "PT2H", rate: null, reason: "concurrency 1" };
    expect(validateScopeSyncBatchPreviewProbeReceipt(rate, expectedIdentity).errors).toEqual([
      "row magic wall-clock estimate needs a measured rate",
    ]);
    const keyed = clone(receipt());
    keyed.rows[0].preview.formBudget.password = "x";
    expect(validateScopeSyncBatchPreviewProbeReceipt(keyed, expectedIdentity).errors).toContain(
      "receipt contains forbidden key 'password'",
    );
    const retried = receipt({ identityOverride: { ...identity, retry: 1 }, refusal: "retry-refused" });
    expect(retried.captureStatus).toBe("incomplete");
    const forgedRetry = clone(retried);
    forgedRetry.captureStatus = "complete";
    forgedRetry.incompleteReasons = [];
    expect(validateScopeSyncBatchPreviewProbeReceipt(forgedRetry, expectedIdentity).errors).toContain(
      "complete capture must come from the first attempt",
    );
  });

  it("never emits truncated or malformed preview metrics as a complete capture", () => {
    const required = [
      "status",
      "selection",
      "budget",
      "planFingerprint",
      "resolvedAt",
      "confirmAllowed",
      "counts.scopes",
      "counts.readyScopes",
      "counts.blockedScopes",
      "counts.providerUnits",
      "providerUnitTotals",
      "providerRequestEstimates",
      "blockers",
    ];
    const expectUnknownButUploadable = (result, reason) => {
      expect(result).toMatchObject({ status: "unknown", reason });
      expect(result.eligibleScopeRecords).toEqual({ count: null, completeness: "unknown", zeroReason: null });
      expect(result.scrydex).toEqual({ participating: null, requestEstimate: null, creditLimit: null, refusal: null });
      const truncated = withPreview("magic", result);
      expect(truncated.captureStatus).toBe("incomplete");
      expect(truncated.incompleteReasons).toEqual(["magic:preview-unknown"]);
      const serialized = clone(truncated).rows[0].preview;
      for (const field of previewMetricFields) expect(serialized, field).toHaveProperty(field, null);
      expect(validateScopeSyncBatchPreviewProbeReceipt(truncated, expectedIdentity)).toEqual({ ok: true, errors: [] });
    };

    for (const field of required) {
      const response = preview();
      deletePath(response, field);
      expectUnknownButUploadable(summarizeResponse(response), `preview-response-missing:${field}`);
    }
    const truncated = preview();
    delete truncated.counts.providerUnits;
    delete truncated.providerUnitTotals;
    delete truncated.providerRequestEstimates;
    expectUnknownButUploadable(
      summarizeResponse(truncated),
      "preview-response-missing:counts.providerUnits,providerUnitTotals,providerRequestEstimates",
    );
    const malformed = [
      ["counts.providerUnits", { counts: { scopes: 10, readyScopes: 10, blockedScopes: 0, providerUnits: -1 } }],
      ["counts.readyScopes", { counts: { scopes: 10, readyScopes: "10", blockedScopes: 0, providerUnits: 20 } }],
      ["providerUnitTotals", { providerUnitTotals: { tcgplayer: "10" } }],
      ["providerUnitTotals", { providerUnitTotals: null }],
      ["providerRequestEstimates", { providerRequestEstimates: [] }],
      ["providerRequestEstimates", { providerRequestEstimates: { tcgplayer: 1.5 } }],
      ["budget", { budget: { ...preview().budget, creditedProviderRequestLimits: { scrydex: -1 } } }],
      ["blockers", { blockers: [{ code: "empty-selection" }] }],
    ];
    for (const [field, overrides] of malformed) {
      expectUnknownButUploadable(summarizeResponse(preview(overrides)), `preview-response-missing:${field}`);
    }
    // An unknown Scrydex estimate inside a complete map stays an explicit null.
    expect(previewResult({ providerRequestEstimates: { scrydex: null, tcgplayer: 10 } }).scrydex).toMatchObject({
      participating: true,
      requestEstimate: null,
    });

    const complete = receipt();
    expect(validateScopeSyncBatchPreviewProbeReceipt(complete, expectedIdentity)).toEqual({ ok: true, errors: [] });
    for (const field of ["participatingProviderUnits", "providerUnitTotals", "providerRequestEstimates"]) {
      const omitted = clone(complete);
      delete omitted.rows[0].preview[field];
      expect(validateScopeSyncBatchPreviewProbeReceipt(omitted, expectedIdentity).errors).toEqual(
        expect.arrayContaining([`row magic preview omits ${field}`]),
      );
      const nulled = clone(complete);
      nulled.rows[0].preview[field] = null;
      expect(validateScopeSyncBatchPreviewProbeReceipt(nulled, expectedIdentity).errors).toEqual([
        `row magic captured preview lacks ${field}`,
      ]);
    }
    const reported = clone(withPreview("magic", summarizeResponse(truncated)));
    reported.rows[0].preview.providerUnitTotals = { tcgplayer: 0 };
    expect(validateScopeSyncBatchPreviewProbeReceipt(reported, expectedIdentity).errors).toEqual([
      "row magic uncaptured preview reports providerUnitTotals",
    ]);
    // A stale preview keeps its metrics and remains an uploadable incomplete receipt.
    expect(
      validateScopeSyncBatchPreviewProbeReceipt(withPreview("magic", previewResult({}, null)), expectedIdentity),
    ).toEqual({ ok: true, errors: [] });
  });

  it("keeps a registry-fallback roster incomplete", () => {
    const fallback = receipt({ rosterOverride: { ...roster, source: "registry-at-admitted-sha" } });
    expect(fallback.captureStatus).toBe("incomplete");
    expect(fallback.incompleteReasons).toContain("magic:roster-not-from-deployed-admin");
  });
});

describe("Scope Sync Batch preview probe roster and fence (#9244)", () => {
  it("partitions every active production-capable registry unit with the runtime's discovery derivation", () => {
    const profiles = catalogProviderIntegrationProfileVersions.map((version) => ({
      providerKey: version.providerKey,
      profileKey: version.profileKey,
      profileVersion: version.profileVersion,
      ingestionUnitKey: catalogProviderProfileVersionIngestionUnitKey(version),
      lifecycle: version.lifecycle,
      active: version.active,
      profile: version.profile,
    }));
    const derived = deriveScopeSyncBatchPreviewProbeRoster(profiles, "registry-at-admitted-sha");
    const production = new Set(
      profiles
        .filter((profile) => profile.lifecycle === "active" && profile.active)
        .map((profile) => profile.ingestionUnitKey),
    );
    expect(derived.units.length).toBeGreaterThan(0);
    for (const unit of derived.units) {
      expect(production.has(unit.unitKey), unit.unitKey).toBe(true);
      expect(["magic", "pokemon", "yugioh", "one-piece", "lorcana"]).toContain(unit.productDomain);
    }
    const runtimeProviders = new Set(
      listProviderScopeDiscoveryTargets(catalogProviderIntegrationProfileVersions, classifyProviderScopeDiscoveryTarget)
        .filter((target) => derived.units.some((unit) => unit.unitKey === target.ingestionUnitKey))
        .map((target) => target.providerKey),
    );
    expect(derived.discoveryProviders).toEqual([...runtimeProviders].sort());
    expect(new Set(derived.units.flatMap((unit) => unit.discoveryLanguages))).toEqual(new Set(["en"]));
    for (const domain of ["magic", "pokemon", "yugioh", "one-piece", "lorcana"]) {
      expect(
        derived.units.some((unit) => unit.productDomain === domain),
        domain,
      ).toBe(true);
    }
  });

  it("derives deployed coverage of every production-capable unit from the canonical daily and provider-detail read models", async () => {
    const reviews = await registryReviews();
    const registry = deriveScopeSyncBatchPreviewProbeRoster(registryProfiles(), "registry-at-admitted-sha");
    const daily = surfaceLoaderData("daily", `${identity.origin}/catalog/integrations`, reviews);
    const reads = [];
    const deployed = await readScopeSyncBatchPreviewProbeDeployedRoster(daily, providerDetailReader(reviews, reads));

    expect(deployed.source).toBe("deployed-admin-profiles");
    expect(deployed.unresolvedUnits).toEqual([]);
    expect(deployed.units).toEqual(registry.units);
    expect(deployed.discoveryProviders).toEqual(registry.discoveryProviders);
    expect(deployed.discoveryProviders.length).toBeGreaterThan(1);
    for (const unit of registry.units) {
      expect(
        reads.some((read) => read.unitKey === unit.unitKey && read.profileVersion),
        unit.unitKey,
      ).toBe(true);
    }
    // One Run now per discovered provider covers every row it serves.
    const complete = receipt({
      rosterOverride: deployed,
      captures: scopeSyncBatchPreviewProbeRows.map((row) => ({
        rowKey: row.rowKey,
        refresh: [
          ...new Set(
            deployed.units
              .filter((unit) => unit.productDomain === row.productDomain && unit.disposition === "discovery-target")
              .map((unit) => unit.providerKey),
          ),
        ].map((providerKey) => refreshed(providerKey)),
        inbox: inbox(),
        preview: previewResult(),
      })),
    });
    expect(complete.captureStatus, complete.incompleteReasons.join("; ")).toBe("complete");

    // The raw-profile shape the earlier synthetic Admin invented is not a deployed inventory.
    const rawProfiles = clone({ route: { readModel: { profiles: registryProfiles() } } });
    expect(
      await readScopeSyncBatchPreviewProbeDeployedRoster(rawProfiles, providerDetailReader(reviews, [])),
    ).toBeNull();
  });

  it("keeps a deployed unit whose provider detail omits its profile unresolved and the capture incomplete", async () => {
    const reviews = await registryReviews();
    const registry = deriveScopeSyncBatchPreviewProbeRoster(registryProfiles(), "registry-at-admitted-sha");
    const omitted = registry.units.find((unit) => unit.disposition === "discovery-target");
    const daily = surfaceLoaderData("daily", `${identity.origin}/catalog/integrations`, reviews);
    const deployed = await readScopeSyncBatchPreviewProbeDeployedRoster(
      daily,
      providerDetailReader(reviews, [], omitted.unitKey),
    );

    expect(deployed.unresolvedUnits).toEqual([
      {
        providerKey: omitted.providerKey,
        unitKey: omitted.unitKey,
        productDomain: omitted.productDomain,
        reason: expect.stringMatching(/^provider-detail-profile-/),
      },
    ]);
    expect(deployed.units.map((unit) => unit.unitKey)).not.toContain(omitted.unitKey);
    const partial = receipt({ rosterOverride: deployed });
    expect(partial.captureStatus).toBe("incomplete");
    const omittedRows = scopeSyncBatchPreviewProbeRows.filter((row) => row.productDomain === omitted.productDomain);
    expect(partial.incompleteReasons).toEqual(
      expect.arrayContaining(omittedRows.map((row) => `${row.rowKey}:roster-unresolved:${omitted.unitKey}`)),
    );
    const forged = clone(partial);
    forged.captureStatus = "complete";
    forged.incompleteReasons = [];
    expect(validateScopeSyncBatchPreviewProbeReceipt(forged, expectedIdentity).errors).toContain(
      `complete capture has an unread source in row ${omittedRows[0].rowKey}`,
    );
  });

  it("allows only preview and run-now writes and refuses every execution intent", () => {
    const origin = "https://admin.staging.chasesets.com";
    const allowed = (path, intent, method = "POST") =>
      classifyScopeSyncBatchPreviewProbeRequest({ method, url: `${origin}${path}`, formIntent: intent }).allowed;
    expect(allowed("/catalog/scopes/sync-batches", "preview")).toBe(true);
    expect(allowed("/catalog/providers/scrydex", "run-provider-refresh")).toBe(true);
    expect(allowed("/catalog/scopes/sync-batches", null, "GET")).toBe(true);
    for (const intent of ["confirm", "retry-unit", "cancel", "resume", "resolve-held-sets", null]) {
      expect(allowed("/catalog/scopes/sync-batches", intent), String(intent)).toBe(false);
    }
    for (const intent of ["pause-provider-refresh", "resume-provider-refresh", "preview"]) {
      expect(allowed("/catalog/providers/scrydex", intent), intent).toBe(false);
    }
    expect(allowed("/catalog/scopes/sync-batches.data", "confirm")).toBe(false);
    expect(allowed("/api/catalog/scope-sync-batches/confirm", null)).toBe(false);
    expect(allowed("/access/sign-in", null)).toBe(true);
    expect(allowed("/accessories/catalog/scopes/sync-batches", "confirm")).toBe(false);
    expect(
      scopeSyncBatchPreviewProbeFormIntent("intent=confirm&planFingerprint=x", "application/x-www-form-urlencoded"),
    ).toBe("confirm");
    expect(scopeSyncBatchPreviewProbeFormIntent("_intent=run-provider-refresh&providerKey=x", null)).toBe(
      "run-provider-refresh",
    );
    expect(
      scopeSyncBatchPreviewProbeFormIntent(
        '--b\r\nContent-Disposition: form-data; name="intent"\r\n\r\nconfirm\r\n--b--',
        "multipart/form-data; boundary=b",
      ),
    ).toBe("confirm");
  });

  it("refuses non-staging origins before sign-in", () => {
    expect(scopeSyncBatchPreviewProbeOriginGate("https://admin.staging.chasesets.com")).toEqual({ ok: true });
    for (const origin of [
      "https://admin.chasesets.com",
      "http://admin.staging.chasesets.com",
      "https://evil.example/staging.chasesets.com",
      "not a url",
    ]) {
      expect(scopeSyncBatchPreviewProbeOriginGate(origin).ok, origin).toBe(false);
    }
  });
});
