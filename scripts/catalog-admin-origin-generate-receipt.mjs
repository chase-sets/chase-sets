import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

export const catalogAdminOriginGenerateJourneyScope = "admin-origin-generate-probe";
export const catalogAdminOriginGenerateSchemaVersion = "catalog-admin-origin-generate/v1";
export const catalogAdminOriginGeneratePath = "/api/catalog/source-observations/merge-candidates/generate";
export const catalogAdminOriginGeneratePagePath = "/catalog/integrations";
export const catalogAdminOriginGenerateArtifactPath = "artifacts/catalog-admin-origin-generate/receipt.json";
export const catalogAdminOriginGenerateReservedParents = Object.freeze([
  "job_01M5N5MCJ3JET0GSZ32EJ63BA0",
  "job_01M5ZZ47714K5B1MVKSTYB2BNB",
  "job_01M60J47A1643F0NMN020WC3S3",
  "ref_seed_set_time_spiral",
]);

const receiptFields = Object.freeze([
  "schemaVersion",
  "journeyScope",
  "runId",
  "expectedSha",
  "adminWebUrl",
  "origin",
  "pagePath",
  "scratchParent",
  "requestBody",
  "hostClockBeforeEvaluate",
  "requestStartedAt",
  "responseCompletedAt",
  "hostClockAfterEvaluate",
  "clientTiming",
  "url",
  "status",
  "headers",
  "bodyBytes",
  "bodySha256",
  "body",
  "jsonParse",
  "json",
  "observationCount",
  "candidateCount",
  "creditedProviderSpend",
  "error",
]);

const sensitiveHeaderPattern = /(?:authorization|cookie|set-cookie|token|secret|password|api[-_]key)/i;
const sha256 = (value) => createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isIsoDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const isInteger = (value) => Number.isInteger(value) && value >= 0;

export function isCatalogAdminOriginGenerateScratchParent(value) {
  return (
    typeof value === "string" &&
    /^job_[A-Z0-9]{26}$/.test(value) &&
    !catalogAdminOriginGenerateReservedParents.includes(value)
  );
}

export function catalogAdminOriginGenerateRequestBody(scratchParent) {
  return JSON.stringify({ syncRunId: scratchParent });
}

function expectedFromEnvironment(overrides = {}) {
  return {
    expectedSha: (overrides.expectedSha ?? process.env.EXPECTED_SHA ?? process.env.GITHUB_SHA ?? "").toLowerCase(),
    adminWebUrl: overrides.adminWebUrl ?? process.env.ADMIN_WEB_URL ?? "https://admin.staging.chasesets.com",
    journeyScope:
      overrides.journeyScope ??
      process.env.CATALOG_STAGING_PROVIDER_UAT_SCOPE ??
      catalogAdminOriginGenerateJourneyScope,
    scratchParent: overrides.scratchParent ?? process.env.CATALOG_ADMIN_ORIGIN_GENERATE_SCRATCH_PARENT ?? "",
    runId: overrides.runId ?? process.env.GITHUB_RUN_ID ?? "",
  };
}

