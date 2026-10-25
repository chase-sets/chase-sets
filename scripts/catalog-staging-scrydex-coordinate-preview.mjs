import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergeObservedCoordinatePreviewReceipt,
  runScrydexCoordinatePreview,
} from "../bounded-contexts/catalog/features/scope-sync-batches/api/scrydex-coordinate-preview-runner.ts";
import {
  classifyScrydexCoordinatePreviewRequest,
  scrydexCoordinatePreviewIsolationPath,
  scrydexCoordinatePreviewJourneyScope,
  validateScrydexCoordinatePreviewReceipt,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-coordinate-preview.ts";
import {
  decodeScrydexAcceptedMappings,
  decodeScrydexCacheCaptureOptionPage,
  decodeScrydexCacheCaptureProfiles,
  decodeScrydexCacheCaptureScopePage,
  scrydexCacheCaptureContinuationPath,
  scrydexCacheCaptureCoveragePath,
  scrydexCacheCaptureMaxContinuationPages,
  scrydexCacheCaptureOrigin,
  scrydexCacheCaptureProfilesPath,
  scrydexCacheCaptureProductDomains,
  scrydexCacheCaptureQueryHrefUnit,
  scrydexCacheCaptureScopePagePath,
  scrydexCacheCaptureScopePageLimit,
  scrydexCacheCaptureUnits,
  scrydexCacheCaptureCoordinate,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-cache-capture.ts";
import { buildCatalogPrimaryWorkbenchSourceOptionRequests } from "../bounded-contexts/catalog/features/source-observations/ui/primary-workbench-source-options.ts";
import { addCookieMarkers, watchSessionMarkers } from "./catalog-staging-count-lifecycle.mjs";
import { selectStagingDeployGeneration } from "./staging-deploy-generation.mjs";

const origin = scrydexCacheCaptureOrigin;
const previewPath = "/api/catalog/scope-sync-batches/preview";
const usagePath = "/api/catalog/source-observations/integration-control-plane/overview?audience=daily";
const credentialNames = ["CATALOG_ADMIN_E2E_EMAIL", "CATALOG_ADMIN_E2E_PASSWORD", "GH_TOKEN"];
const refused = (reason = "capture") => new Error(`scrydex-coordinate-preview-refused:${reason}`);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifactName = "capture.json";

export const scrydexCoordinatePreviewArtifactPath = "artifacts/catalog-scrydex-coordinate-preview/capture.json";
export const coordinatePreviewReadDeadlineMs = 30_000;
export const coordinatePreviewReadByteCaps = Object.freeze({ profiles: 4_000_000, page: 1_000_000 });
export const coordinatePreviewDeployWindowSeconds = 86_400;
export const coordinatePreviewIsolationDocument = '<!doctype html><meta charset="utf-8">';

export function coordinatePreviewRunnerIdentity(env) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.ADMIN_WEB_URL !== origin ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    env.EXPECTED_SHA !== env.GITHUB_SHA ||
    !/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    env.CATALOG_STAGING_PROVIDER_UAT_SCOPE !== scrydexCoordinatePreviewJourneyScope ||
    !env.RUNNER_TEMP
  )
    throw refused("runner-identity");
  return {
    sha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    journeyScope: scrydexCoordinatePreviewJourneyScope,
    origin: new URL(origin).host,
  };
}

export async function selectCoordinatePreviewDeployment(token, select = selectStagingDeployGeneration) {
  const result = await select({
    token,
    requestTimeoutMs: coordinatePreviewReadDeadlineMs,
    now: new Date().toISOString(),
    maxAgeSeconds: coordinatePreviewDeployWindowSeconds,
  });
  if (result.stop !== null || !result.deployGeneration || !result.deployment)
    return { generation: null, stop: result.stop ?? "selection-failed" };
  return {
    generation: { ...result.deployGeneration, imageDigest: result.deployment.imageDigest },
    stop: null,
  };
}

