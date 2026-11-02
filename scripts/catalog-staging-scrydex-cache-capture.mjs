import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScrydexCacheCapture } from "../bounded-contexts/catalog/features/scope-sync-batches/api/scrydex-cache-capture-runner.ts";
import { countCaptureContainsForbidden } from "../bounded-contexts/catalog/features/scope-sync-batches/domain/count-lifecycle-receipt.ts";
import {
  classifyScrydexCacheCaptureRequest,
  scrydexCacheCaptureArtifactPath,
  scrydexCacheCaptureJourneyScope,
  scrydexCacheCaptureLandingPath,
  scrydexCacheCaptureMaxBytes,
  scrydexCacheCaptureOrigin,
  scrydexCacheCaptureProfilesPath,
  validateScrydexCacheCaptureReceipt,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-cache-capture.ts";
import { buildCatalogPrimaryWorkbenchSourceOptionRequests } from "../bounded-contexts/catalog/features/source-observations/ui/primary-workbench-source-options.ts";
import { addCookieMarkers, watchSessionMarkers } from "./catalog-staging-count-lifecycle.mjs";
import { selectStagingDeployGeneration } from "./staging-deploy-generation.mjs";

// Hosted runner for the cache-only Scrydex capture. The staging Admin
// credentials and the Actions read token exist only in this job's two steps;
// a standalone Chromium (no test-runner trace, screenshot, video or storage
// state) signs in through the shared form and every request crosses the
// capture's request fence. The deployed revision is bound from the owning
// Deploy Staging job before and after the reads. One value-free refusal covers
// every identity, artifact, seal and leak failure.

const origin = scrydexCacheCaptureOrigin;
const refused = () => new Error("scrydex-cache-capture-refused");
const credentialNames = ["CATALOG_ADMIN_E2E_EMAIL", "CATALOG_ADMIN_E2E_PASSWORD", "GH_TOKEN"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifactParts = posix.dirname(scrydexCacheCaptureArtifactPath).split("/");
const artifactName = posix.basename(scrydexCacheCaptureArtifactPath);
export const captureReadDeadlineMs = 30_000;
// The deployed provider-profile roster serializes to 544,502 bytes for the 28
// registry profile versions; every other read is one bounded page (at most 200
// Scope Records or options, or one Scope Record's coverage). Both caps keep at
// least 3x headroom.
export const captureReadByteCaps = Object.freeze({ profiles: 4_000_000, page: 1_000_000 });
// The deploy generation search covers the last day of Platform Deploy runs.
export const captureDeployWindowSeconds = 86_400;

export function captureRunnerIdentity(env) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.ADMIN_WEB_URL !== origin ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    env.EXPECTED_SHA !== env.GITHUB_SHA ||
    !/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    env.CATALOG_STAGING_PROVIDER_UAT_SCOPE !== scrydexCacheCaptureJourneyScope ||
    !env.RUNNER_TEMP
  )
    throw refused();
  return {
    sha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    journeyScope: scrydexCacheCaptureJourneyScope,
    origin: new URL(origin).host,
  };
}

// The unit's deployed `queryHref`: the shipped Integrations builder over the
// deployed roster, asked for the unit route's set-name option page.
export function resolveScrydexCacheCaptureQueryHref(profiles, unitKey) {
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl: `${origin}/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(unitKey)}`,
    scopes: [],
    profiles,
    cacheOnly: true,
  }).filter((request) => request.scope === "set-name" && request.parentScope === null);
  return requests.length === 1 ? requests[0].queryHref : null;
}

export async function selectCaptureDeployment(token, select = selectStagingDeployGeneration) {
  const result = await select({
    token,
    requestTimeoutMs: captureReadDeadlineMs,
    now: new Date().toISOString(),
    maxAgeSeconds: captureDeployWindowSeconds,
  });
  if (result.stop !== null || !result.deployGeneration || !result.deployment)
    return { generation: null, stop: result.stop ?? "selection-failed" };
  return { generation: { ...result.deployGeneration, imageDigest: result.deployment.imageDigest }, stop: null };
}

export function emptyCaptureTally() {
  return {
    requests: {
      signIn: 0,
      profileReads: 0,
      scopeInventoryReads: 0,
      coverageReads: 0,
      cacheOptionReads: 0,
      ambientReadsBlocked: 0,
      fenceRefusals: 0,
    },
    fence: [],
  };
}

const allowedCounters = {
  "sign-in": "signIn",
  "profile-read": "profileReads",
  "scope-inventory-read": "scopeInventoryReads",
  "coverage-read": "coverageReads",
  "cache-option-read": "cacheOptionReads",
};

