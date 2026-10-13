import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCountCaptureJourney } from "../bounded-contexts/catalog/features/scope-sync-batches/api/count-capture-runner.ts";
import {
  validateCountCaptureArtifacts,
  writeCountCaptureArtifact,
} from "../bounded-contexts/catalog/features/scope-sync-batches/api/count-capture-artifact.ts";
import { createCountCaptureGitHubReader } from "./catalog-count-capture-github.mjs";
import { collectCountCaptureDeployment } from "./catalog-count-capture-deployment.ts";

const origin = "https://admin.staging.chasesets.com";
const actionPath = "/catalog/scopes/sync-batches";
const refused = () => new Error("count-capture-runner-refused");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const credentialNames = ["CATALOG_ADMIN_E2E_EMAIL", "CATALOG_ADMIN_E2E_PASSWORD", "GH_TOKEN"];

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
  return {
    sha: env.GITHUB_SHA,
    run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    dispatchId: env.CATALOG_CAPTURE_DISPATCH_ID,
    scopeRecordId: env.CATALOG_CAPTURE_SCOPE_RECORD_ID,
  };
}

function paths(env, workspace) {
  if (!env.RUNNER_TEMP) throw refused();
  return {
    artifact: join(workspace, "artifacts/catalog-count-lifecycle/receipt.json"),
    seal: join(env.RUNNER_TEMP, "catalog-count-capture-upload.json"),
  };
}

export async function validateCaptureUpload(env = process.env, workspace = process.cwd()) {
  const identity = captureRunnerIdentity(env);
  const files = paths(env, workspace);
  const info = await lstat(files.seal);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2048) throw refused();
  const seal = JSON.parse(await readFile(files.seal, "utf8"));
  const verdict = await validateCountCaptureArtifacts(
    credentialNames.map((key) => env[key] ?? ""),
    workspace,
  );
  const expected = { identity, sha256: digest(await readFile(files.artifact)) };
  if (JSON.stringify(seal) !== JSON.stringify(expected)) throw refused();
  return verdict;
}

export async function capture(env = process.env, workspace = process.cwd()) {
  const identity = captureRunnerIdentity(env);
  if (credentialNames.some((key) => !env[key])) throw refused();
  const files = paths(env, workspace);
  const forbidden = credentialNames.map((key) => env[key]);
  const reader = createCountCaptureGitHubReader({ repository: env.GITHUB_REPOSITORY, token: env.GH_TOKEN });
  // Standalone Chromium: no test-runner trace, screenshot, video or storage-state output.
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const cookieReads = new Set();
  let cookieReadFailed = false;
  let receipt;
  try {
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        url.origin !== origin ||
        (request.method() !== "GET" && !url.pathname.startsWith("/access/") && url.pathname !== actionPath)
      )
        return route.abort("blockedbyclient");
      // Intercept redirects before a 307 can forward sign-in credentials.
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      const location = response.headers().location;
      if (location && new URL(location, url).origin !== origin) return route.abort("blockedbyclient");
      return route.fulfill({ response });
    });
    context.on("response", () => {
      // Cookie values never leave this process, including values rotated at sign-in.
      const read = context.cookies().then((cookies) => {
        for (const cookie of cookies) forbidden.push(cookie.value);
      });
      cookieReads.add(read);
      void read
        .catch(() => {
          cookieReadFailed = true;
        })
        .finally(() => cookieReads.delete(read));
    });
    await page.goto(`${origin}/access/sign-in?returnTo=%2Fcatalog%2Fscopes%2Fsync-batches`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("textbox", { name: /email|phone/i }).fill(env.CATALOG_ADMIN_E2E_EMAIL);
    await page.getByRole("button", { name: /continue/i }).click();
    const passwordChoice = page.getByRole("radio", { name: /^Password$/ });
    if (await passwordChoice.isVisible()) await passwordChoice.check();
    await page.locator('input[name="password"], input[type="password"]').first().fill(env.CATALOG_ADMIN_E2E_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(`${origin}${actionPath}`);
    const action = async (intent, fields) => {
      if (new URL(page.url()).origin !== origin) throw refused();
      const result = await page.evaluate(
        async ({ actionPath, intent, fields }) => {
          const response = await fetch(actionPath, {
            method: "POST",
            credentials: "same-origin",
            redirect: "error",
            cache: "no-store",
            body: new URLSearchParams({ ...fields, intent, countCapture: "1" }),
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
              if (bytes > 128_000) throw new Error("capture-stopped");
              text += decoder.decode(chunk.value, { stream: true });
            }
            return JSON.parse(text + decoder.decode());
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
        },
        { actionPath, intent, fields },
      );
      for (const cookie of await context.cookies()) forbidden.push(cookie.value);
      return result;
    };
    receipt = await runCountCaptureJourney(
      { sha: identity.sha, dispatchId: identity.dispatchId, scopeRecordId: identity.scopeRecordId },
      action,
      undefined,
      (authority, now) => collectCountCaptureDeployment(reader, authority, now),
    );
    for (const cookie of await context.cookies()) forbidden.push(cookie.value);
  } catch {
    receipt = {
      schemaVersion: "scope-sync-count-lifecycle-stop/v1",
      stoppedAt: new Date().toISOString(),
      phase: "baseline",
      reason: "capture-stopped",
      evidence: {},
    };
  } finally {
    await Promise.allSettled([...cookieReads]);
    await browser.close();
    await Promise.allSettled([...cookieReads]);
  }
  if (cookieReadFailed) throw refused();
  const verdict = await writeCountCaptureArtifact(receipt, forbidden, workspace);
  // This digest binds the later upload to the bytes scanned with session markers
  // still in memory. No marker, cookie, or browser state is exported in the seal.
  await writeFile(files.seal, JSON.stringify({ identity, sha256: digest(await readFile(files.artifact)) }), {
    flag: "wx",
    mode: 0o600,
  });
  return verdict;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (process.argv.length !== 3 || !["capture", "validate"].includes(command)) throw refused();
    const verdict = await (command === "capture" ? capture() : validateCaptureUpload());
    console.log(JSON.stringify({ valid: verdict.valid, verdict: verdict.verdict }));
    if (command === "capture" && verdict.verdict !== "CONFORMING") process.exitCode = 1;
  } catch {
    console.error("count-capture-runner-refused");
    process.exitCode = 1;
  }
}
