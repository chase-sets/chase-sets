import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogPrimaryWorkbenchSourceOptionRequests } from "../bounded-contexts/catalog/features/source-observations/ui/primary-workbench-source-options.ts";
import {
  scrydexCacheCaptureLandingPath,
  scrydexCacheCaptureUnits,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-cache-capture.ts";
import {
  buildScrydexOptionRefreshReceipt,
  classifyScrydexOptionRefreshRequest,
  evaluateScrydexOptionRefreshAdmission,
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
    limit: scrydexOptionRefreshPageSize,
  }).filter((request) => request.scope === "set-name" && request.parentScope === null && request.queryKind === "sets");
}

export function refreshReadByteCap() {
  return 1_000_000;
}

export function classifyScrydexOptionRefreshRouteRequest(request) {
  const method = typeof request.method === "function" ? request.method() : request.method;
  const requestUrl = typeof request.url === "function" ? request.url() : request.url;
  let url;
  try {
    url = new URL(requestUrl, scrydexOptionRefreshOrigin);
  } catch {
    return { allowed: false, reason: "unparseable-url" };
  }
  if (url.origin !== scrydexOptionRefreshOrigin) return { allowed: false, reason: "cross-origin" };
  if (String(method).toUpperCase() !== "GET") return { allowed: false, reason: "mutation" };
  if (url.pathname === "/api/catalog/source-observations/integration-control-plane/overview") {
    const keys = [...url.searchParams.keys()];
    return keys.length === 1 && url.searchParams.get("audience") === "daily"
      ? { allowed: true, reason: "overview-preflight" }
      : { allowed: false, reason: "overview-query" };
  }
  if (url.pathname === "/api/catalog/source-observations/provider-profiles") {
    return url.search === ""
      ? { allowed: true, reason: "provider-profiles-preflight" }
      : { allowed: false, reason: "profiles-query" };
  }
  return classifyScrydexOptionRefreshRequest({ method: String(method), url: url.href });
}

export function applyScrydexOptionRefreshRouteFence(route, phase) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== scrydexOptionRefreshOrigin || /tcgplayer/i.test(url.href)) return route.abort("blockedbyclient");
  if (phase === "refresh" && !classifyScrydexOptionRefreshRouteRequest(request).allowed)
    return route.abort("blockedbyclient");
  return route.continue();
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
  let interruptedUnit = null;
  let periodDecision = null;
  try {
    before = await input.selectDeployment();
    if (!before) throw refused("deployment-before");
    await input.signIn();
    const overviewResponse = await input.read(
      "/api/catalog/source-observations/integration-control-plane/overview?audience=daily",
    );
    const overview = overviewResponse?.body ?? overviewResponse;
    const provider = overview?.providerReadiness?.providers?.find((candidate) => candidate.providerKey === "scrydex");
    const gate = evaluateScrydexOptionRefreshAdmission({
      provider: {
        ...provider,
        providerKey: provider?.providerKey,
        providerReadiness: provider?.readiness,
      },
      providerSendWindow: overview?.providerSendWindow,
      rolloutControls: overview?.readiness?.rolloutControls,
      unitKeys: units.map((unit) => unit.unitKey),
      periodReserve: input.periodReserve,
      runId: `${identity.runId}:${identity.runAttempt}`,
      now: input.now(),
    });
    preflight = gate.preflight;
    periodDecision = gate.decision ?? null;
    if (!gate.admitted) throw refused(gate.reason);
    const profileEnvelope = await input.read("/api/catalog/source-observations/provider-profiles");
    const profiles = profileEnvelope?.body?.items ?? profileEnvelope?.items;
    if (!Array.isArray(profiles)) throw refused("profiles-invalid");
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
      const age = Date.parse(input.now()) - Date.parse(periodDecision?.observedAt ?? "");
      if (!Number.isFinite(age) || age < 0 || age > 900_000 ||
        Date.parse(input.now()) >= Date.parse(periodDecision?.period?.endsAt ?? ""))
        throw refused("usage-period-cap");
      forced += 1;
      interruptedUnit = unit;
      unit.status = "uncertain";
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
      interruptedUnit = null;
    }
    if (forced === 5 && units.every((unit) => unit.status === "bypass" || unit.status === "live")) outcome = "complete";
    else outcome = "stopped";
  } catch (error) {
    refusals += 1;
    const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "Error";
    failures.push(
      error instanceof Error && error.message.startsWith("scrydex-option-refresh-refused:")
        ? error.message.slice("scrydex-option-refresh-refused:".length)
        : `runner-error:${name}`,
    );
    if (interruptedUnit) {
      Object.assign(interruptedUnit, {
        status: "uncertain",
        httpStatus: null,
        cache: null,
        total: null,
        providerPagesUpperBound: null,
        completedAt: null,
      });
    }
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
    periodLedger: periodDecision ? {
      decision: periodDecision,
      outcome: outcome === "complete" ? "complete" : forced === 0 ? "refused" : "uncertain",
      unreflectedCredits: outcome === "complete" ? creditsSpentUpperBound : forced === 0 ? 1 : periodDecision.plannedCredits,
    } : null,
  });
  return receipt;
}