function refuseRequest(tally, request, reason) {
  tally.requests.fenceRefusals += 1;
  if (tally.fence.length >= 50) return;
  let path = "/unparseable";
  try {
    const url = new URL(request.url());
    path = url.origin === origin ? url.pathname : `${url.host}${url.pathname}`;
  } catch {
    // keep the placeholder
  }
  path = path.replace(/[^\x21-\x7e]/g, "").slice(0, 300) || "/";
  tally.fence.push({
    method:
      request
        .method()
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .slice(0, 12) || "UNKNOWN",
    path,
    reason,
  });
}

// Every browser request in the capture context: refused and ambient requests
// are aborted before they leave the browser; allowed ones are fetched without
// following redirects, so a cross-origin Location never receives the session.
export async function fenceCaptureRoute(route, phase, tally) {
  const request = route.request();
  const verdict = classifyScrydexCacheCaptureRequest({
    method: request.method(),
    url: request.url(),
    phase,
    navigation: request.isNavigationRequest(),
  });
  if (!verdict.allowed) {
    if (verdict.requestClass === "ambient-read-blocked") tally.requests.ambientReadsBlocked += 1;
    else refuseRequest(tally, request, verdict.reason);
    return route.abort("blockedbyclient");
  }
  tally.requests[allowedCounters[verdict.requestClass]] += 1;
  let response;
  try {
    response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
  } catch {
    return route.abort("failed");
  }
  const location = response.headers().location;
  if (location && new URL(location, request.url()).origin !== origin) {
    refuseRequest(tally, request, "cross-origin-redirect");
    return route.abort("blockedbyclient");
  }
  return route.fulfill({ response });
}

// Kept as a standalone browser function so the bounded GET can be exercised
// without launching a credentialed browser.
export async function readCatalogJsonInPage({ path, deadlineMs, byteCap, fetchImpl = fetch }) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await fetchImpl(path, {
      method: "GET",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, text: "" };
    }
    if (!response.body) throw new Error("capture-read-refused");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > byteCap) throw new Error("capture-read-refused");
        text += decoder.decode(chunk.value, { stream: true });
      }
      return { status: response.status, text: text + decoder.decode() };
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    clearTimeout(deadline);
  }
}

