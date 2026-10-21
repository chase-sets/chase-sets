import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogPrimaryWorkbenchSourceOptionRequests } from "../bounded-contexts/catalog/features/source-observations/ui/primary-workbench-source-options.ts";
import { scrydexCacheCaptureUnits } from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-cache-capture.ts";
import {
  buildScrydexOptionRefreshReceipt,
  classifyScrydexOptionRefreshRequest,
  evaluateScrydexUsagePreflight,
  providerPagesUpperBound,
  scrydexOptionRefreshArtifactPath,
  scrydexOptionRefreshDiagnosticArtifactPath,
  scrydexOptionRefreshJourneyScope,
  scrydexOptionRefreshMaxBytes,
  scrydexOptionRefreshOrigin,
  scrydexOptionRefreshPageSize,
  validateScrydexOptionRefreshReceipt,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-option-refresh.ts";
import { selectStagingDeployGeneration } from "./staging-deploy-generation.mjs";

export const refreshReadDeadlineMs = 30_000;
export const refreshDeployWindowSeconds = 86_400;
const forbiddenNames = ["CATALOG_ADMIN_E2E_EMAIL", "CATALOG_ADMIN_E2E_PASSWORD", "GH_TOKEN"];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const refused = (reason) => new Error(`scrydex-option-refresh-refused:${reason}`);

export function refreshRunnerIdentity(env) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.ADMIN_WEB_URL !== scrydexOptionRefreshOrigin ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    env.EXPECTED_SHA !== env.GITHUB_SHA ||
    !/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    env.CATALOG_STAGING_PROVIDER_UAT_SCOPE !== scrydexOptionRefreshJourneyScope ||
    !env.RUNNER_TEMP
  )
    throw refused("runner-identity");
  return {
    sha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    journeyScope: scrydexOptionRefreshJourneyScope,
    origin: new URL(scrydexOptionRefreshOrigin).host,
  };
}

export function selectRefreshRequests(profiles, unitKey) {
  return buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl: `${scrydexOptionRefreshOrigin}/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(unitKey)}`,
    scopes: [],
    profiles,
    cacheOnly: false,
  }).filter((request) => request.scope === "set-name" && request.parentScope === null && request.queryKind === "sets");
}

export function refreshReadByteCap() {
  return 1_000_000;
}

export async function runScrydexOptionRefresh(input) {
  const startedAt = input.now();
  const identity = input.runner;
  const failures = [];
  const units = scrydexCacheCaptureUnits.map(({ unitKey }) => ({
    unitKey,
    status: "not-attempted",
    httpStatus: null,
    cache: null,
    total: null,
    providerPagesUpperBound: null,
    completedAt: null,
  }));
  let before = null;
  let after = null;
  let preflight = {
    creditBalance: null,
    creditAllowance: null,
    observedAt: null,
    readiness: "unknown",
    freshness: "never-observed",
  };
  let forced = 0;
  let refusals = 0;
  let outcome = "stopped";
  try {
    before = await input.selectDeployment();
    if (!before) throw refused("deployment-before");
    await input.signIn();
    const overview = await input.read(
      "/api/catalog/source-observations/integration-control-plane/overview?audience=daily",
    );
    const provider = overview?.providerReadiness?.providers?.find((candidate) => candidate.providerKey === "scrydex");
    const gate = evaluateScrydexUsagePreflight({
      ...provider,
      providerKey: provider?.providerKey,
      providerReadiness: provider?.readiness,
    });
    preflight = gate.preflight;
    if (!gate.admitted) throw refused(gate.reason);
    const profiles = await input.read("/api/catalog/source-observations/provider-profiles");
    for (let index = 0; index < units.length; index += 1) {
      const unit = units[index];
      const requests = selectRefreshRequests(profiles, unit.unitKey);
      if (requests.length !== 1) throw refused(`request-unresolved:${unit.unitKey}`);
      const verdict = classifyScrydexOptionRefreshRequest(
        { method: "GET", url: requests[0].refreshHref },
        new Set(
          units.filter((candidate) => candidate.status !== "not-attempted").map((candidate) => candidate.unitKey),
        ),
      );
      if (!verdict.allowed) throw refused(`${verdict.reason}:${unit.unitKey}`);
      forced += 1;
      let response;
      try {
        response = await input.read(requests[0].refreshHref);
      } catch {
        unit.status = "uncertain";
        failures.push(`request-uncertain:${unit.unitKey}`);
        break;
      }
      unit.httpStatus = response.status;
      unit.completedAt = input.now();
      const body = response.body;
      const cache = body?.cache;
      const total = body?.total;
      if (
        response.status !== 200 ||
        !cache ||
        (cache.status !== "bypass" && cache.status !== "live") ||
        cache.source !== "live" ||
        !Number.isInteger(total) ||
        total > 1000
      ) {
        unit.status = response.status === 200 && Number.isInteger(total) && total > 1000 ? "uncertain" : "uncertain";
        unit.total = null;
        unit.providerPagesUpperBound = null;
        unit.cache = null;
        failures.push(
          response.status !== 200 ? `http:${response.status}:${unit.unitKey}` : `response-uncertain:${unit.unitKey}`,
        );
        break;
      }
      unit.status = cache.status;
      unit.cache = {
        status: cache.status,
        source: cache.source,
        fetchedAt: cache.fetchedAt,
        expiresAt: cache.expiresAt,
        staleUntil: cache.staleUntil,
      };
      unit.total = total;
      unit.providerPagesUpperBound = providerPagesUpperBound(total);
    }
    if (forced === 5 && units.every((unit) => unit.status === "bypass" || unit.status === "live")) outcome = "complete";
    else outcome = "stopped";
  } catch (error) {
    refusals += 1;
    failures.push(error instanceof Error ? error.message.replace(/^scrydex-option-refresh-refused:/, "") : "refused");
    outcome = forced === 0 ? "refused" : "stopped";
  } finally {
    after = await input.selectDeployment().catch(() => null);
  }
  const creditsSpentUpperBound = units.reduce((sum, unit) => sum + (unit.providerPagesUpperBound ?? 0), 0) + 1;
  const receipt = buildScrydexOptionRefreshReceipt({
    outcome,
    reason: failures[0] ?? null,
    runner: identity,
    deployment: {
      beforeSha: before?.deployedHead ?? null,
      beforeImageDigest: before?.imageDigest ?? null,
      afterSha: after?.deployedHead ?? null,
      afterImageDigest: after?.imageDigest ?? null,
    },
    startedAt,
    finishedAt: input.now(),
    preflight,
    requests: { forced, refusals },
    units,
    creditsSpentUpperBound,
    assumptions: [
      `provider page size ${scrydexOptionRefreshPageSize}`,
      "one usage read",
      "up to 100 dropped records covered by +1 page",
    ],
  });
  return receipt;
}