export function emptyCoordinatePreviewTally() {
  return {
    requests: {
      signIn: 0,
      profileReads: 0,
      scopeInventoryReads: 0,
      coverageReads: 0,
      cacheOptionReads: 0,
      previewPosts: 0,
      usageReads: 0,
      forbidden: 0,
    },
    forbiddenCalls: [],
  };
}

function requestPath(request) {
  try {
    const url = new URL(typeof request.url === "function" ? request.url() : request.url);
    return url.origin === origin ? url.pathname : `${url.host}${url.pathname}`;
  } catch {
    return "/unparseable";
  }
}

function refuseRoute(tally, request, reason) {
  tally.requests.forbidden += 1;
  if (tally.forbiddenCalls.length < 100) {
    const method = typeof request.method === "function" ? request.method() : request.method;
    const head =
      String(reason)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 64) || "refused";
    const tail = `${String(method).toUpperCase()}:${requestPath(request)}`
      .replace(/[^A-Za-z0-9._:-]/g, "-")
      .slice(0, 200);
    tally.forbiddenCalls.push(`${head}:${tail}`);
  }
}

const requestCounters = {
  "isolation-document": "signIn",
  "sign-in": "signIn",
  "profile-read": "profileReads",
  "scope-inventory-read": "scopeInventoryReads",
  "coverage-read": "coverageReads",
  "cache-option-read": "cacheOptionReads",
  "preview-post": "previewPosts",
  "usage-read": "usageReads",
};

// Browser fence for the whole journey. The isolation document is fulfilled,
// not continued, so no Admin bundle can run during the capture phase.
export function createCoordinatePreviewRouteHandler({ phase = () => "sign-in", tally } = {}) {
  if (!tally) throw new TypeError("coordinate-preview-tally-required");
  const seen = new Set();
  return async function coordinatePreviewRouteHandler(route) {
    const request = route.request();
    const method = typeof request.method === "function" ? request.method() : request.method;
    const url = typeof request.url === "function" ? request.url() : request.url;
    const navigation = typeof request.isNavigationRequest === "function" ? request.isNavigationRequest() : false;
    const verdict = classifyScrydexCoordinatePreviewRequest({
      method: String(method),
      url: String(url),
      phase: typeof phase === "function" ? phase() : phase,
      navigation,
    });
    if (!verdict.allowed) {
      refuseRoute(tally, request, verdict.reason);
      return route.abort("blockedbyclient");
    }
    if (
      seen.has(verdict.requestClass) &&
      (verdict.requestClass === "preview-post" || verdict.requestClass === "usage-read")
    ) {
      refuseRoute(tally, request, `duplicate-${verdict.requestClass}`);
      return route.abort("blockedbyclient");
    }
    seen.add(verdict.requestClass);
    const counter = requestCounters[verdict.requestClass];
    tally.requests[counter] += 1;
    if (verdict.requestClass === "isolation-document") {
      return route.fulfill({ status: 200, contentType: "text/html", body: coordinatePreviewIsolationDocument });
    }
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
    } catch {
      refuseRoute(tally, request, "request-failed");
      return route.abort("failed");
    }
    const location = response.headers().location;
    if (location && new URL(location, String(url)).origin !== origin) {
      refuseRoute(tally, request, "cross-origin-redirect");
      return route.abort("blockedbyclient");
    }
    return route.fulfill({ response });
  };
}