async function readInPage(page, path) {
  const byteCap = path === scrydexCacheCaptureProfilesPath ? captureReadByteCaps.profiles : captureReadByteCaps.page;
  let timer;
  try {
    return await Promise.race([
      page.evaluate(readCatalogJsonInPage, { path, deadlineMs: captureReadDeadlineMs, byteCap }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(refused()), captureReadDeadlineMs + 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function signInThroughSharedForm(page, env) {
  await page.goto(`${origin}/access/sign-in?returnTo=${encodeURIComponent(scrydexCacheCaptureLandingPath)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("textbox", { name: /email|phone/i }).fill(env.CATALOG_ADMIN_E2E_EMAIL);
  await page.getByRole("button", { name: /continue/i }).click();
  const passwordChoice = page.getByRole("radio", { name: /^Password$/ });
  if (await passwordChoice.isVisible()) await passwordChoice.check();
  await page.locator('input[name="password"], input[type="password"]').first().fill(env.CATALOG_ADMIN_E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(`${origin}${scrydexCacheCaptureLandingPath}`);
}

function paths(env, workspace) {
  return {
    artifact: join(resolve(workspace), scrydexCacheCaptureArtifactPath),
    seal: join(env.RUNNER_TEMP, "catalog-scrydex-cache-capture-seal.json"),
  };
}

async function artifactDirectory(workspace, create) {
  let directory = resolve(workspace);
  for (const part of artifactParts) {
    directory = join(directory, part);
    if (create)
      await mkdir(directory, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw refused();
  }
  return directory;
}

// Writes the one validated, leak-free receipt create-once into an empty
// directory, then seals its digest to this run outside the workspace.
export async function writeCaptureArtifact(receipt, forbiddenValues, env, workspace, identity) {
  const serialized = JSON.stringify(receipt);
  if (
    Buffer.byteLength(serialized) > scrydexCacheCaptureMaxBytes ||
    validateScrydexCacheCaptureReceipt(JSON.parse(serialized)).length > 0 ||
    countCaptureContainsForbidden(serialized, forbiddenValues)
  )
    throw refused();
  const files = paths(env, workspace);
  const directory = await artifactDirectory(workspace, true);
  if ((await readdir(directory)).length !== 0) throw refused();
  await writeFile(files.artifact, serialized, { flag: "wx", mode: 0o600 });
  await writeFile(files.seal, JSON.stringify({ identity, sha256: digest(serialized) }), { flag: "wx", mode: 0o600 });
}

export async function capture(env = process.env, workspace = process.cwd()) {
  const identity = captureRunnerIdentity(env);
  const forbidden = new Set(credentialNames.map((key) => env[key]).filter(Boolean));
  const tally = emptyCaptureTally();
  let phase = "sign-in";
  let browser;
  let context;
  let page;
  let harvest;
  let receipt;
  try {
    receipt = await runScrydexCacheCapture({
      runner: identity,
      credentialsPresent: credentialNames.every((key) => Boolean(env[key])),
      selectDeployment: () => selectCaptureDeployment(env.GH_TOKEN),
      signIn: async () => {
        const { chromium } = await import("@playwright/test");
        browser = await chromium.launch();
        context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
        await context.route("**/*", (route) => fenceCaptureRoute(route, phase, tally));
        // Cookie values never leave this process, including values rotated at sign-in.
        harvest = watchSessionMarkers(context, forbidden);
        page = await context.newPage();
        page.setDefaultTimeout(captureReadDeadlineMs);
        await signInThroughSharedForm(page, env);
        addCookieMarkers(forbidden, await context.cookies());
        phase = "capture";
      },
      read: (path) => readInPage(page, path),
      resolveQueryHref: resolveScrydexCacheCaptureQueryHref,
      tally: () => ({ requests: { ...tally.requests }, fence: [...tally.fence] }),
      now: () => new Date().toISOString(),
    });
    if (context) addCookieMarkers(forbidden, await context.cookies());
  } finally {
    await Promise.allSettled([...(harvest?.cookieReads ?? [])]);
    await browser?.close();
    await Promise.allSettled([...(harvest?.cookieReads ?? [])]);
  }
  if (harvest?.hasFailure()) throw refused();
  await writeCaptureArtifact(receipt, [...forbidden], env, workspace, identity);
  return receipt;
}

// The upload boundary: exactly one sealed, leak-free, self-consistent receipt
// produced by this run and attempt. Governed-unknown receipts validate too; the
// workflow publishes only a complete one as the canonical artifact.
export async function validateCaptureUpload(env = process.env, workspace = process.cwd()) {
  try {
    const identity = captureRunnerIdentity(env);
    const files = paths(env, workspace);
    const directory = await artifactDirectory(workspace, false);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length !== 1 || entries[0].name !== artifactName || !entries[0].isFile()) throw refused();
    const info = await lstat(files.artifact);
    if (!info.isFile() || info.isSymbolicLink() || info.size > scrydexCacheCaptureMaxBytes) throw refused();
    const bytes = await readFile(files.artifact);
    const serialized = bytes.toString("utf8");
    const forbidden = credentialNames.map((key) => env[key]).filter(Boolean);
    if (countCaptureContainsForbidden(serialized, forbidden)) throw refused();
    const receipt = JSON.parse(serialized);
    if (validateScrydexCacheCaptureReceipt(receipt).length > 0) throw refused();
    if (JSON.stringify(receipt.runner) !== JSON.stringify(identity)) throw refused();
    const sealInfo = await lstat(files.seal);
    if (!sealInfo.isFile() || sealInfo.isSymbolicLink() || sealInfo.size > 2048) throw refused();
    const seal = await readFile(files.seal, "utf8");
    if (seal !== JSON.stringify({ identity, sha256: digest(bytes) })) throw refused();
    return { captureStatus: receipt.captureStatus, reasons: receipt.reasons.length, sha256: digest(bytes) };
  } catch {
    throw refused();
  }
}

export function captureExitCode(receipt) {
  return receipt?.captureStatus === "complete" ? 0 : 1;
}

// Step outputs the upload gates read: only the validator names the status.
export async function appendCaptureOutputs(verdict, outputFile) {
  if (!outputFile) return;
  await appendFile(outputFile, `capture_status=${verdict.captureStatus}\ncapture_sha256=${verdict.sha256}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (process.argv.length !== 3 || !["capture", "validate"].includes(command)) throw refused();
    if (command === "capture") {
      const receipt = await capture();
      console.log(JSON.stringify({ captureStatus: receipt.captureStatus, reasons: receipt.reasons }));
      process.exitCode = captureExitCode(receipt);
    } else {
      const verdict = await validateCaptureUpload();
      console.log(JSON.stringify({ valid: true, ...verdict }));
      await appendCaptureOutputs(verdict, process.env.GITHUB_OUTPUT);
    }
  } catch {
    console.error("scrydex-cache-capture-refused");
    process.exitCode = 1;
  }
}
