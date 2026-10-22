import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { timingRecordLine } from "./provider-browser-install-timing.mjs";

export const INSTALLER_TIMEOUT_SECONDS = 600;
export const INSTALLER_TIMEOUT_MS = INSTALLER_TIMEOUT_SECONDS * 1000;
export const INSTALLER_TIMEOUT_GRACE_MS = 5_000;
export const INSTALLER_STEP = "Install provider browser boundary";

const safeLine = /^(provider-boundary-|Runner image:|Linux |provider-browser-)/;

function decimal(value, fallback) {
  return /^\d+$/.test(String(value ?? "")) ? String(value) : fallback;
}

function head(value) {
  return /^[a-f0-9]{40}$/.test(value ?? "") ? value : "0".repeat(40);
}

function outcomeFrom({ timedOut, status, output }) {
  if (timedOut) return "timeout";
  if (status === 0) return "success";
  if (/checksum/i.test(output)) return "checksum-failure";
  if (/cache.*(restore|fail)|restore.*cache/i.test(output)) return "cache-restore-failure";
  if (/cleanup/i.test(output)) return "cleanup-failure";
  if (/partial|incomplete/i.test(output)) return "partial-download";
  return "refused";
}

export function runInstaller({
  env = process.env,
  now = () => new Date(),
  spawnImpl = spawn,
  write = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  if (env.INSTALLER_TIMEOUT_SECONDS !== undefined && env.INSTALLER_TIMEOUT_SECONDS !== String(INSTALLER_TIMEOUT_SECONDS)) {
    throw new Error("INSTALLER_TIMEOUT_SECONDS must be exactly 600");
  }
  const started = now();
  const output = [];
  let timedOut = false;
  const child = spawnImpl("bash", ["scripts/provider-object-disposition/browser-boundary/ci-setup.sh"], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const relay = (chunk, sink) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      output.push(line);
      if (safeLine.test(line)) sink(line);
    }
  };
  child.stdout?.on("data", (chunk) => relay(chunk, write));
  child.stderr?.on("data", (chunk) => relay(chunk, error));

  return new Promise((resolve) => {
    let graceTimer;
    const deadline = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (signalError) {
          if (signalError?.code !== "ESRCH") throw signalError;
        }
      }
      graceTimer = setTimeout(() => {
        if (child.pid && child.exitCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (signalError) {
            if (signalError?.code !== "ESRCH") throw signalError;
          }
        }
      }, INSTALLER_TIMEOUT_GRACE_MS);
    }, INSTALLER_TIMEOUT_MS);
    child.once("close", (status, signal) => {
      clearTimeout(deadline);
      if (graceTimer) clearTimeout(graceTimer);
      const ended = now();
      const record = {
        runId: decimal(env.GITHUB_RUN_ID, "0"),
        jobId: decimal(env.GITHUB_JOB_ID, decimal(env.GITHUB_RUN_ID, "0")),
        runAttempt: Number.parseInt(decimal(env.GITHUB_RUN_ATTEMPT, "1"), 10),
        elapsedMs: Math.max(0, ended.getTime() - started.getTime()),
        step: INSTALLER_STEP,
        headSha: head(env.BOUNDARY_HEAD_SHA),
        startedAt: started.toISOString(),
        endedAt: ended.toISOString(),
        phase: "terminal",
        source: env.PROVIDER_BROWSER_INSTALL_SOURCE === "cache" ? "cache" : "provider-download",
        cache: ["hit", "miss", "not-applicable"].includes(env.PROVIDER_BROWSER_INSTALL_CACHE)
          ? env.PROVIDER_BROWSER_INSTALL_CACHE
          : "miss",
        retryCount: 0,
        terminalOutcome: outcomeFrom({ timedOut, status, output: output.join("\n") }),
      };
      write(timingRecordLine(record));
      resolve({ status: timedOut ? 124 : status ?? 1, signal, timedOut, record });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runInstaller();
  process.exitCode = result.status === 0 ? 0 : 1;
}
