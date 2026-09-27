import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { open, realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closedObject,
  HTTP_LIMITS,
  POLICY_DIGEST,
  WINDOW_SCHEDULE,
  configurationDigest,
} from "./test-window-policy.mjs";
import { parseStrictRfc3339 } from "./validate-provider-object-disposition.mjs";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const instant = (value) => parseStrictRfc3339(value) !== null && value.endsWith("Z");
const refuse = () => {
  throw new Error("authority-unavailable");
};

export function validateLaunchManifest(value, candidateHead, now = Date.now()) {
  if (
    !closedObject(value, [
      "version",
      "heads",
      "proof",
      "configuration",
      "schedule",
      "fixturesDigest",
      "budgets",
      "timing",
      "paths",
      "journal",
      "noRetry",
    ])
  )
    refuse();
  const { heads, proof, configuration, schedule, budgets, timing, paths, journal } = value;
  if (
    value.version !== "provider-test-window/v1" ||
    value.noRetry !== true ||
    !sha(candidateHead, 40) ||
    !closedObject(heads, ["candidate", "executor", "journal", "deployed"]) ||
    Object.values(heads).some((head) => !sha(head, 40)) ||
    heads.candidate !== candidateHead ||
    heads.executor !== candidateHead ||
    heads.journal !== candidateHead ||
    !closedObject(proof, [
      "reviewedHead",
      "reviewDigest",
      "ciHead",
      "ciRunId",
      "ciConclusion",
      "dbConclusion",
      "redactionAccepted",
    ]) ||
    proof.reviewedHead !== candidateHead ||
    !sha(proof.reviewDigest, 64) ||
    proof.ciHead !== candidateHead ||
    !integer(proof.ciRunId, 1, Number.MAX_SAFE_INTEGER) ||
    proof.ciConclusion !== "success" ||
    proof.dbConclusion !== "success" ||
    proof.redactionAccepted !== true ||
    !closedObject(configuration, [
      "deploymentEnvironment",
      "providerMode",
      "accountsApi",
      "apiVersion",
      "configVersion",
      "policyVersion",
      "configDigest",
      "policyDigest",
      "sdkVersion",
    ]) ||
    !["dev", "test"].includes(configuration.deploymentEnvironment) ||
    configuration.providerMode !== "test" ||
    configuration.accountsApi !== "v2" ||
    configuration.sdkVersion !== "3.4.5" ||
    configuration.configVersion !== heads.executor ||
    configuration.policyVersion !== heads.executor ||
    !/^\d{4}-\d{2}-\d{2}\.[a-z]+$/.test(configuration.apiVersion) ||
    !sha(configuration.configDigest, 64) ||
    configuration.configDigest !== configurationDigest(configuration) ||
    configuration.policyDigest !== POLICY_DIGEST ||
    !sha(value.fixturesDigest, 64) ||
    !closedObject(budgets, ["scenario", "browser", "disposition", "objects", "class6PerWindow"]) ||
    Object.entries(HTTP_LIMITS).some(([key, maximum]) => !integer(budgets[key], 1, maximum)) ||
    budgets.objects !== 6 ||
    budgets.class6PerWindow !== 2 ||
    !closedObject(timing, [
      "startsAt",
      "expiresAt",
      "credentialExpiresAt",
      "replaySeconds",
      "observationSeconds",
      "cleanupSeconds",
      "retentionSeconds",
      "retentionSource",
    ]) ||
    ![timing.startsAt, timing.expiresAt, timing.credentialExpiresAt].every(instant) ||
    Date.parse(timing.startsAt) > now ||
    Date.parse(timing.expiresAt) <= now ||
    Date.parse(timing.expiresAt) > Date.parse(timing.credentialExpiresAt) ||
    Date.parse(timing.expiresAt) - Date.parse(timing.startsAt) > 3600_000 ||
    timing.replaySeconds !== 5 ||
    !integer(timing.observationSeconds, 1, 60) ||
    !integer(timing.cleanupSeconds, 30, 300) ||
    timing.retentionSeconds !== 3600 ||
    timing.retentionSource !== "https://docs.stripe.com/api/idempotent_requests" ||
    Date.parse(timing.expiresAt) - now < (timing.cleanupSeconds + 6 * 5 + 3 * timing.observationSeconds) * 1000 ||
    !closedObject(paths, ["claim", "packetDirectory"]) ||
    Object.values(paths).some((path) => typeof path !== "string" || !isAbsolute(path)) ||
    !closedObject(journal, ["host", "port", "database", "user", "isolated", "shared", "environment"]) ||
    journal.host !== "127.0.0.1" ||
    !integer(journal.port, 1024, 65535) ||
    [8317, 8318].includes(journal.port) ||
    !/^provider_window_[a-f0-9]{32}$/.test(journal.database) ||
    !/^[a-z][a-z0-9_]{0,30}$/.test(journal.user) ||
    journal.isolated !== true ||
    journal.shared !== false ||
    journal.environment !== "local" ||
    !Array.isArray(schedule) ||
    schedule.length !== 4
  )
    refuse();
  for (let index = 0; index < WINDOW_SCHEDULE.length; index++) {
    const flow = schedule[index];
    const expected = WINDOW_SCHEDULE[index];
    if (
      !closedObject(flow, ["flow", "windowId", "identityDigest", "mappers", "slots", "cleanupObligations"]) ||
      flow.flow !== expected.flow ||
      !sha(flow.windowId, 32) ||
      !sha(flow.identityDigest, 64) ||
      JSON.stringify(flow.mappers) !== JSON.stringify(expected.mappers) ||
      JSON.stringify(flow.slots) !== JSON.stringify(index === 0 ? [] : [index]) ||
      JSON.stringify(flow.cleanupObligations) !==
        JSON.stringify(
          index === 0
            ? ["retain-customer", "cancel-eligible-intents", "retain-captured-remedy"]
            : ["retain-session-expiry"],
        )
    )
      refuse();
  }
  if (new Set(schedule.map((flow) => flow.windowId)).size !== 4) refuse();
  return structuredClone(value);
}

