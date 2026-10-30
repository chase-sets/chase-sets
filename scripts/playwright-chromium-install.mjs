import { accessSync, constants, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { buildPackageManagerInvocation } from "./lib/process.mjs";
import { INSTALLER_TIMEOUT_GRACE_MS, runInstaller } from "./provider-browser-install-timeout.mjs";
import { TIMING_RECORD_PREFIX } from "./provider-browser-install-timing.mjs";

export const PLAYWRIGHT_INSTALL_COMMAND = ["exec", "playwright", "install", "--with-deps", "chromium"];
export const PLAYWRIGHT_INSTALL_SITE = "playwright-chromium";
export const PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS = 180;
export const PLAYWRIGHT_INSTALL_ENVELOPE_SECONDS = 390;
export const PLAYWRIGHT_INSTALL_RETRY_DELAY_MS = 5_000;

// Playwright marks each browser directory it finishes with INSTALLATION_COMPLETE;
// registry extras such as .links and ffmpeg carry no marker and are not browsers.
const PLAYWRIGHT_BROWSER_DIRECTORIES = [
  { directory: /^chromium-\d+$/, payload: /^chrome(?:\.exe)?$/ },
  { directory: /^chromium_headless_shell-\d+$/, payload: /^(?:chrome-headless-shell|headless_shell)(?:\.exe)?$/ },
];

function safeField(value, fallback) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(value) ? value : fallback;
}

export function validateCachePath(cachePath, pathApi = path) {
  if (
    typeof cachePath !== "string" ||
    cachePath.length === 0 ||
    cachePath.includes("~") ||
    !pathApi.isAbsolute(cachePath)
  ) {
    throw new Error("invalid-cache-path");
  }
  const resolved = pathApi.resolve(cachePath);
  if (resolved === pathApi.parse(resolved).root) throw new Error("invalid-cache-path");
  return resolved;
}

function cacheEntries(root, { lstat = lstatSync, readdir = readdirSync } = {}) {
  const entries = [];
  const visit = (current) => {
    const stat = lstat(current);
    entries.push({ path: current, stat });
    if (!stat.isDirectory()) return;
    for (const name of readdir(current)) visit(path.join(current, name));
  };
  visit(root);
  return entries;
}