export function validateCatalogAdminOriginGenerateReceipt(receipt, overrides = {}) {
  const expected = expectedFromEnvironment(overrides);
  const errors = [];
  if (!isRecord(receipt)) return ["receipt must be an object"];

  const actualFields = Object.keys(receipt).sort();
  const requiredFields = [...receiptFields].sort();
  if (JSON.stringify(actualFields) !== JSON.stringify(requiredFields))
    errors.push("receipt fields must match the exact v1 contract");
  if (receipt.schemaVersion !== catalogAdminOriginGenerateSchemaVersion) errors.push("schemaVersion mismatch");
  if (receipt.journeyScope !== catalogAdminOriginGenerateJourneyScope) errors.push("journeyScope mismatch");
  if (expected.journeyScope && receipt.journeyScope !== expected.journeyScope)
    errors.push("journey scope does not match the admitted scope");
  if (typeof receipt.runId !== "string" || receipt.runId.length === 0) errors.push("runId must be non-empty");
  if (expected.runId && receipt.runId !== expected.runId) errors.push("runId does not match the workflow run");
  if (!/^[a-f0-9]{40}$/.test(receipt.expectedSha ?? "")) errors.push("expectedSha must be a lowercase 40-hex SHA");
  if (expected.expectedSha && receipt.expectedSha !== expected.expectedSha.toLowerCase())
    errors.push("expectedSha does not match the admitted SHA");
  if (receipt.adminWebUrl !== "https://admin.staging.chasesets.com")
    errors.push("adminWebUrl must be the exact staging origin");
  if (expected.adminWebUrl && receipt.adminWebUrl !== expected.adminWebUrl)
    errors.push("adminWebUrl does not match the admitted origin");
  if (receipt.origin !== receipt.adminWebUrl) errors.push("origin must equal adminWebUrl");
  if (receipt.pagePath !== catalogAdminOriginGeneratePagePath) errors.push("pagePath mismatch");
  if (!isCatalogAdminOriginGenerateScratchParent(receipt.scratchParent))
    errors.push("scratchParent is invalid or reserved");
  if (expected.scratchParent && receipt.scratchParent !== expected.scratchParent)
    errors.push("scratchParent does not match the host input");
  if (receipt.requestBody !== catalogAdminOriginGenerateRequestBody(receipt.scratchParent))
    errors.push("requestBody must contain exactly syncRunId and the admitted scratch parent");
  for (const key of ["hostClockBeforeEvaluate", "requestStartedAt", "responseCompletedAt", "hostClockAfterEvaluate"]) {
    if (!isIsoDate(receipt[key])) errors.push(`${key} must be an ISO timestamp`);
  }
  if (
    receipt.hostClockBeforeEvaluate &&
    receipt.requestStartedAt &&
    receipt.responseCompletedAt &&
    receipt.hostClockAfterEvaluate
  ) {
    const times = [
      receipt.hostClockBeforeEvaluate,
      receipt.requestStartedAt,
      receipt.responseCompletedAt,
      receipt.hostClockAfterEvaluate,
    ].map(Date.parse);
    if (!(times[0] <= times[1] && times[1] <= times[2] && times[2] <= times[3]))
      errors.push("receipt timing is not monotonic");
  }
  if (
    !isRecord(receipt.clientTiming) ||
    Object.keys(receipt.clientTiming).length !== 1 ||
    !Number.isFinite(receipt.clientTiming.performanceElapsedMs) ||
    receipt.clientTiming.performanceElapsedMs < 0
  )
    errors.push("clientTiming must contain one non-negative performanceElapsedMs");
  const expectedUrl = `${receipt.adminWebUrl}${catalogAdminOriginGeneratePath}`;
  if (receipt.url !== expectedUrl) errors.push("url must be the exact generate route");
  if (receipt.status !== null && (!Number.isInteger(receipt.status) || receipt.status < 100 || receipt.status > 599))
    errors.push("status must be an HTTP status or null");
  if (!Array.isArray(receipt.headers)) errors.push("headers must be an array");
  else {
    let previous = "";
    for (const header of receipt.headers) {
      if (
        !isRecord(header) ||
        Object.keys(header).sort().join(",") !== "name,value" ||
        typeof header.name !== "string" ||
        typeof header.value !== "string"
      ) {
        errors.push("headers must contain name/value entries");
        continue;
      }
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(header.name) || (previous && header.name <= previous))
        errors.push("headers must be sorted unique lowercase entries");
      if (sensitiveHeaderPattern.test(header.name) || sensitiveHeaderPattern.test(header.value))
        errors.push("headers must not contain auth, cookie, or credential values");
      previous = header.name;
    }
  }
  if (typeof receipt.body !== "string") errors.push("body must be response text");
  else {
    if (receipt.bodyBytes !== Buffer.byteLength(receipt.body, "utf8"))
      errors.push("bodyBytes does not match UTF-8 body bytes");
    if (receipt.bodySha256 !== sha256(receipt.body)) errors.push("bodySha256 does not match the exact response body");
  }
  let parsed = null;
  let parseStatus = "failure";
  if (typeof receipt.body === "string") {
    try {
      parsed = JSON.parse(receipt.body);
      parseStatus = "success";
    } catch {
      /* Raw non-JSON errors are retained. */
    }
  }
  if (receipt.jsonParse !== parseStatus) errors.push("jsonParse must match parsing the exact response body");
  if (JSON.stringify(receipt.json) !== JSON.stringify(parsed))
    errors.push("json must match the exact parsed response body");
  for (const key of ["observationCount", "candidateCount"])
    if (receipt[key] !== null && !isInteger(receipt[key])) errors.push(`${key} must be a non-negative count or null`);
  for (const key of ["observationCount", "candidateCount"]) {
    const value = isRecord(parsed) && typeof parsed[key] === "number" ? parsed[key] : null;
    if (receipt[key] !== value) errors.push(`${key} must come only from the parsed POST response`);
  }
  if (receipt.creditedProviderSpend !== 0) errors.push("creditedProviderSpend must be exactly 0");
  if (receipt.error !== null && typeof receipt.error !== "string") errors.push("error must be a string or null");
  if (receipt.status === null && !receipt.error) errors.push("a missing response must carry an error");
  if (receipt.status !== null && receipt.error === null && receipt.status >= 400)
    errors.push("HTTP failure must be disclosed in error");
  if (
    typeof receipt.error === "string" &&
    receipt.error.startsWith("not-sent:") &&
    (receipt.status !== null ||
      receipt.body !== "" ||
      receipt.headers?.length !== 0 ||
      receipt.requestStartedAt !== receipt.responseCompletedAt ||
      receipt.clientTiming?.performanceElapsedMs !== 0)
  )
    errors.push("not-sent receipt must have no response and a zero request interval");
  if (
    isRecord(receipt.clientTiming) &&
    isIsoDate(receipt.requestStartedAt) &&
    isIsoDate(receipt.responseCompletedAt) &&
    Math.abs(
      Date.parse(receipt.responseCompletedAt) -
        Date.parse(receipt.requestStartedAt) -
        receipt.clientTiming.performanceElapsedMs,
    ) > 5
  )
    errors.push("client timing does not match the request interval");
  const serialized = JSON.stringify(receipt);
  for (const marker of overrides.forbiddenValues ??
    [process.env.CATALOG_ADMIN_E2E_EMAIL, process.env.CATALOG_ADMIN_E2E_PASSWORD, process.env.GH_TOKEN].filter(
      Boolean,
    )) {
    if (serialized.includes(marker) || serialized.includes(JSON.stringify(marker).slice(1, -1)))
      errors.push("receipt contains a credential or session marker");
  }
  return errors;
}

