import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { runScrydexCoordinatePreview } from "../bounded-contexts/catalog/features/scope-sync-batches/api/scrydex-coordinate-preview-runner.ts";
import {
  classifyScrydexCoordinatePreviewRequest,
  buildScrydexCoordinatePreviewReceipt,
  scrydexCoordinatePreviewUnits,
  scrydexCoordinatePreviewArtifactPath,
  scrydexCoordinatePreviewJourneyScope,
  scrydexCoordinatePreviewMaxBytes,
  scrydexCoordinatePreviewOrigin,
  validateScrydexCoordinatePreviewReceipt,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-coordinate-preview.ts";
import {
  decodeScrydexAcceptedMappings,
  decodeScrydexCacheCaptureOptionPage,
  decodeScrydexCacheCaptureProfiles,
  decodeScrydexCacheCaptureScopePage,
  scrydexCacheCaptureContinuationPath,
  scrydexCacheCaptureCoordinate,
  scrydexCacheCaptureQueryHrefUnit,
  scrydexCacheCaptureCoveragePath,
  scrydexCacheCaptureClockSkewToleranceMs,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-cache-capture.ts";
import { buildCatalogPrimaryWorkbenchSourceOptionRequests } from "../bounded-contexts/catalog/features/source-observations/ui/primary-workbench-source-options.ts";
import { selectStagingDeployGeneration } from "./staging-deploy-generation.mjs";

export const coordinatePreviewReadDeadlineMs = 30_000;
export const coordinatePreviewDeployWindowSeconds = 86_400;
const origin = scrydexCoordinatePreviewOrigin;
const refused = (reason) => new Error(`scrydex-coordinate-preview-refused:${reason}`);

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

export function classifyScrydexCoordinatePreviewRouteRequest(request, phase = "capture") {
  const method = typeof request.method === "function" ? request.method() : request.method;
  const url = typeof request.url === "function" ? request.url() : request.url;
  return classifyScrydexCoordinatePreviewRequest({
    method: String(method),
    url,
    phase,
    navigation: typeof request.isNavigationRequest === "function" ? request.isNavigationRequest() : false,
  });
}

export function createCoordinatePreviewRouteHandler({ observed, refusals, getPhase }) {
  return async (route) => {
    const verdict = classifyScrydexCoordinatePreviewRouteRequest(route.request(), getPhase());
    if (verdict.allowed) {
      const key = {
        "sign-in": "signIn",
        "profile-read": "profileReads",
        "scope-inventory-read": "scopeInventoryReads",
        "coverage-read": "coverageReads",
        "cache-option-read": "cacheOptionReads",
        "usage-read": "usageReads",
        preview: "previewPosts",
      }[verdict.requestClass];
      if (
        (verdict.requestClass === "preview" || verdict.requestClass === "usage-read") &&
        observed[key] >= 1
      ) {
        const reason = `duplicate-${verdict.requestClass}`;
        refusals.push(reason);
        observed.forbidden += 1;
        return route.abort("blockedbyclient");
      }
      if (key) observed[key] += 1;
    }
    if (!verdict.allowed) {
      refusals.push(verdict.reason);
      observed.forbidden += 1;
      return route.abort("blockedbyclient");
    }
    return route.continue();
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
  return { generation: { ...result.deployGeneration, imageDigest: result.deployment.imageDigest }, stop: null };
}

async function readJson(page, path) {
  const response = await page.evaluate(
    async ({ path }) => {
      const result = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json" },
      });
      return { status: result.status, body: await result.json().catch(() => null) };
    },
    { path },
  );
  if (response.status !== 200) throw refused(`read:${response.status}`);
  return response.body;
}

export async function buildProducer(page, observed = {}) {
  const profilesEnvelope = await readJson(page, "/api/catalog/source-observations/provider-profiles");
  const usage = await readJson(
    page,
    "/api/catalog/source-observations/integration-control-plane/overview?audience=daily",
  );
  if (!usage?.providerReadiness?.providers?.some((provider) => provider.providerKey === "scrydex"))
    throw refused("usage-unavailable");
  const decodedProfiles = decodeScrydexCacheCaptureProfiles(profilesEnvelope);
  if (!decodedProfiles.ok) throw refused(decodedProfiles.reason);
  const profiles = decodedProfiles.profiles;
  const inventories = {};
  for (const productDomain of ["one-piece", "lorcana"]) {
    const body = await readJson(
      page,
      `/api/catalog/scope-records?productDomain=${productDomain}&scopeKind=set&status=active&limit=200&offset=0`,
    );
    const decoded = decodeScrydexCacheCaptureScopePage(body, { productDomain });
    if (!decoded.ok) throw refused(decoded.reason);
    inventories[productDomain] = decoded.scopeRecordIds;
  }
  async function readCoverage(scopeRecordId, productDomain) {
    const body = await readJson(page, scrydexCacheCaptureCoveragePath(scopeRecordId));
    const decoded = decodeScrydexAcceptedMappings(body, { scopeRecordId, productDomain });
    if (!decoded.ok) throw refused(decoded.reason);
    return decoded.mappings;
  }
  const selected = [];
  for (const productDomain of ["one-piece", "lorcana"]) {
    const requiredUnits = scrydexCoordinatePreviewUnits
      .filter((unit) => unit.productDomain === productDomain)
      .map((unit) => unit.unitKey);
    for (const scopeRecordId of [...(inventories[productDomain] ?? [])].sort()) {
      const mappings = await readCoverage(scopeRecordId, productDomain);
      if (requiredUnits.every((unitKey) => mappings.some((mapping) => mapping.unitKey === unitKey))) {
        selected.push({ scopeRecordId, productDomain });
        break;
      }
    }
  }
  if (selected.length !== 2) throw refused("two-scopes-unavailable");
  async function readSnapshot() {
    const coverage = await Promise.all(
      selected.map(async (scope) => {
        return {
          scope,
          mappings: (await readCoverage(scope.scopeRecordId, scope.productDomain)).map((mapping) => ({
            ...mapping,
            scopeRecordId: scope.scopeRecordId,
          })),
        };
      }),
    );
    const mappings = coverage.flatMap(({ mappings }) => mappings);
    const selectedMappings = mappings.filter((mapping) =>
      scrydexCoordinatePreviewUnits.some((unit) => unit.unitKey === mapping.unitKey),
    );
    if (new Set(selectedMappings.map((mapping) => mapping.unitKey)).size !== scrydexCoordinatePreviewUnits.length)
      throw refused("mapping-unresolved");
    const rows = [];
    for (const { unitKey: unit, productDomain } of scrydexCoordinatePreviewUnits) {
      const mapping = selectedMappings.find((candidate) => candidate.unitKey === unit);
      const scope =
        selected.find((candidate) => candidate.scopeRecordId === mapping?.scopeRecordId) ??
        selected.find((candidate) => candidate.productDomain === productDomain);
      if (!mapping || !scope) throw refused(`mapping-unresolved:${unit}`);
      const request = buildCatalogPrimaryWorkbenchSourceOptionRequests({
        requestUrl: `${origin}/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(unit)}`,
        scopes: [],
        profiles,
        cacheOnly: true,
      }).find((candidate) => candidate.scope === "set-name" && candidate.parentScope === null);
      if (!request || !request.profileKey || scrydexCacheCaptureQueryHrefUnit(request.queryHref) !== unit)
        throw refused(`option-request-unresolved:${unit}`);
      let response = await readJson(page, request.queryHref);
      let decoded = decodeScrydexCacheCaptureOptionPage(response, { cursor: null });
      if (!decoded.ok) throw refused(decoded.reason);
      const first = decoded.page;
      const values = [...first.values];
      let pageCount = 1;
      const seenCursors = new Set();
      let cursor = first.nextCursor;
      while (cursor !== null) {
        if (pageCount > 100) throw refused(`cache-continuation-cap:${unit}`);
        if (seenCursors.has(cursor)) throw refused(`cache-cursor-stalled:${unit}`);
        seenCursors.add(cursor);
        response = await readJson(page, scrydexCacheCaptureContinuationPath(request.queryHref, cursor));
        decoded = decodeScrydexCacheCaptureOptionPage(response, { cursor });
        if (!decoded.ok) throw refused(decoded.reason);
        if (
          decoded.page.cache.cacheKey !== first.cache.cacheKey ||
          decoded.page.cache.fetchedAt !== first.cache.fetchedAt ||
          decoded.page.cache.expiresAt !== first.cache.expiresAt ||
          decoded.page.cache.staleUntil !== first.cache.staleUntil
        )
          throw refused(`cache-identity-changed:${unit}`);
        pageCount += 1;
        values.push(...decoded.page.values);
        cursor = decoded.page.nextCursor;
      }
      if (values.length !== first.total) throw refused(`cache-incomplete:${unit}`);
      const coordinate = scrydexCacheCaptureCoordinate(mapping, scope.scopeRecordId);
      if (!coordinate || !values.includes(coordinate)) throw refused(`cache-membership:${unit}`);
      const completedAt = new Date().toISOString();
      if (Date.parse(completedAt) >= Date.parse(first.cache.staleUntil) - scrydexCacheCaptureClockSkewToleranceMs)
        throw refused(`cache-stale:${unit}`);
      rows.push({
        scopeRecordId: scope.scopeRecordId,
        productDomain,
        previewFingerprint: "",
        resolvedAt: "",
        previewRevision: "",
        unitKey: unit,
        mapping: {
          mappingId: mapping.mappingId,
          unitKey: unit,
          version: mapping.version,
          reviewStatus: mapping.reviewStatus,
          setId: mapping.setId,
          setName: mapping.setName,
          coordinate,
          membership: "member",
        },
        profileKey: request.profileKey,
        profileVersion: request.profileVersion,
        setId: mapping.setId,
        setName: mapping.setName,
        cacheKey: first.cache.cacheKey,
        cacheFetchedAt: first.cache.fetchedAt,
        cacheExpiresAt: first.cache.expiresAt,
        cacheStaleUntil: first.cache.staleUntil,
      });
    }
    return {
      rows,
      cacheIdentity: rows
        .map((row) => ({
          unitKey: row.unitKey,
          cacheKey: row.cacheKey,
          cacheFetchedAt: row.cacheFetchedAt,
          cacheExpiresAt: row.cacheExpiresAt,
          cacheStaleUntil: row.cacheStaleUntil,
          mappingId: row.mapping.mappingId,
          version: row.mapping.version,
          reviewStatus: row.mapping.reviewStatus,
        }))
        .sort((a, b) => a.unitKey.localeCompare(b.unitKey)),
    };
  }
  const beforeEvidence = await readSnapshot();
  const previewResponse = await page.evaluate(
    async (scopeRecordIds) => {
      const response = await fetch("/api/catalog/scope-sync-batches/preview", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          selection: { mode: "ids", scopeRecordIds },
        }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    selected.map((scope) => scope.scopeRecordId),
  );
  if (previewResponse.status !== 200) throw refused(`preview:${previewResponse.status}`);
  const preview = previewResponse.body;
  const afterEvidence = await readSnapshot();
  if (JSON.stringify(beforeEvidence.cacheIdentity) !== JSON.stringify(afterEvidence.cacheIdentity))
    throw refused("bracket-changed");
  const rows = afterEvidence.rows.map((row) => ({
    ...row,
    previewFingerprint: preview.planFingerprint,
    resolvedAt: preview.resolvedAt,
    previewRevision: preview.previewVersion ?? "scope-sync-batch-preview-v1",
  }));
  return {
    preview,
    rows,
    observedRequests: observed,
    observedUsageRead: { count: observed.usageReads ?? 0, allowed: (observed.usageReads ?? 0) === 1 },
    phases: ["coverage", "cache", "preview", "coverage", "cache", "pre-confirm"],
  };
}

export async function captureCoordinatePreview(env = process.env) {
  const runner = coordinatePreviewRunnerIdentity(env);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ recordHar: undefined });
  const page = await context.newPage();
  const requests = [];
  const observed = {
    signIn: 0,
    profileReads: 0,
    scopeInventoryReads: 0,
    coverageReads: 0,
    cacheOptionReads: 0,
    usageReads: 0,
    previewPosts: 0,
    forbidden: 0,
  };
  let phase = "sign-in";
  await page.route("**/*", createCoordinatePreviewRouteHandler({ observed, refusals: requests, getPhase: () => phase }));
  try {
    const receipt = await runScrydexCoordinatePreview({
      runner,
      credentialsPresent: Boolean(env.CATALOG_ADMIN_E2E_EMAIL && env.CATALOG_ADMIN_E2E_PASSWORD),
      selectDeployment: () => selectCoordinatePreviewDeployment(env.GH_TOKEN),
      signIn: async () => {
        phase = "sign-in";
        await page.goto(`${origin}/access/sign-in?returnTo=${encodeURIComponent("/catalog/scopes/sync-batches")}`, {
          waitUntil: "domcontentloaded",
        });
        await page.getByRole("textbox", { name: /email|phone/i }).fill(env.CATALOG_ADMIN_E2E_EMAIL);
        await page.getByRole("button", { name: /continue/i }).click();
        const password = page.locator('input[name="password"], input[type="password"]').first();
        if (await password.isVisible()) await password.fill(env.CATALOG_ADMIN_E2E_PASSWORD);
        await page.getByRole("button", { name: /sign in/i }).click();
        await page.waitForURL(`${origin}/catalog/scopes/sync-batches`);
        phase = "capture";
      },
      produce: async () => {
        phase = "pre-confirm";
        try {
          return await buildProducer(page, observed);
        } finally {
          phase = "capture";
        }
      },
      now: () => new Date().toISOString(),
    });
    const finalReceipt = buildScrydexCoordinatePreviewReceipt({
      ...receipt,
      requests: { ...receipt.requests, ...observed, forbidden: observed.forbidden },
      forbiddenCalls: [...receipt.forbiddenCalls, ...requests].slice(0, 100),
      outcome: receipt.outcome,
      reasons: receipt.reasons,
    });
    await writeCoordinatePreviewArtifact(finalReceipt, env);
    return finalReceipt;
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function writeCoordinatePreviewArtifact(receipt, env = process.env, workspace = process.cwd()) {
  const errors = (
    await import("../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-coordinate-preview.ts")
  ).validateScrydexCoordinatePreviewReceipt(receipt);
  if (errors.length) throw refused(`receipt:${errors.slice(0, 3).join(",")}`);
  const serialized = JSON.stringify(receipt);
  if (Buffer.byteLength(serialized) > scrydexCoordinatePreviewMaxBytes) throw refused("artifact-too-large");
  const path = join(resolve(workspace), scrydexCoordinatePreviewArtifactPath);
  await mkdir(join(resolve(workspace), "artifacts/catalog-scrydex-coordinate-preview"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(path, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}

export async function validateCoordinatePreviewArtifact(workspace = process.cwd()) {
  const path = join(resolve(workspace), scrydexCoordinatePreviewArtifactPath);
  const receipt = JSON.parse(await readFile(path, "utf8"));
  const errors = (
    await import("../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-coordinate-preview.ts")
  ).validateScrydexCoordinatePreviewReceipt(receipt);
  if (errors.length) throw refused(`receipt:${errors.slice(0, 3).join(",")}`);
  return receipt.outcome;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const command = process.argv[2] ?? "capture";
  if (command === "capture") await captureCoordinatePreview();
  else if (command === "validate") {
    const outcome = await validateCoordinatePreviewArtifact();
    if (process.env.GITHUB_OUTPUT)
      await writeFile(process.env.GITHUB_OUTPUT, `capture_status=${outcome}\n`, { flag: "a" });
    console.log(outcome);
  } else throw refused("command");
}
