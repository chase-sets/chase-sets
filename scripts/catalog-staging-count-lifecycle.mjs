import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCountCaptureJourney } from "../bounded-contexts/catalog/features/scope-sync-batches/api/count-capture-runner.ts";
import {
  validateCountCaptureArtifacts,
  writeCountCaptureArtifact,
} from "../bounded-contexts/catalog/features/scope-sync-batches/api/count-capture-artifact.ts";
import {
  classifyCountLifecycleReceipt,
  countCaptureAuthoritySchema,
  countLifecycleReceiptMaxBytes,
  countLifecycleStopReceiptSchema,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/count-lifecycle-receipt.ts";
import { createCountCaptureGitHubReader } from "./catalog-count-capture-github.mjs";
import { collectCountCaptureDeployment } from "./catalog-count-capture-deployment.mjs";

const origin = "https://admin.staging.chasesets.com";
const apiPath = "/api/catalog/scope-sync-batches";
const refused = () => new Error("count-capture-runner-refused");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const credentialNames = ["CATALOG_ADMIN_E2E_EMAIL", "CATALOG_ADMIN_E2E_PASSWORD", "GH_TOKEN"];
const actionPaths = new Set([
  "/count-capture/baseline",
  "/count-capture/initial-notice",
  "/count-capture/usage",
  "/count-capture/quote-readback",
  "/count-capture/final-notice",
  "/count-capture/freeze",
  "/count-capture/pre-confirm",
  "/counts/quote",
  "/counts/acquire",
  "/preview",
]);
export const captureActionDeadlineMs = 30_000;
export const captureResponseByteCap = countLifecycleReceiptMaxBytes + 2_048;

export function addCookieMarkers(forbidden, cookies) {
  for (const cookie of cookies) if (cookie.value) forbidden.add(cookie.value);
}

export function watchSessionMarkers(context, forbidden) {
  const cookieReads = new Set();
  let cookieReadFailed = false;
  context.on("response", () => {
    const read = Promise.resolve()
      .then(() => context.cookies())
      .then((cookies) => addCookieMarkers(forbidden, cookies));
    cookieReads.add(read);
    void read
      .catch(() => {
        cookieReadFailed = true;
      })
      .finally(() => cookieReads.delete(read));
  });
  return { cookieReads, hasFailure: () => cookieReadFailed };
}

// A browser deadline can close the context before the final cookie harvest.
// Never replace a phased server stop with a synthetic baseline receipt.
export function settleCaptureReceipt(receipt, finalHarvest = undefined) {
  if (receipt !== undefined) return receipt;
  if (finalHarvest !== undefined) return finalHarvest;
  return {
    schemaVersion: "scope-sync-count-lifecycle-stop/v1",
    stoppedAt: new Date().toISOString(),
    phase: "baseline",
    reason: "capture-stopped",
    evidence: {},
  };
}

export function collectCaptureDeployment(reader, deployment, now) {
  return collectCountCaptureDeployment(reader, deployment, now);
}

export async function persistCaptureReceipt(receipt, forbidden, files, workspace, identity) {
  const verdict = await writeCountCaptureArtifact(receipt, [...forbidden], workspace);
  await writeFile(
    files.seal,
    JSON.stringify({ identity: captureUploadIdentity(identity), sha256: digest(await readFile(files.artifact)) }),
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  return verdict;
}

export function completeStopReceipt(receipt, identity) {
  if (receipt?.schemaVersion !== "scope-sync-count-lifecycle-stop/v1" || receipt.attribution) return receipt;
  const authority = countCaptureAuthoritySchema.safeParse(identity.authority);
  const attribution = {
    dispatchId: identity.dispatchId,
    runnerRunId: identity.run,
    runnerRunAttempt: Number(identity.attempt),
    runnerSha: identity.sha,
    packetHash: authority.success ? authority.data.packetHash : null,
    reviewReceiptHash: authority.success ? authority.data.review.receiptHash : null,
    phases: [],
  };
  const completed = {
    ...receipt,
    attribution,
    classification: {
      verdict: "INCOMPLETE",
      reasons: [],
      acceptance: {
        "9431-ac7": { verdict: "INCOMPLETE", reasons: [] },
        "9424-ac5": { verdict: "INCOMPLETE", reasons: [] },
      },
    },
  };
  return { ...completed, classification: classifyCountLifecycleReceipt(completed) };
}

export function captureRunnerIdentity(env) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.ADMIN_WEB_URL !== origin ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    env.EXPECTED_SHA !== env.GITHUB_SHA ||
    !/^\d{1,20}$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^\d{1,6}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    env.CATALOG_STAGING_PROVIDER_UAT_SCOPE !== "scope-sync-count-lifecycle" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(env.CATALOG_CAPTURE_DISPATCH_ID ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(env.CATALOG_CAPTURE_SCOPE_RECORD_ID ?? "")
  )
    throw refused();
  let authority;
  try {
    authority = JSON.parse(env.CATALOG_CAPTURE_AUTHORITY ?? "null");
  } catch {
    throw refused();
  }
  return {
    sha: env.GITHUB_SHA,
    run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    dispatchId: env.CATALOG_CAPTURE_DISPATCH_ID,
    scopeRecordId: env.CATALOG_CAPTURE_SCOPE_RECORD_ID,
    authority,
  };
}

// Kept as a standalone browser function so every action body and bounded body
// reader can be exercised without launching a credentialed browser.
export async function captureActionInPage({
  apiPath,
  intent,
  fields,
  authority,
  runId,
  runAttempt,
  deadlineMs,
  byteCap,
  fetchImpl = fetch,
}) {
  const routes = {
    "capture-baseline": ["/count-capture/baseline", { scopeRecordId: fields.scopeRecordId, authority }],
    "capture-initial-notice": ["/count-capture/initial-notice", {}],
    "capture-usage": ["/count-capture/usage", {}],
    "count-quote": [
      "/counts/quote",
      {
        selection: { mode: "ids", scopeRecordIds: [fields.scopeRecordId] },
        budget: { creditedProviderRequestLimits: { scrydex: 10 } },
      },
    ],
    "capture-quote-readback": ["/count-capture/quote-readback", {}],
    "capture-final-notice": ["/count-capture/final-notice", {}],
    "count-acquire": ["/counts/acquire", { quoteId: fields.quoteId, fingerprint: fields.countFingerprint }],
    preview: [
      "/preview",
      {
        selection: { mode: "ids", scopeRecordIds: [fields.scopeRecordId] },
        budget: { creditedProviderRequestLimits: { scrydex: 10 } },
      },
    ],
    "pre-confirm-planner-read": [
      "/count-capture/pre-confirm",
      {
        selection: { mode: "ids", scopeRecordIds: [fields.scopeRecordId] },
        budget: { creditedProviderRequestLimits: { scrydex: 10 } },
        planFingerprint: fields.planFingerprint,
      },
    ],
    "capture-freeze": [
      "/count-capture/freeze",
      { runnerRunId: runId, runnerRunAttempt: Number(runAttempt), collection: JSON.parse(fields.collection) },
    ],
  };
  const route = routes[intent];
  if (!route) throw new Error("capture-stopped");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await fetchImpl(`${apiPath}${route[0]}`, {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-catalog-count-capture": "1" },
      body: JSON.stringify(route[1]),
      signal: controller.signal,
    });
    if (!response.ok || response.headers.get("cache-control") !== "no-store") throw new Error("capture-stopped");
    if (!response.body) throw new Error("capture-stopped");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > byteCap) throw new Error("capture-stopped");
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  } finally {
    clearTimeout(deadline);
  }
}