export async function readCoordinatePreviewResponseInPage({
  path,
  method = "GET",
  body,
  deadlineMs = coordinatePreviewReadDeadlineMs,
  byteCap = coordinatePreviewReadByteCaps.page,
  fetchImpl = fetch,
}) {
  const refusal = (reason) => new Error(`scrydex-coordinate-preview-refused:${reason}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    let response;
    try {
      response = await fetchImpl(path, {
        method,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw refusal("read-timeout");
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, text: "" };
    }
    if (!response.body) throw refusal("read-body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (controller.signal.aborted) throw refusal("read-timeout");
          throw error;
        }
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > byteCap) throw refusal("read-cap");
        text += decoder.decode(chunk.value, { stream: true });
      }
      return { status: response.status, text: text + decoder.decode() };
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(page, path, options = {}) {
  const deadlineMs = options.deadlineMs ?? coordinatePreviewReadDeadlineMs;
  let timer;
  let result;
  try {
    result = await Promise.race([
      page.evaluate(readCoordinatePreviewResponseInPage, {
        path,
        method: options.method,
        body: options.body,
        deadlineMs,
        byteCap: options.byteCap ?? coordinatePreviewReadByteCaps.page,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(refused("read-timeout")), deadlineMs + 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!result || result.status !== 200) throw refused(options.failure ?? "read-failed");
  try {
    return JSON.parse(result.text);
  } catch {
    throw refused(options.failure ?? "read-malformed");
  }
}

function optionRequests(profiles, unitKey) {
  return buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl: `${origin}/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(unitKey)}`,
    scopes: [],
    profiles,
    cacheOnly: true,
  }).filter(
    (request) =>
      request.providerKey === "scrydex" &&
      request.scope === "set-name" &&
      request.parentScope === null &&
      request.queryKind === "sets",
  );
}

async function readOptionUnit(page, unit, profiles, readDeadlineMs) {
  const request = optionRequests(profiles, unit.unitKey).find(
    (candidate) => candidate.ingestionUnitKey === unit.unitKey,
  );
  if (!request || scrydexCacheCaptureQueryHrefUnit(request.queryHref) !== unit.unitKey)
    throw refused(`query-href-unresolved:${unit.unitKey}`);
  const pages = [];
  const values = [];
  let cursor = null;
  let cache = null;
  let total = null;
  const seen = new Set();
  for (;;) {
    if (pages.length >= scrydexCacheCaptureMaxContinuationPages)
      throw refused(`option-continuation-cap:${unit.unitKey}`);
    const path =
      cursor === null
        ? new URL(request.queryHref, origin).pathname + new URL(request.queryHref, origin).search
        : scrydexCacheCaptureContinuationPath(request.queryHref, cursor);
    const body = await readJson(page, path, {
      deadlineMs: readDeadlineMs,
      byteCap: coordinatePreviewReadByteCaps.page,
      failure: `option-read-failed:${unit.unitKey}`,
    });
    const decoded = decodeScrydexCacheCaptureOptionPage(body, { cursor });
    if (!decoded.ok) throw refused(`${decoded.reason}:${unit.unitKey}`);
    if (cache && JSON.stringify(cache) !== JSON.stringify(decoded.page.cache))
      throw refused(`cache-identity-changed:${unit.unitKey}`);
    if (total !== null && total !== decoded.page.total) throw refused(`cache-identity-changed:${unit.unitKey}`);
    cache ??= decoded.page.cache;
    total ??= decoded.page.total;
    pages.push(decoded.page);
    values.push(...decoded.page.values);
    if (decoded.page.nextCursor === null) break;
    if (seen.has(decoded.page.nextCursor)) throw refused(`cache-cursor-stalled:${unit.unitKey}`);
    seen.add(decoded.page.nextCursor);
    cursor = decoded.page.nextCursor;
  }
  if (values.length !== total) throw refused(`cache-incomplete:${unit.unitKey}`);
  return { unit, profileKey: request.profileKey, queryHref: request.queryHref, cache, pages, values };
}

async function readInventory(page, productDomain, readDeadlineMs) {
  const ids = [];
  let total = null;
  for (let offset = 0; offset < scrydexCacheCaptureScopePageLimit; ) {
    const body = await readJson(page, scrydexCacheCaptureScopePagePath(productDomain, offset), {
      deadlineMs: readDeadlineMs,
      byteCap: coordinatePreviewReadByteCaps.page,
      failure: `scope-inventory-unreadable:${productDomain}`,
    });
    const decoded = decodeScrydexCacheCaptureScopePage(body, { productDomain });
    if (!decoded.ok) throw refused(`${decoded.reason}:${productDomain}`);
    if (total !== null && total !== decoded.total) throw refused(`scope-inventory-changed:${productDomain}`);
    total = decoded.total;
    ids.push(...decoded.scopeRecordIds);
    if (ids.length >= total) return ids;
    if (decoded.scopeRecordIds.length === 0) throw refused(`scope-inventory-truncated:${productDomain}`);
    offset += decoded.scopeRecordIds.length;
  }
  throw refused(`scope-inventory-cap:${productDomain}`);
}

async function readCoverage(page, scopeRecordId, productDomain, readDeadlineMs) {
  const body = await readJson(page, scrydexCacheCaptureCoveragePath(scopeRecordId), {
    deadlineMs: readDeadlineMs,
    byteCap: coordinatePreviewReadByteCaps.page,
    failure: `coverage-read-failed:${scopeRecordId}`,
  });
  const decoded = decodeScrydexAcceptedMappings(body, { scopeRecordId, productDomain });
  if (!decoded.ok) throw refused(`${decoded.reason}:${scopeRecordId}`);
  return decoded.mappings;
}

function projectionFromPreview(preview) {
  if (!preview || typeof preview !== "object" || !preview.selection || !Array.isArray(preview.samples))
    throw refused("preview-malformed");
  const required = (value, key) => {
    if (!value || typeof value !== "object") throw refused("preview-malformed");
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw refused("preview-malformed");
    return value[key];
  };
  const selection = required(preview, "selection");
  if (!selection || typeof selection !== "object" || required(selection, "mode") !== "ids")
    throw refused("preview-malformed");
  const scopeRecordIds = required(selection, "scopeRecordIds");
  if (!Array.isArray(scopeRecordIds)) throw refused("preview-malformed");
  const samples = preview.samples.map((sample) => {
    if (!sample || typeof sample !== "object") throw refused("preview-malformed");
    const mappingVersions = required(sample, "mappingVersions");
    const profileVersions = required(sample, "profileVersions");
    if (!Array.isArray(mappingVersions) || !Array.isArray(profileVersions)) throw refused("preview-malformed");
    return {
      scopeRecordId: required(sample, "scopeRecordId"),
      mappingVersions: mappingVersions.map((mapping) => ({
        mappingId: required(mapping, "mappingId"),
        version: required(mapping, "version"),
        reviewStatus: required(mapping, "reviewStatus"),
      })),
      profileVersions: profileVersions.map((profile) => ({
        providerKey: required(profile, "providerKey"),
        unitKey: required(profile, "unitKey"),
        profileKey: required(profile, "profileKey"),
        profileVersion: required(profile, "profileVersion"),
      })),
    };
  });
  const blockers = required(preview, "blockers");
  if (!Array.isArray(blockers)) throw refused("preview-malformed");
  return {
    planFingerprint: required(preview, "planFingerprint"),
    status: required(preview, "status"),
    confirmAllowed: required(preview, "confirmAllowed"),
    resolvedAt: required(preview, "resolvedAt"),
    selection: { mode: "ids", scopeRecordIds },
    samples,
    blockers: blockers.map((blocker) => ({
      code: required(blocker, "code"),
      scopeRecordId: required(blocker, "scopeRecordId"),
      providerKey: required(blocker, "providerKey"),
      message: required(blocker, "message"),
    })),
  };
}

function rowsFromSources(preview, options, mappingsByScope) {
  const samples = new Map(preview.samples.map((sample) => [sample.scopeRecordId, sample]));
  return scrydexCacheCaptureUnits.map((unit) => {
    const scopeRecordId = preview.selection.scopeRecordIds.find(
      (id) =>
        mappingsByScope.has(id) && (mappingsByScope.get(id) ?? []).some((mapping) => mapping.unitKey === unit.unitKey),
    );
    const mapping = (mappingsByScope.get(scopeRecordId) ?? []).find((candidate) => candidate.unitKey === unit.unitKey);
    const option = options.get(unit.unitKey);
    const sample = samples.get(scopeRecordId);
    const profile = sample?.profileVersions?.find((candidate) => candidate.unitKey === unit.unitKey);
    if (!scopeRecordId || !mapping || !option || !sample || !profile) throw refused(`row-unresolved:${unit.unitKey}`);
    const coordinate = scrydexCacheCaptureCoordinate(mapping, scopeRecordId);
    return {
      unitKey: unit.unitKey,
      scopeRecordId,
      planFingerprint: preview.planFingerprint,
      profileKey: profile.profileKey,
      profileVersion: profile.profileVersion,
      mapping: {
        mappingId: mapping.mappingId,
        version: mapping.version,
        reviewStatus: mapping.reviewStatus,
        setId: mapping.setId,
        setName: mapping.setName,
      },
      coordinate,
      cache: option.cache,
      membership: coordinate !== null && option.values.includes(coordinate) ? "member" : "non-member",
    };
  });
}

export function buildProducer({ page, tally = null, readDeadlineMs = coordinatePreviewReadDeadlineMs } = {}) {
  if (!page) throw new TypeError("coordinate-preview-page-required");
  if (!tally) throw new TypeError("coordinate-preview-tally-required");
  const produce = async function produce() {
    try {
      const phases = ["sign-in"];
      const profileBody = await readJson(page, scrydexCacheCaptureProfilesPath, {
        deadlineMs: readDeadlineMs,
        byteCap: coordinatePreviewReadByteCaps.profiles,
        failure: "profiles-unreadable",
      });
      const profiles = decodeScrydexCacheCaptureProfiles(profileBody);
      if (!profiles.ok) throw refused(profiles.reason);
      const usageBody = await readJson(page, usagePath, { deadlineMs: readDeadlineMs, failure: "usage-read-failed" });
      if (!usageBody || typeof usageBody !== "object") throw refused("usage-read-failed");

      phases.push("readiness");
      const options = new Map();
      for (const unit of scrydexCacheCaptureUnits)
        options.set(unit.unitKey, await readOptionUnit(page, unit, profiles.profiles, readDeadlineMs));
      const mappingsByScope = new Map();
      const selectedScopes = [];
      for (const productDomain of scrydexCacheCaptureProductDomains) {
        const inventory = await readInventory(page, productDomain, readDeadlineMs);
        for (const scopeRecordId of inventory) {
          const mappings = await readCoverage(page, scopeRecordId, productDomain, readDeadlineMs);
          mappingsByScope.set(scopeRecordId, mappings);
          const required = scrydexCacheCaptureUnits
            .filter((unit) => unit.productDomain === productDomain)
            .map((unit) => unit.unitKey);
          if (required.every((unitKey) => mappings.some((mapping) => mapping.unitKey === unitKey))) {
            selectedScopes.push({ scopeRecordId, productDomain });
            break;
          }
        }
      }
      if (selectedScopes.length !== 2) throw refused("two-scopes-unavailable");
      const selectedIds = selectedScopes.map(({ scopeRecordId }) => scopeRecordId);
      const preview = projectionFromPreview(
        await readJson(page, previewPath, {
          method: "POST",
          body: { selection: { mode: "ids", scopeRecordIds: selectedIds } },
          deadlineMs: readDeadlineMs,
          failure: "preview-post-failed",
        }),
      );
      phases.push("preview");
      const secondOptions = new Map();
      for (const unit of scrydexCacheCaptureUnits) {
        const next = await readOptionUnit(page, unit, profiles.profiles, readDeadlineMs);
        const first = options.get(unit.unitKey);
        if (JSON.stringify(first?.cache) !== JSON.stringify(next.cache)) throw refused("bracket-changed");
        secondOptions.set(unit.unitKey, next);
      }
      for (const { scopeRecordId, productDomain } of selectedScopes) {
        const next = await readCoverage(page, scopeRecordId, productDomain, readDeadlineMs);
        if (JSON.stringify(next) !== JSON.stringify(mappingsByScope.get(scopeRecordId)))
          throw refused("bracket-changed");
      }
      phases.push("pre-confirm");
      return {
        phases,
        requests: { ...tally.requests },
        usageRead: {
          count: tally.requests.usageReads,
          allowed:
            usageBody?.providerReadiness?.providers?.some(
              (provider) => provider.providerKey === "scrydex" && provider.usageBudget?.readiness === "ready",
            ) === true,
        },
        forbiddenCalls: [...tally.forbiddenCalls],
        preview,
        rows: rowsFromSources(preview, secondOptions, mappingsByScope),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("scrydex-coordinate-preview-refused:")) {
        const code = message
          .slice("scrydex-coordinate-preview-refused:".length)
          .replace(/[^a-z0-9-]/gi, "-")
          .slice(0, 64);
        throw new Error(code || "producer-failed");
      }
      throw error;
    }
  };
  return produce;
}

export function finalCoordinatePreviewReceipt(receipt, observed, tally) {
  return mergeObservedCoordinatePreviewReceipt(
    {
      runner: receipt.runner,
      deployment: receipt.deployment,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
      runnerReasons: receipt.reasons.filter((reason) =>
        /^(?:credentials-missing|producer-failed(?::[a-z0-9-]{1,64})?|deployment-(?:before|after):[a-z0-9-]{1,64})$/.test(
          reason,
        ),
      ),
    },
    {
      ...observed,
      requests: { ...tally.requests },
      forbiddenCalls: [...tally.forbiddenCalls],
    },
  );
}

function paths(env, workspace) {
  if (!env.RUNNER_TEMP) throw refused("runner-temp");
  return {
    artifact: resolve(workspace, scrydexCoordinatePreviewArtifactPath),
    seal: join(env.RUNNER_TEMP, "catalog-scrydex-coordinate-preview-seal.json"),
  };
}

async function artifactDirectory(workspace, create) {
  let directory = resolve(workspace);
  for (const part of ["artifacts", "catalog-scrydex-coordinate-preview"]) {
    directory = join(directory, part);
    if (create) {
      await mkdir(directory, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw refused("artifact-directory");
  }
  return directory;
}

export async function writeCoordinatePreviewArtifact(receipt, forbiddenValues, env, workspace, identity) {
  const serialized = JSON.stringify(receipt);
  if (Buffer.byteLength(serialized) > 1_000_000) throw refused("artifact-size");
  if (validateScrydexCoordinatePreviewReceipt(JSON.parse(serialized)).length) throw refused("artifact-invalid");
  if (forbiddenValues.some((value) => value && serialized.includes(value))) throw refused("artifact-invalid");
  const files = paths(env, workspace);
  const directory = await artifactDirectory(workspace, true);
  await mkdir(dirname(files.seal), { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length !== 0) throw refused("artifact-directory-not-empty");
  await writeFile(files.artifact, serialized, { flag: "wx", mode: 0o600 });
  await writeFile(files.seal, JSON.stringify({ identity, sha256: digest(serialized) }), { flag: "wx", mode: 0o600 });
  return { path: files.artifact, sha256: digest(serialized) };
}

export async function validateCoordinatePreviewUpload(env = process.env, workspace = process.cwd()) {
  const identity = coordinatePreviewRunnerIdentity(env);
  const files = paths(env, workspace);
  const directory = await artifactDirectory(workspace, false);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== artifactName || !entries[0].isFile()) throw refused("artifact-shape");
  const info = await lstat(files.artifact);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw refused("artifact-size");
  const bytes = await readFile(files.artifact);
  const serialized = bytes.toString("utf8");
  if (credentialNames.some((key) => env[key] && serialized.includes(env[key]))) throw refused("credential-marker");
  const receipt = JSON.parse(serialized);
  const errors = validateScrydexCoordinatePreviewReceipt(receipt);
  if (errors.length) throw refused("artifact-invalid");
  if (JSON.stringify(receipt.runner) !== JSON.stringify(identity)) throw refused("runner-mismatch");
  const sealInfo = await lstat(files.seal);
  if (!sealInfo.isFile() || sealInfo.isSymbolicLink() || sealInfo.size > 4096) throw refused("seal-shape");
  const seal = await readFile(files.seal, "utf8");
  if (seal !== JSON.stringify({ identity, sha256: digest(bytes) })) throw refused("seal-mismatch");
  return { captureStatus: receipt.outcome, reasons: receipt.reasons.length, sha256: digest(bytes) };
}

export async function capture(env = process.env, workspace = process.cwd()) {
  const identity = coordinatePreviewRunnerIdentity(env);
  const forbidden = new Set(credentialNames.map((key) => env[key]).filter(Boolean));
  const tally = emptyCoordinatePreviewTally();
  let browser;
  let context;
  let page;
  let phase = "sign-in";
  let harvest;
  let observed = {};
  try {
    const receipt = await runScrydexCoordinatePreview({
      runner: identity,
      credentialsPresent: credentialNames.every((key) => Boolean(env[key])),
      selectDeployment: () => selectCoordinatePreviewDeployment(env.GH_TOKEN),
      signIn: async () => {
        const { chromium } = await import("@playwright/test");
        browser = await chromium.launch();
        context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
        harvest = watchSessionMarkers(context, forbidden);
        await context.route("**/*", createCoordinatePreviewRouteHandler({ phase: () => phase, tally }));
        page = await context.newPage();
        page.setDefaultTimeout(coordinatePreviewReadDeadlineMs);
        await page.goto(`${origin}/access/sign-in?returnTo=${encodeURIComponent("/catalog/scopes/sync-batches")}`, {
          waitUntil: "domcontentloaded",
        });
        await page.getByRole("textbox", { name: /email|phone/i }).fill(env.CATALOG_ADMIN_E2E_EMAIL);
        await page.getByRole("button", { name: /continue/i }).click();
        const passwordChoice = page.getByRole("radio", { name: /^Password$/ });
        if (await passwordChoice.isVisible()) await passwordChoice.check();
        await page
          .locator('input[name="password"], input[type="password"]')
          .first()
          .fill(env.CATALOG_ADMIN_E2E_PASSWORD);
        await page.getByRole("button", { name: /sign in/i }).click();
        await page.waitForURL(`${origin}/catalog/scopes/sync-batches`);
        addCookieMarkers(forbidden, await context.cookies());
        await page.goto(`${origin}${scrydexCoordinatePreviewIsolationPath}`, { waitUntil: "domcontentloaded" });
        phase = "capture";
      },
      produce: async () => {
        observed = await buildProducer({ page, tally, readDeadlineMs: coordinatePreviewReadDeadlineMs })();
        return observed;
      },
      now: () => new Date().toISOString(),
    });
    await Promise.allSettled([...(harvest?.cookieReads ?? [])]);
    if (harvest?.hasFailure()) throw refused("cookie-marker");
    if (context) addCookieMarkers(forbidden, await context.cookies());
    const finalReceipt = finalCoordinatePreviewReceipt(receipt, observed, tally);
    const final = await writeCoordinatePreviewArtifact(finalReceipt, [...forbidden], env, workspace, identity);
    return { ...final, outcome: finalReceipt.outcome, reasons: finalReceipt.reasons };
  } finally {
    await Promise.allSettled([...(harvest?.cookieReads ?? [])]);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await Promise.allSettled([...(harvest?.cookieReads ?? [])]);
  }
}

export function coordinatePreviewExitCode(receipt) {
  return receipt?.outcome === "complete" ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (process.argv.length !== 3 || !["capture", "validate"].includes(command)) throw refused("command");
    const result = command === "capture" ? await capture() : await validateCoordinatePreviewUpload();
    console.log(JSON.stringify({ valid: true, ...result }));
    if (command === "capture") process.exitCode = coordinatePreviewExitCode(result);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "scrydex-coordinate-preview-refused");
    process.exitCode = 1;
  }
}
