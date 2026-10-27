import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPackageManagerInvocation } from "./lib/process.mjs";
import { runInstaller } from "./provider-browser-install-timeout.mjs";
import { TIMING_RECORD_PREFIX } from "./provider-browser-install-timing.mjs";

export const PLAYWRIGHT_INSTALL_COMMAND = ["exec", "playwright", "install", "chromium"];
export const PLAYWRIGHT_INSTALL_SITE = "playwright-chromium";
export const PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS = 180;
export const PLAYWRIGHT_INSTALL_ENVELOPE_SECONDS = 390;

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
  { exists = existsSync, lstat = lstatSync, readdir = readdirSync, ownerUid = process.getuid?.() } = {},
) {
  if (!exists(cachePath)) return { state: "cold", complete: false, owned: true, manifestCount: 0 };
  let entries;
  try {
    entries = cacheEntries(cachePath, { lstat, readdir });
  } catch {
    return { state: "mismatched", complete: false, owned: false, manifestCount: 0 };
  }
  const owned = entries.every(({ stat }) => {
    if (stat.isSymbolicLink?.()) return false;
    return ownerUid === undefined || stat.uid === undefined || stat.uid === ownerUid;
  });
  const manifestCount = entries.filter(
    ({ path: entryPath, stat }) => !stat.isDirectory() && /(?:^|[\\/])(?:package|pnpm-lock)\.json$/.test(entryPath),
  ).length;
  const payload = entries.some(
    ({ path: entryPath, stat }) => !stat.isDirectory() && /(?:^|[\\/])chrome(?:\.exe)?$/.test(entryPath),
  );
  if (!owned) return { state: "mismatched", complete: false, owned, manifestCount };
  if (!payload) return { state: "incomplete", complete: false, owned, manifestCount };
  return { state: "complete", complete: true, owned, manifestCount };
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
  const envelopeStarted = clockMs();
  let lastResult;
  const initialCache = inspectCacheImpl(cachePath);
  let lastCache = initialCache;
  let lastTimingLine;
  for (let installerAttempt = 1; installerAttempt <= 2; installerAttempt += 1) {
    if (installerAttempt > 1 && cancelSignal?.aborted) break;
    if (installerAttempt > 1 && clockMs() - envelopeStarted >= PLAYWRIGHT_INSTALL_ENVELOPE_SECONDS * 1000) break;
    lastCache = inspectCacheImpl(cachePath);
    const timingLines = [];
    try {
      const invocation = buildInvocationImpl(PLAYWRIGHT_INSTALL_COMMAND, { env: callerEnv });
      const writeInstaller = (line) => {
        if (typeof line === "string" && line.startsWith(TIMING_RECORD_PREFIX)) timingLines.push(line);
        else write(line);
      };
      lastResult = await runInstallerImpl({
        identity: identityFromEnvironment(callerEnv),
        env: callerEnv,
        installerCommand: invocation.command,
        installerArgs: invocation.args,
        installerEnv: explicitEnv,
        cacheHit: lastCache.state === "complete",
        requireComplete: false,
        cancelSignal,
        timeoutSeconds: PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS,
        now,
        write: writeInstaller,
      });
      lastTimingLine = timingLines.at(-1);
    } catch {
      lastResult = undefined;
      timingLines.length = 0;
    }
    let cacheAfter = lastCache;
    if (lastResult?.status === 0) cacheAfter = inspectCacheImpl(cachePath);
    if (lastResult?.status === 0 && cacheAfter.complete) {
      if (timingLines.length > 0) write(timingLines.at(-1));
      return { ...lastResult, reason: "success", cache: cacheAfter.state };
    }
    let reason = lastResult?.record?.terminalOutcome ?? "authority-refusal";
    if (lastResult?.status === 0) reason = "incomplete-cache";
    try {
      removeCacheImpl(cachePath);
    } catch {
      reason = "cleanup-refusal";
    }
    lastResult = { ...(lastResult ?? { status: 1 }), status: 1, reason, cache: cacheAfter.state };
    if (reason === "cleanup-refusal") {
      if (timingLines.length > 0) write(timingLines.at(-1));
      return refusal({ site, attempt, reason, cache: cacheAfter.state, write });
    }
    if (installerAttempt === 2 || cancelSignal?.aborted) {
      if (timingLines.length > 0) write(timingLines.at(-1));
      return refusal({ site, attempt, reason, cache: cacheAfter.state, write });
    }
  }
  const reason = lastResult?.reason ?? (cancelSignal?.aborted ? "cancelled" : "timeout");
  if (lastTimingLine) write(lastTimingLine);
  return refusal({ site, attempt, reason, cache: initialCache.state, write });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await installPlaywrightChromium();
  process.exitCode = result.status;
}