function paths(env, workspace) {
  if (!env.RUNNER_TEMP) throw refused();
  return {
    artifact: join(workspace, "artifacts/catalog-count-lifecycle/receipt.json"),
    seal: join(env.RUNNER_TEMP, "catalog-count-capture-upload.json"),
  };
}

export function captureUploadIdentity(identity) {
  const authority = countCaptureAuthoritySchema.safeParse(identity.authority);
  return {
    sha: identity.sha,
    run: identity.run,
    attempt: identity.attempt,
    dispatchId: identity.dispatchId,
    scopeRecordId: identity.scopeRecordId,
    authoritySha256: authority.success ? digest(JSON.stringify(authority.data)) : null,
  };
}

export async function validateCaptureUpload(env = process.env, workspace = process.cwd()) {
  const identity = captureRunnerIdentity(env);
  if (credentialNames.some((key) => !env[key])) throw refused();
  const files = paths(env, workspace);
  const info = await lstat(files.seal);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2048) throw refused();
  const seal = JSON.parse(await readFile(files.seal, "utf8"));
  const verdict = await validateCountCaptureArtifacts(
    credentialNames.map((key) => env[key] ?? ""),
    workspace,
  );
  const expected = { identity: captureUploadIdentity(identity), sha256: digest(await readFile(files.artifact)) };
  if (JSON.stringify(seal) !== JSON.stringify(expected)) throw refused();
  return verdict;
}

