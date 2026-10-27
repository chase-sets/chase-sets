#!/usr/bin/env node
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import process from "node:process";
import {
  runBoundedProcess,
  INSTALLER_TIMEOUT_GRACE_MS,
  INSTALLER_TIMEOUT_SECONDS,
} from "./provider-browser-install-timeout.mjs";

export const PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS = INSTALLER_TIMEOUT_SECONDS;
export const PLAYWRIGHT_INSTALL_GRACE_MS = INSTALLER_TIMEOUT_GRACE_MS;

function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(String(value ?? ""))) throw new Error(`Playwright Chromium install failed: invalid ${name}`);
  return Number(value);
}

export function resolveBrowserPath(env = process.env) {
  const value = env.PLAYWRIGHT_BROWSERS_PATH;
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("~"))
    throw new Error("Playwright Chromium install failed: browser path must be absolute and tilde-free");
  const path = resolve(value);
  if (parse(path).root === path)
    throw new Error("Playwright Chromium install failed: browser path cannot be filesystem root");
  return path;
}

function assertRunnerOwned(path) {
  try {
    const pending = [path];
    while (pending.length) {
      const current = pending.pop();
      const stat = lstatSync(current);
      if (stat.uid !== undefined && stat.uid !== process.getuid?.())
        throw new Error("Playwright Chromium install failed: browser cache is not runner-owned");
      if (stat.isDirectory()) for (const entry of readdirSync(current)) pending.push(`${current}/${entry}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function runPlaywrightChromiumInstall({
  env = process.env,
  site = env.PLAYWRIGHT_INSTALL_SITE ?? "unknown",
  maxAttempts = positiveInteger(env.PLAYWRIGHT_INSTALL_MAX_ATTEMPTS ?? "1", "attempt count"),
  timeoutSeconds = positiveInteger(
    env.PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS ?? String(PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS),
    "timeout",
  ),
  graceMs = PLAYWRIGHT_INSTALL_GRACE_MS,
  spawnImpl,
  signalGroupImpl,
  runtime = process,
  write = (line) => console.log(line),
} = {}) {
  const browserPath = resolveBrowserPath(env);
  if (![1, 2].includes(maxAttempts)) throw new Error("Playwright Chromium install failed: invalid attempt count");
  const jobTimeoutMinutes = env.PLAYWRIGHT_INSTALL_JOB_TIMEOUT_MINUTES
    ? positiveInteger(env.PLAYWRIGHT_INSTALL_JOB_TIMEOUT_MINUTES, "job timeout")
    : undefined;
  if (maxAttempts === 2 && jobTimeoutMinutes !== undefined && jobTimeoutMinutes < 45)
    throw new Error("Playwright Chromium install failed: retry requires a job limit of at least 45 minutes");
  if (timeoutSeconds > PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS)
    throw new Error("Playwright Chromium install failed: timeout exceeds 600-second bound");
  assertRunnerOwned(browserPath);
  const result = await runBoundedProcess({
    command: ["pnpm", "exec", "playwright", "install", "--with-deps", "chromium"],
    env: { ...env, PLAYWRIGHT_BROWSERS_PATH: browserPath },
    timeoutMs: timeoutSeconds * 1000,
    graceMs,
    maxAttempts,
    spawnImpl,
    signalGroupImpl,
    runtime,
    site,
    write: () => {},
  });
  if (result.status !== 0) {
    rmSync(browserPath, { recursive: true, force: true });
    const diagnostic = {
      schemaVersion: "playwright-chromium-install/v1",
      site,
      attempt: result.attempt ?? result.attempts ?? maxAttempts,
      reason: result.reason,
      cache: browserPath,
      status: "failure",
    };
    const output = env.PLAYWRIGHT_INSTALL_DIAGNOSTIC_PATH;
    if (output) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(diagnostic)}\n`, { mode: 0o600 });
    }
    write(
      `Playwright Chromium install failed: site=${site} attempt=${diagnostic.attempt} reason=${result.reason} cache=${browserPath}`,
    );
  }
  return { ...result, site, cache: browserPath };
}

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const result = await runPlaywrightChromiumInstall({
      site: readOption("--site", process.env.PLAYWRIGHT_INSTALL_SITE ?? dirname(process.cwd())),
    });
    process.exitCode = result.status;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Playwright Chromium install failed: refused");
    process.exitCode = 1;
  }
}