export function inspectCache(
  cachePath,
  {
    exists = existsSync,
    lstat = lstatSync,
    readdir = readdirSync,
    access = accessSync,
    ownerUid = process.getuid?.(),
  } = {},
) {
  if (!exists(cachePath)) return { state: "cold", complete: false, owned: true };
  let entries;
  try {
    entries = cacheEntries(cachePath, { lstat, readdir });
  } catch {
    return { state: "mismatched", complete: false, owned: false };
  }
  const owned = entries.every(({ stat }) => {
    if (stat.isSymbolicLink?.()) return false;
    return ownerUid === undefined || stat.uid === undefined || stat.uid === ownerUid;
  });
  const readable = entries.every(({ path: entryPath, stat }) => {
    try {
      access(entryPath, stat.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!owned || !readable) return { state: "mismatched", complete: false, owned };
  const files = entries.filter(({ stat }) => !stat.isDirectory()).map(({ path: entryPath }) => entryPath);
  const browsersComplete = PLAYWRIGHT_BROWSER_DIRECTORIES.every(({ directory, payload }) => {
    const browserDirectories = entries.filter(
      ({ path: entryPath, stat }) =>
        stat.isDirectory() && path.dirname(entryPath) === cachePath && directory.test(path.basename(entryPath)),
    );
    return (
      browserDirectories.length > 0 &&
      browserDirectories.every(({ path: browserDirectory }) => {
        const browserFiles = files.filter((file) => file.startsWith(`${browserDirectory}${path.sep}`));
        return (
          browserFiles.includes(path.join(browserDirectory, "INSTALLATION_COMPLETE")) &&
          browserFiles.some((file) => payload.test(path.basename(file)))
        );
      })
    );
  });
  if (!browsersComplete) return { state: "incomplete", complete: false, owned };
  return { state: "complete", complete: true, owned };
}

export function removeCache(cachePath, { remove = rmSync, exists = existsSync } = {}) {
  remove(cachePath, { recursive: true, force: true });
  if (exists(cachePath)) throw new Error("cleanup-refusal");
}

function identityFromEnvironment(env) {
  const runId = /^\d{1,20}$/.test(env.GITHUB_RUN_ID ?? "") ? env.GITHUB_RUN_ID : "1";
  const jobId = /^\d{1,20}$/.test(env.GITHUB_JOB_ID ?? "") ? env.GITHUB_JOB_ID : runId;
  const runAttempt = /^\d{1,20}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ? Number(env.GITHUB_RUN_ATTEMPT) : 1;
  const headSha = /^[a-f0-9]{40}$/.test(env.BOUNDARY_HEAD_SHA ?? "")
    ? env.BOUNDARY_HEAD_SHA
    : /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")
      ? env.GITHUB_SHA
      : "0".repeat(40);
  return { runId, jobId, runAttempt, headSha };
}

function diagnostic(site, attempt, reason, cache) {
  return `Playwright Chromium install failed ${JSON.stringify({ site, attempt, reason, cache })}`;
}

function retryDiagnostic(site, attempt, installerAttempt, reason, cache) {
  return `Playwright Chromium install retry ${JSON.stringify({ site, attempt, installerAttempt, reason, cache })}`;
}

function refusal({ site, attempt, reason, cache, write }) {
  const line = diagnostic(site, attempt, reason, cache);
  write(line);
  return { status: 1, reason, cache, diagnostic: line };
}

export async function installPlaywrightChromium({
  env = process.env,
  runInstallerImpl = runInstaller,
  inspectCacheImpl = inspectCache,
  removeCacheImpl = removeCache,
  buildInvocationImpl = buildPackageManagerInvocation,
  now,
  cancelSignal,
  delayImpl = delay,
  write = (line) => console.log(line),
} = {}) {
  const rawSite = env.PLAYWRIGHT_INSTALL_SITE;
  const rawAttempt = env.PLAYWRIGHT_INSTALL_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT;
  if ((rawSite !== undefined && !safeField(rawSite, "")) || (rawAttempt !== undefined && !safeField(rawAttempt, ""))) {
    return refusal({
      site: PLAYWRIGHT_INSTALL_SITE,
      attempt: "1",
      reason: "invalid-environment",
      cache: "invalid",
      write,
    });
  }
  const site = safeField(rawSite, PLAYWRIGHT_INSTALL_SITE);
  const attempt = safeField(rawAttempt, "1");
  let cachePath;
  try {
    cachePath = validateCachePath(env.PLAYWRIGHT_BROWSERS_PATH);
  } catch {
    return refusal({ site, attempt, reason: "invalid-path", cache: "invalid", write });
  }
  const callerEnv = {
    ...env,
    INSTALLER_TIMEOUT_SECONDS: "600",
  };
  const explicitEnv = {
    PLAYWRIGHT_BROWSERS_PATH: cachePath,
    PLAYWRIGHT_INSTALL_SITE: site,
    PLAYWRIGHT_INSTALL_ATTEMPT: attempt,
  };
  const clock = () => (typeof now === "function" ? now() : new Date());
  const clockMs = () => {
    const value = clock();
    return value instanceof Date ? value.getTime() : Number(value);
  };
  const envelopeEndsAt = clockMs() + PLAYWRIGHT_INSTALL_ENVELOPE_SECONDS * 1000;
  const attemptBudgetMs = PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS * 1000 + INSTALLER_TIMEOUT_GRACE_MS;
  // A retry starts only when its whole bound and kill grace still end inside the envelope.
  const retryFits = (reservedMs) => clockMs() + reservedMs + attemptBudgetMs <= envelopeEndsAt;
  for (let installerAttempt = 1; ; installerAttempt += 1) {
    const cacheBefore = inspectCacheImpl(cachePath);
    let result;
    let timingLine;
    try {
      const invocation = buildInvocationImpl(PLAYWRIGHT_INSTALL_COMMAND, { env: callerEnv });
      result = await runInstallerImpl({
        identity: identityFromEnvironment(callerEnv),
        env: callerEnv,
        installerCommand: invocation.command,
        installerArgs: invocation.args,
        installerEnv: explicitEnv,
        cacheHit: cacheBefore.state === "complete",
        requireComplete: false,
        cancelSignal,
        timeoutSeconds: PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS,
        now,
        // A job keeps one timing record: the attempt that decides its outcome.
        write: (line) => {
          if (typeof line === "string" && line.startsWith(TIMING_RECORD_PREFIX)) timingLine = line;
          else write(line);
        },
      });
    } catch {
      result = undefined;
    }
    const cacheAfter = result?.status === 0 ? inspectCacheImpl(cachePath) : cacheBefore;
    const fail = (reason) => {
      if (timingLine) write(timingLine);
      return refusal({ site, attempt, reason, cache: cacheAfter.state, write });
    };
    if (result?.status === 0 && cacheAfter.complete) {
      if (timingLine) write(timingLine);
      return { ...result, reason: "success", cache: cacheAfter.state };
    }
    const reason = !result
      ? "authority-refusal"
      : result.startRefused === true
        ? "start-refusal"
        : result.status === 0
          ? "incomplete-cache"
          : (result.record?.terminalOutcome ?? "refused");
    // An installer group not proven gone may still write the tree; the red job never saves it.
    if (reason === "cleanup-failure") return fail(reason);
    try {
      removeCacheImpl(cachePath);
    } catch {
      return fail("cleanup-refusal");
    }
    // Refused authority, a refused start and cancellation are terminal; other finished attempts get one retry.
    if (["authority-refusal", "start-refusal", "cancelled"].includes(reason) || installerAttempt === 2)
      return fail(reason);
    if (!retryFits(PLAYWRIGHT_INSTALL_RETRY_DELAY_MS)) return fail("timeout");
    write(retryDiagnostic(site, attempt, installerAttempt, reason, cacheAfter.state));
    await delayImpl(PLAYWRIGHT_INSTALL_RETRY_DELAY_MS);
    if (cancelSignal?.aborted) return fail("cancelled");
    if (!retryFits(0)) return fail("timeout");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await installPlaywrightChromium();
  process.exitCode = result.status;
}