export function buildCatalogAdminOriginGenerateReceipt(input) {
  const body = typeof input.body === "string" ? input.body : "";
  let json = null;
  let jsonParse = "failure";
  try {
    json = JSON.parse(body);
    jsonParse = "success";
  } catch {
    // The raw response remains authoritative when a failure is not JSON.
  }
  const responseJson = isRecord(json) ? json : null;
  return {
    schemaVersion: catalogAdminOriginGenerateSchemaVersion,
    journeyScope: catalogAdminOriginGenerateJourneyScope,
    runId: input.runId,
    expectedSha: input.expectedSha,
    adminWebUrl: input.adminWebUrl,
    origin: input.origin,
    pagePath: catalogAdminOriginGeneratePagePath,
    scratchParent: input.scratchParent,
    requestBody: catalogAdminOriginGenerateRequestBody(input.scratchParent),
    hostClockBeforeEvaluate: input.hostClockBeforeEvaluate,
    requestStartedAt: input.requestStartedAt,
    responseCompletedAt: input.responseCompletedAt,
    hostClockAfterEvaluate: input.hostClockAfterEvaluate,
    clientTiming: { performanceElapsedMs: input.performanceElapsedMs },
    url: input.url ?? `${input.adminWebUrl}${catalogAdminOriginGeneratePath}`,
    status: input.status ?? null,
    headers: [...(input.headers ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    bodyBytes: Buffer.byteLength(body, "utf8"),
    bodySha256: sha256(body),
    body,
    jsonParse,
    json,
    observationCount: typeof responseJson?.observationCount === "number" ? responseJson.observationCount : null,
    candidateCount: typeof responseJson?.candidateCount === "number" ? responseJson.candidateCount : null,
    creditedProviderSpend: 0,
    error: input.error ?? (input.status !== null && input.status >= 400 ? `http-${input.status}` : null),
  };
}

function sampleReceipt() {
  const body = JSON.stringify({ observationCount: 2, candidateCount: 1 });
  return buildCatalogAdminOriginGenerateReceipt({
    runId: "123456",
    expectedSha: "a".repeat(40),
    adminWebUrl: "https://admin.staging.chasesets.com",
    origin: "https://admin.staging.chasesets.com",
    scratchParent: "job_01M5N5MCJ3JET0GSZ32EJ63BA1",
    hostClockBeforeEvaluate: "2026-10-29T18:00:00.000Z",
    requestStartedAt: "2026-10-29T18:00:00.001Z",
    responseCompletedAt: "2026-10-29T18:00:00.010Z",
    hostClockAfterEvaluate: "2026-10-29T18:00:00.011Z",
    performanceElapsedMs: 9,
    status: 202,
    headers: [{ name: "content-type", value: "application/json" }],
    body,
  });
}

export async function testCatalogAdminOriginGenerateContract() {
  const validParent = "job_01M5N5MCJ3JET0GSZ32EJ63BA1";
  const receipt = sampleReceipt();
  const identity = {
    expectedSha: "a".repeat(40),
    runId: "123456",
    scratchParent: validParent,
    journeyScope: catalogAdminOriginGenerateJourneyScope,
    adminWebUrl: "https://admin.staging.chasesets.com",
    forbiddenValues: [],
  };
  const validate = (value) => validateCatalogAdminOriginGenerateReceipt(value, identity);
  assert.deepEqual(validate(receipt), []);
  const mutants = {
    schemaVersion: { schemaVersion: "other/v1" },
    extraField: { unexpected: true },
    hash: { bodySha256: "0".repeat(64) },
    bytes: { bodyBytes: receipt.bodyBytes + 1 },
    spend: { creditedProviderSpend: 1 },
    requestBody: { requestBody: '{"syncRunId":"other","scope":{}}' },
    scratch: { scratchParent: catalogAdminOriginGenerateReservedParents[0] },
    sha: { expectedSha: "b".repeat(40) },
    origin: { origin: "https://example.invalid" },
    path: { pagePath: "/catalog/other" },
    target: { url: "https://tcgplayer.invalid/generate" },
    reverseTiming: { responseCompletedAt: "2026-10-29T17:59:59.000Z" },
    clientTiming: { clientTiming: { performanceElapsedMs: 800 } },
    nestedTiming: { clientTiming: { performanceElapsedMs: 9, extra: true } },
    badDate: { requestStartedAt: "not-a-date" },
    count: { observationCount: 99 },
    missingResponseCount: { candidateCount: null },
    json: { json: { observationCount: 2, candidateCount: 99 } },
    parse: { jsonParse: "failure" },
    cookieHeader: { headers: [{ name: "set-cookie", value: "synthetic-session-marker" }] },
    nestedHeader: { headers: [{ name: "content-type", value: "application/json", extra: true }] },
    unsortedHeaders: {
      headers: [
        { name: "z-last", value: "z" },
        { name: "a-first", value: "a" },
      ],
    },
    duplicateHeaders: {
      headers: [
        { name: "content-type", value: "a" },
        { name: "content-type", value: "b" },
      ],
    },
    failureUndisclosed: { status: null, error: null },
  };
  for (const [name, change] of Object.entries(mutants)) {
    assert.notDeepEqual(validate({ ...receipt, ...change }), [], `${name} must be rejected`);
  }
  const unicodeBody = JSON.stringify({ observationCount: 3, candidateCount: 0, label: "\u00e9\ud83c\udfb4" });
  const unicode = {
    ...receipt,
    body: unicodeBody,
    json: JSON.parse(unicodeBody),
    bodyBytes: Buffer.byteLength(unicodeBody),
    bodySha256: sha256(unicodeBody),
    observationCount: 3,
    candidateCount: 0,
  };
  assert.deepEqual(validate(unicode), []);
  assert.ok(unicode.bodyBytes > unicode.body.length);
  for (const body of ["gateway failure", "null", "[]", '"response"']) {
    const diagnostic = buildCatalogAdminOriginGenerateReceipt({
      ...receipt,
      body,
      status: 502,
      performanceElapsedMs: 9,
      error: "http-502",
    });
    assert.deepEqual(validate(diagnostic), []);
    assert.equal(diagnostic.observationCount, null);
    assert.equal(diagnostic.candidateCount, null);
    assert.notDeepEqual(
      validate({ ...diagnostic, observationCount: 7 }),
      [],
      "counts cannot be invented without response counts",
    );
  }
  const network = buildCatalogAdminOriginGenerateReceipt({
    ...receipt,
    body: "",
    headers: [],
    status: null,
    performanceElapsedMs: 9,
    error: "request-timeout",
  });
  assert.deepEqual(validate(network), []);
  const failureInstant = "2026-10-29T18:00:45.000Z";
  const unsent = buildCatalogAdminOriginGenerateReceipt({
    ...receipt,
    hostClockBeforeEvaluate: "2026-10-29T18:00:00.000Z",
    requestStartedAt: failureInstant,
    responseCompletedAt: failureInstant,
    hostClockAfterEvaluate: failureInstant,
    performanceElapsedMs: 0,
    status: null,
    headers: [],
    body: "",
    error: "not-sent:request-failed:TimeoutError",
  });
  assert.deepEqual(validate(unsent), [], "45-second host bracket with zero unsent interval validates");
  assert.equal(Date.parse(unsent.hostClockAfterEvaluate) - Date.parse(unsent.hostClockBeforeEvaluate), 45_000);
  assert.notDeepEqual(validate({ ...unsent, requestStartedAt: unsent.hostClockBeforeEvaluate }), [], "old fallback");
  assert.notDeepEqual(validate({ ...network, error: `not-sent:${network.error}` }), [], "sent interval is not unsent");
  assert.notDeepEqual(validate({ ...receipt, error: "not-sent:request-failed" }), [], "response is not unsent");
  assert.deepEqual(validate({ ...receipt, headers: [{ name: "vary", value: "[redacted]" }] }), []);
  assert.notDeepEqual(validate({ ...receipt, headers: [{ name: "vary", value: "Cookie" }] }), []);
  assert.notDeepEqual(
    validateCatalogAdminOriginGenerateReceipt(
      { ...receipt, headers: [{ name: "vary", value: "synthetic-session-marker" }] },
      { ...identity, forbiddenValues: ["synthetic-session-marker"] },
    ),
    [],
  );
  assert.notDeepEqual(
    validateCatalogAdminOriginGenerateReceipt(receipt, { ...identity, forbiddenValues: [receipt.body] }),
    [],
  );
  for (const parent of [
    ...catalogAdminOriginGenerateReservedParents,
    "",
    "job_lowercase00000000000000000",
    `${validParent} `,
    "https://tcgplayer.invalid",
  ])
    assert.equal(isCatalogAdminOriginGenerateScratchParent(parent), false, parent);
  assert.equal(isCatalogAdminOriginGenerateScratchParent(validParent), true);
  const { parse } = await import("yaml");
  const workflow = parse(
    await readFile(new URL("../.github/workflows/catalog-staging-provider-uat.yml", import.meta.url), "utf8"),
  );
  assert.equal(workflow.concurrency.group, "platform-staging-mutating-operations");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.ok(
    workflow.on.workflow_dispatch.inputs.journey_scope.options.includes(catalogAdminOriginGenerateJourneyScope),
  );
  assert.equal(workflow.on.workflow_dispatch.inputs.scratch_parent.type, "string");
  const admission = workflow.jobs["admit-reviewed-sha"].steps[0];
  const env = {
    EXPECTED_SHA: receipt.expectedSha,
    RUN_SHA: receipt.expectedSha,
    CONFIRMATION: "run catalog staging provider uat",
    JOURNEY_SCOPE: catalogAdminOriginGenerateJourneyScope,
    ADMIN_WEB_URL: receipt.adminWebUrl,
    SCRATCH_PARENT: validParent,
  };
  const admit = (change) => {
    const failures = [];
    runInNewContext(admission.with.script, {
      process: { env: { ...env, ...change } },
      core: { setFailed: (reason) => failures.push(reason) },
    });
    return failures;
  };
  assert.deepEqual(admit({}), []);
  for (const change of [
    { EXPECTED_SHA: "main" },
    { RUN_SHA: "b".repeat(40) },
    { CONFIRMATION: "incorrect" },
    { ADMIN_WEB_URL: `${receipt.adminWebUrl}/` },
    { SCRATCH_PARENT: "" },
    ...catalogAdminOriginGenerateReservedParents.map((SCRATCH_PARENT) => ({ SCRATCH_PARENT })),
  ])
    assert.notDeepEqual(admit(change), [], `admission must reject ${JSON.stringify(change)}`);
  const worker = workflow.jobs["staging-provider-uat"];
  assert.ok(worker.needs.includes("admit-reviewed-sha"));
  assert.ok(worker.if.includes("needs.admit-reviewed-sha.result == 'success'"));
  assert.ok(
    workflow.jobs["resolve-provider-uat-plan"].steps[0].run.includes(`|${catalogAdminOriginGenerateJourneyScope})`),
  );
  const checkout = worker.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ inputs.expected_sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(worker.env.CATALOG_ADMIN_ORIGIN_GENERATE_SCRATCH_PARENT, "${{ inputs.scratch_parent }}");
  const capture = worker.steps.find((step) => step.id === "provider-uat");
  assert.ok(capture.run.includes("--retries=0 --reporter=line"));
  const validation = worker.steps.find((step) => step.id === "admin-origin-generate-receipt");
  assert.equal(
    validation.if,
    "${{ always() && matrix.journey_scope == 'admin-origin-generate-probe' && steps.provider-uat.outcome != 'skipped' }}",
  );
  assert.equal(
    validation.run,
    "node scripts/catalog-admin-origin-generate-receipt.mjs validate --file artifacts/catalog-admin-origin-generate/receipt.json",
  );
  const upload = worker.steps.find((step) => step.with?.path === catalogAdminOriginGenerateArtifactPath);
  assert.equal(upload.if, "${{ always() && steps.admin-origin-generate-receipt.outcome == 'success' }}");
  assert.equal(upload.with.name, "catalog-admin-origin-generate-${{ github.run_id }}-${{ github.run_attempt }}");
  assert.equal(upload.with["if-no-files-found"], "error");
  console.log("catalog-admin-origin-generate-receipt contract tests passed");
}

async function main(argv) {
  const command = argv[2] ?? "test";
  if (command === "test") return testCatalogAdminOriginGenerateContract();
  if (command !== "validate") throw new Error(`Unknown command: ${command}`);
  const expected = expectedFromEnvironment();
  if (
    !/^[a-f0-9]{40}$/.test(expected.expectedSha) ||
    !expected.runId ||
    expected.adminWebUrl !== "https://admin.staging.chasesets.com" ||
    expected.journeyScope !== catalogAdminOriginGenerateJourneyScope ||
    !isCatalogAdminOriginGenerateScratchParent(expected.scratchParent)
  )
    throw new Error(
      "Admin-origin generate validation requires the admitted SHA, run, origin, scope and scratch parent",
    );
  const fileIndex = argv.indexOf("--file");
  const file = fileIndex >= 0 ? argv[fileIndex + 1] : catalogAdminOriginGenerateArtifactPath;
  if (!file) throw new Error("--file requires a path");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  const errors = validateCatalogAdminOriginGenerateReceipt(receipt);
  if (errors.length) throw new Error(`Admin-origin generate receipt validation failed: ${errors.join("; ")}`);
  console.log(JSON.stringify({ ok: true, path: file, schemaVersion: receipt.schemaVersion }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