export async function writeRefreshArtifact(receipt, env, workspace = process.cwd()) {
  const errors = validateScrydexOptionRefreshReceipt(receipt);
  const serialized = JSON.stringify(receipt);
  if (
    errors.length ||
    Buffer.byteLength(serialized) > scrydexOptionRefreshMaxBytes ||
    forbiddenNames.some((name) => env[name] && serialized.includes(env[name]))
  )
    throw refused("receipt-invalid");
  const path = resolve(
    workspace,
    receipt.outcome === "complete" ? scrydexOptionRefreshArtifactPath : scrydexOptionRefreshDiagnosticArtifactPath,
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await readdir(dirname(path))).length !== 0) throw refused("artifact-directory-not-empty");
  await writeFile(path, serialized, { flag: "wx", mode: 0o600 });
  return { path, sha256: sha256(serialized) };
}

export async function capture(env = process.env, workspace = process.cwd()) {
  const runner = refreshRunnerIdentity(env);
  let browser;
  let page;
  let phase = "sign-in";
  const receipt = await runScrydexOptionRefresh({
    runner,
    now: () => new Date().toISOString(),
    selectDeployment: async () => {
      const result = await selectStagingDeployGeneration({
        token: env.GH_TOKEN,
        requestTimeoutMs: refreshReadDeadlineMs,
        now: new Date().toISOString(),
        maxAgeSeconds: refreshDeployWindowSeconds,
      });
      return result.stop || !result.deployGeneration
        ? null
        : {
            deployedHead: result.deployGeneration.deployedHead ?? result.deployGeneration.sha,
            imageDigest: result.deployment?.imageDigest ?? result.deployGeneration.imageDigest,
          };
    },
    signIn: async () => {
      const { chromium } = await import("@playwright/test");
      browser = await chromium.launch();
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== scrydexOptionRefreshOrigin || /tcgplayer/i.test(url.href))
          return route.abort("blockedbyclient");
        if (phase === "refresh") {
          const verdict = classifyScrydexOptionRefreshRequest({ method: request.method(), url: request.url() });
          if (!verdict.allowed && !url.pathname.startsWith("/api/catalog/source-observations/"))
            return route.abort("blockedbyclient");
        }
        return route.continue();
      });
      page = await context.newPage();
      await page.goto(`${scrydexOptionRefreshOrigin}/access/sign-in?returnTo=%2Fcatalog%2Fintegrations`);
      await page.getByRole("textbox", { name: /email|phone/i }).fill(env.CATALOG_ADMIN_E2E_EMAIL);
      await page.getByRole("button", { name: /continue/i }).click();
      await page.locator('input[name="password"], input[type="password"]').first().fill(env.CATALOG_ADMIN_E2E_PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).click();
      phase = "refresh";
    },
    read: async (path) => {
      if (!page) throw refused("page-missing");
      return page.evaluate(
        async (target) => {
          const response = await fetch(target, {
            method: "GET",
            credentials: "same-origin",
            redirect: "error",
            cache: "no-store",
            headers: { accept: "application/json" },
          });
          return { status: response.status, body: response.status === 200 ? await response.json() : null };
        },
        path.startsWith("http") ? path : `${scrydexOptionRefreshOrigin}${path}`,
      );
    },
  });
  await browser?.close();
  await writeRefreshArtifact(receipt, env, workspace);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "validate") process.exitCode = 0;
  else
    capture().catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
