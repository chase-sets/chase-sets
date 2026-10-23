import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { runScrydexCoordinatePreview } from "../bounded-contexts/catalog/features/scope-sync-batches/api/scrydex-coordinate-preview-runner.ts";
import {
  classifyScrydexCoordinatePreviewRequest,
  scrydexCoordinatePreviewUnits,
  scrydexCoordinatePreviewArtifactPath,
  scrydexCoordinatePreviewJourneyScope,
  scrydexCoordinatePreviewMaxBytes,
  scrydexCoordinatePreviewOrigin,
  validateScrydexCoordinatePreviewReceipt,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-coordinate-preview.ts";
import { buildCatalogPrimaryWorkbenchSourceOptionRequests } from "../bounded-contexts/catalog/features/source-observations/ui/primary-workbench-source-options.ts";
import { selectStagingDeployGeneration } from "./staging-deploy-generation.mjs";

export const coordinatePreviewReadDeadlineMs = 30_000;
export const coordinatePreviewDeployWindowSeconds = 86_400;
const origin = scrydexCoordinatePreviewOrigin;
const refused = (reason) => new Error(`scrydex-coordinate-preview-refused:${reason}`);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

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

async function buildProducer(page) {
  const profilesEnvelope = await readJson(page, "/api/catalog/source-observations/provider-profiles");
  const usage = await readJson(
    page,
    "/api/catalog/source-observations/integration-control-plane/overview?audience=daily",
  );
  if (!usage?.providerReadiness?.providers?.some((provider) => provider.providerKey === "scrydex"))
    throw refused("usage-unavailable");
  const profiles = profilesEnvelope.items ?? [];
  const inventories = {};
  for (const productDomain of ["one-piece", "lorcana"]) {
    const body = await readJson(
      page,
      `/api/catalog/scope-records?productDomain=${productDomain}&scopeKind=set&status=active&limit=200&offset=0`,
    );
    inventories[productDomain] = body.items ?? [];
  }
  const selected = [inventories["one-piece"]?.[0], inventories.lorcana?.[0]].filter(Boolean);
  if (selected.length !== 2) throw refused("two-scopes-unavailable");
  const coverage = await Promise.all(
    selected.map(async (scope) => ({
      scope,
      body: await readJson(
        page,
        `/api/catalog/provider-scope-mappings/coverage/${encodeURIComponent(scope.scopeRecordId)}`,
      ),
    })),
  );
  const mappings = coverage.flatMap(
    ({ body }) => (body.providers ?? []).find((p) => p.providerKey === "scrydex")?.acceptedMappings ?? [],
  );
  const selectedMappings = mappings.filter(
    (mapping) => mapping.reviewStatus === "accepted" || mapping.reviewStatus === "auto-accepted",
  );
  const previewResponse = await page.evaluate(
    async (scopeRecordIds) => {
      const response = await fetch("/api/catalog/scope-sync-batches/preview", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          selection: { mode: "ids", scopeRecordIds },
          // Preview only: the high planning ceiling prevents a local quote
          // blocker; it is not an admission or a provider-send reservation.
          budget: { maxScopesPerTurn: 2, creditedProviderRequestLimits: { scrydex: 50_000 } },
        }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    selected.map((scope) => scope.scopeRecordId),
  );
  if (previewResponse.status !== 200) throw refused(`preview:${previewResponse.status}`);
  const preview = previewResponse.body;
  const rows = [];
  for (const { unitKey: unit } of scrydexCoordinatePreviewUnits) {
    const mapping = selectedMappings.find((candidate) => candidate.unitKey === unit);
    if (!mapping) throw refused(`mapping-unresolved:${unit}`);
    const request = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl: `${origin}/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(unit)}`,
      scopes: [],
      profiles,
      cacheOnly: true,
    }).find((candidate) => candidate.scope === "set-name" && candidate.parentScope === null);
    if (!request || !request.profileKey) throw refused(`option-request-unresolved:${unit}`);
    let cache = await readJson(page, new URL(request.queryHref).pathname + new URL(request.queryHref).search);
    const cacheIdentity = JSON.stringify(cache.cache ?? null);
    const values = [...(cache.items ?? [])];
    let cursor = cache.page?.nextCursor ?? null;
    let pages = 1;
    while (cursor !== null) {
      if (pages++ > 100) throw refused(`cache-continuation-cap:${unit}`);
      const next = new URL(request.queryHref);
      next.searchParams.set("cursor", cursor);
      next.searchParams.set("limit", "200");
      next.searchParams.set("cacheOnly", "true");
      next.searchParams.delete("forceRefresh");
      cache = await readJson(page, next.pathname + next.search);
      if (JSON.stringify(cache.cache ?? null) !== cacheIdentity) throw refused(`cache-identity-changed:${unit}`);
      values.push(...(cache.items ?? []));
      cursor = cache.page?.nextCursor ?? null;
    }
    if (!Number.isInteger(cache.total) || values.length !== cache.total) throw refused(`cache-incomplete:${unit}`);
    const coordinate = mapping.coordinates?.setId ?? mapping.coordinates?.setName ?? null;
    if (!coordinate || !values.some((item) => item.value === coordinate)) throw refused(`cache-membership:${unit}`);
    rows.push({
      scopeRecordId: mapping.scopeRecordId,
      productDomain: selected.find((scope) => scope.scopeRecordId === mapping.scopeRecordId)?.productDomain,
      previewFingerprint: preview.planFingerprint,
      resolvedAt: preview.resolvedAt,
      previewRevision: preview.previewVersion,
      unitKey: unit,
      mapping: {
        mappingId: mapping.mappingId,
        unitKey: unit,
        version: mapping.updatedAt,
        reviewStatus: mapping.reviewStatus,
        setId: mapping.coordinates?.setId ?? null,
        setName: mapping.coordinates?.setName ?? null,
        coordinate,
        membership: "member",
      },
      profileKey: request.profileKey,
      profileVersion: request.profileVersion,
      setId: mapping.coordinates?.setId ?? null,
      setName: mapping.coordinates?.setName ?? null,
      cacheKey: cache.cache?.cacheKey,
      cacheFetchedAt: cache.cache?.fetchedAt,
      cacheExpiresAt: cache.cache?.expiresAt,
      cacheStaleUntil: cache.cache?.staleUntil,
    });
  }
  return {
    preview,
    rows,
    requests: {
      profileReads: 1,
      scopeInventoryReads: 2,
      coverageReads: coverage.length,
      cacheOptionReads: rows.length,
      usageReads: 1,
      previewPosts: 1,
    },
    usageRead: { count: 1, allowed: true },
    phases: ["deployment-before", "sign-in", "readiness", "preview", "coverage", "cache", "pre-confirm"],
  };
}

export async function captureCoordinatePreview(env = process.env) {
  const runner = coordinatePreviewRunnerIdentity(env);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ recordHar: undefined });
  const page = await context.newPage();
  const requests = [];
  let phase = "sign-in";
  await page.route("**/*", async (route) => {
    const verdict = classifyScrydexCoordinatePreviewRouteRequest(route.request(), phase);
    if (!verdict.allowed) {
      requests.push(verdict.reason);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
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
          return await buildProducer(page);
        } finally {
          phase = "capture";
        }
      },
      now: () => new Date().toISOString(),
    });
    const finalReceipt = {
      ...receipt,
      requests: { ...receipt.requests, forbidden: receipt.requests.forbidden + requests.length },
      forbiddenCalls: [...receipt.forbiddenCalls, ...requests],
      outcome: requests.length > 0 ? "governed-unknown" : receipt.outcome,
      reasons: requests.length > 0 ? [...new Set([...receipt.reasons, "forbidden-call"])] : receipt.reasons,
    };
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