export async function capture(env = process.env, workspace = process.cwd()) {
  const identity = captureRunnerIdentity(env);
  if (credentialNames.some((key) => !env[key])) throw refused();
  const files = paths(env, workspace);
  const forbidden = new Set(credentialNames.map((key) => env[key]));
  const reader = createCountCaptureGitHubReader({ repository: env.GITHUB_REPOSITORY, token: env.GH_TOKEN });
  // Standalone Chromium: no test-runner trace, screenshot, video or storage-state output.
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  let receipt;
  let contextClosed = false;
  let harvest;
  try {
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const relativePath = url.pathname.startsWith(apiPath) ? url.pathname.slice(apiPath.length) : null;
      if (
        url.origin !== origin ||
        (request.method() !== "GET" && !url.pathname.startsWith("/access/") && !actionPaths.has(relativePath))
      )
        return route.abort("blockedbyclient");
      if (request.method() !== "GET" && actionPaths.has(relativePath)) return route.continue();
      // Intercept redirects before a 307 can forward sign-in credentials.
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      const location = response.headers().location;
      if (location && new URL(location, url).origin !== origin) return route.abort("blockedbyclient");
      return route.fulfill({ response });
    });
    // Cookie values never leave this process, including values rotated at sign-in.
    harvest = watchSessionMarkers(context, forbidden);
    await page.goto(`${origin}/access/sign-in?returnTo=%2Fcatalog%2Fscopes%2Fsync-batches`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("textbox", { name: /email|phone/i }).fill(env.CATALOG_ADMIN_E2E_EMAIL);
    await page.getByRole("button", { name: /continue/i }).click();
    const passwordChoice = page.getByRole("radio", { name: /^Password$/ });
    if (await passwordChoice.isVisible()) await passwordChoice.check();
    await page.locator('input[name="password"], input[type="password"]').first().fill(env.CATALOG_ADMIN_E2E_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(`${origin}/catalog/scopes/sync-batches`);
    const authority = identity.authority;
    if (!authority || typeof authority !== "object") throw refused();
    const action = async (intent, fields) => {
      if (new URL(page.url()).origin !== origin) throw refused();
      let timer;
      const result = await Promise.race([
        page.evaluate(captureActionInPage, {
          apiPath,
          intent,
          fields: { scopeRecordId: identity.scopeRecordId, ...fields },
          authority,
          runId: identity.run,
          runAttempt: identity.attempt,
          deadlineMs: captureActionDeadlineMs,
          byteCap: captureResponseByteCap,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(async () => {
            contextClosed = true;
            await context.close().catch(() => undefined);
            reject(new Error("capture-stopped"));
          }, captureActionDeadlineMs);
        }),
      ]).finally(() => clearTimeout(timer));
      addCookieMarkers(forbidden, await context.cookies());
      return result;
    };
    receipt = await runCountCaptureJourney(
      { sha: identity.sha, dispatchId: identity.dispatchId, scopeRecordId: identity.scopeRecordId },
      action,
      undefined,
      (deployment, now) => collectCaptureDeployment(reader, deployment, now),
    );
    if (!contextClosed) addCookieMarkers(forbidden, await context.cookies());
  } catch {
    receipt = settleCaptureReceipt(receipt);
  } finally {
    await Promise.allSettled([...(harvest?.cookieReads ?? [])]);
    await browser.close();
    await Promise.allSettled([...(harvest?.cookieReads ?? [])]);
  }
  if (harvest?.hasFailure()) throw refused();
  receipt = completeStopReceipt(receipt, identity);
  // This digest binds the later upload to the bytes scanned with session markers
  // still in memory. No marker, cookie, or browser state is exported in the seal.
  return persistCaptureReceipt(receipt, forbidden, files, workspace, identity);
}

export function captureExitCode(validation) {
  return validation?.classification?.verdict === "CONFORMING" ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (process.argv.length !== 3 || !["capture", "validate"].includes(command)) throw refused();
    const verdict = await (command === "capture" ? capture() : validateCaptureUpload());
    console.log(JSON.stringify({ valid: verdict.valid, verdict: verdict.classification.verdict }));
    if (command === "capture") process.exitCode = captureExitCode(verdict);
  } catch {
    console.error("count-capture-runner-refused");
    process.exitCode = 1;
  }
}