async function boundedFile(path, maximum) {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) refuse();
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readLaunchManifest(path, digest, candidateHead) {
  if (!isAbsolute(path) || !sha(digest, 64)) refuse();
  const bytes = await boundedFile(path, 32768);
  if (hash(bytes) !== digest) refuse();
  return validateLaunchManifest(JSON.parse(bytes.toString("utf8")), candidateHead);
}

export async function validatePrivatePaths(manifest) {
  for (const path of Object.values(manifest.paths)) {
    const parent = await realpath(dirname(path));
    const target = resolve(parent, relative(dirname(path), path));
    const within = relative(REPOSITORY_ROOT, target);
    const parentStat = await lstat(dirname(path));
    if (
      !(within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) ||
      path.startsWith("\\\\") ||
      !isAbsolute(target) ||
      resolve(path) !== target ||
      parentStat.isSymbolicLink() ||
      (process.platform === "linux" && (parentStat.uid !== process.getuid() || (parentStat.mode & 0o077) !== 0))
    )
      refuse();
    try {
      await lstat(path);
      refuse();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (resolve(manifest.paths.claim) === resolve(manifest.paths.packetDirectory)) refuse();
}

export function assertReviewedWorktree(candidateHead) {
  const options = { cwd: REPOSITORY_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 65536 };
  if (
    execFileSync("git", ["rev-parse", "HEAD"], options).trim() !== candidateHead ||
    execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], options).trim()
  )
    refuse();
}

export async function claimAuthorization(manifest, manifestDigest) {
  const file = await open(manifest.paths.claim, "wx", 0o600);
  try {
    await file.writeFile(
      JSON.stringify({
        candidateHead: manifest.heads.candidate,
        manifestDigest,
        consumed: true,
        claimedAt: new Date().toISOString(),
      }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  // Never remove the record, including on prompt cancellation, crash or cleanup
  // failure. A restart cannot turn the original authority into another run.
}

export function readSecureConsole(prompt, input = process.stdin, output = process.stdout, signal) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function")
    return Promise.reject(new Error("interactive-required"));
  if (signal?.aborted) return Promise.reject(new Error("authority-unavailable"));
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let bytes = [];
    const previous = input.isRaw;
    const finish = (error) => {
      signal?.removeEventListener("abort", aborted);
      input.off("data", read);
      input.setRawMode(previous);
      input.pause();
      output.write("\n");
      const value = Buffer.from(bytes).toString("utf8");
      bytes.fill(0);
      error ? reject(new Error("authority-unavailable")) : resolve(value);
    };
    const aborted = () => finish(true);
    const read = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3 || byte === 4 || bytes.length > 16384) return finish(true);
        if (byte === 13 || byte === 10) return finish(false);
        if (byte === 127 || byte === 8) bytes.pop();
        else bytes.push(byte);
      }
    };
    input.setRawMode(true);
    input.on("data", read);
    signal?.addEventListener("abort", aborted, { once: true });
    input.resume();
  });
}