export async function writeRefreshArtifact(
  receipt,
  env,
  workspace = process.cwd(),
  { maxBytes = scrydexOptionRefreshMaxBytes } = {},
) {
  const serialized = JSON.stringify(receipt);
  const errors = validateScrydexOptionRefreshReceipt(JSON.parse(serialized));
  const rejection =
    errors.length > 0
      ? "schema"
      : Buffer.byteLength(serialized) > maxBytes
        ? "size"
        : forbiddenNames.some((name) => env[name] && serialized.includes(env[name]))
          ? "credential"
          : null;
  if (rejection) {
    const count = (value) => (Number.isSafeInteger(value) && value >= 0 && value <= 56 ? value : null);
    const diagnostics = {
      class: rejection,
      errors: errors
        .slice(0, 20)
        .filter((error) => !forbiddenNames.some((name) => env[name] && error.includes(env[name]))),
      requests: { forced: count(receipt?.requests?.forced) },
      creditsSpentUpperBound: count(receipt?.creditsSpentUpperBound),
    };
    throw refused(`receipt-invalid:${JSON.stringify(diagnostics)}`);
  }
  const path = resolve(
    workspace,
    receipt.outcome === "complete" ? scrydexOptionRefreshArtifactPath : scrydexOptionRefreshDiagnosticArtifactPath,
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await readdir(dirname(path))).length !== 0) throw refused("artifact-directory-not-empty");
  await writeFile(path, serialized, { flag: "wx", mode: 0o600 });
  return { path, sha256: sha256(serialized) };
}

export async function validateRefreshUpload(env = process.env, workspace = process.cwd()) {
  const identity = refreshRunnerIdentity(env);
  const candidates = [];
  for (const path of [scrydexOptionRefreshArtifactPath, scrydexOptionRefreshDiagnosticArtifactPath]) {
    const fullPath = resolve(workspace, path);
    const info = await lstat(fullPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw refused("artifact-unreadable");
    });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.size > scrydexOptionRefreshMaxBytes)
      throw refused("artifact-size-or-type");
    candidates.push(fullPath);
  }
  if (candidates.length !== 1) throw refused("artifact-count");
  const bytes = await readFile(candidates[0]);
  if (bytes.byteLength > scrydexOptionRefreshMaxBytes) throw refused("artifact-size-or-type");
  const serialized = bytes.toString("utf8");
  if (forbiddenNames.some((name) => env[name] && serialized.includes(env[name]))) throw refused("artifact-credential");
  let receipt;
  try {
    receipt = JSON.parse(serialized);
  } catch {
    throw refused("artifact-json");
  }
  if (validateScrydexOptionRefreshReceipt(receipt).length > 0) throw refused("artifact-schema");
  if (JSON.stringify(receipt.runner) !== JSON.stringify(identity)) throw refused("artifact-runner");
  const expectedPath =
    receipt.outcome === "complete" ? scrydexOptionRefreshArtifactPath : scrydexOptionRefreshDiagnosticArtifactPath;
  if (candidates[0] !== resolve(workspace, expectedPath)) throw refused("artifact-outcome-path");
  if (!env.GITHUB_OUTPUT) throw refused("output-missing");
  await appendFile(env.GITHUB_OUTPUT, `refresh_outcome=${receipt.outcome}\n`);
  return receipt.outcome;
}

export async function signInForRefresh(page, env, enterRefresh) {
  await page.goto(
    `${scrydexOptionRefreshOrigin}/access/sign-in?returnTo=${encodeURIComponent(scrydexCacheCaptureLandingPath)}`,
    {
      waitUntil: "domcontentloaded",
    },
  );
  await page.getByRole("textbox", { name: /email|phone/i }).fill(env.CATALOG_ADMIN_E2E_EMAIL);
  await page.getByRole("button", { name: /continue/i }).click();
  const passwordChoice = page.getByRole("radio", { name: /^Password$/ });
  if (await passwordChoice.isVisible()) await passwordChoice.check();
  await page.locator('input[name="password"], input[type="password"]').first().fill(env.CATALOG_ADMIN_E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(`${scrydexOptionRefreshOrigin}${scrydexCacheCaptureLandingPath}`);
  enterRefresh();
}

export async function readRefreshJsonInPage({ path, byteCap, deadlineMs }) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await fetch(path, {
      method: "GET",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, body: null };
    }
    if (!response.body) throw new Error("refresh-read-refused");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > byteCap) throw new Error("refresh-read-refused");
        text += decoder.decode(chunk.value, { stream: true });
      }
      return { status: response.status, body: JSON.parse(text + decoder.decode()) };
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    clearTimeout(deadline);
  }
}

export async function capture(env = process.env, workspace = process.cwd()) {
  const runner = refreshRunnerIdentity(env);
  let browser;
  let page;
  let phase = "sign-in";
  const receipt = await runScrydexOptionRefresh({
    runner,
    periodReserve: (() => {
      try { return JSON.parse(env.SCRYDEX_REFRESH_PERIOD_RESERVE ?? "null"); } catch { return null; }
    })(),
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
      await context.route("**/*", (route) => applyScrydexOptionRefreshRouteFence(route, phase));
      page = await context.newPage();
      await signInForRefresh(page, env, () => {
        phase = "refresh";
      });
    },
    read: async (path) => {
      if (!page) throw refused("page-missing");
      return page.evaluate(readRefreshJsonInPage, {
        path: path.startsWith("http") ? path : `${scrydexOptionRefreshOrigin}${path}`,
        byteCap: refreshReadByteCap(),
        deadlineMs: refreshReadDeadlineMs,
      });
    },
  });
  await browser?.close();
  await writeRefreshArtifact(receipt, env, workspace);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "validate") await validateRefreshUpload();
    else if (process.argv.length === 2) await capture();
    else throw refused("command");
  } catch (error) {
    const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "Error";
    console.error(
      error instanceof Error && error.message.startsWith("scrydex-option-refresh-refused:")
        ? error.message
        : `scrydex-option-refresh-refused:runner-error:${name}`,
    );
    process.exitCode = 1;
  }
}
