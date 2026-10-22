import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildMinimalProcessEnvironment } from "./lib/process.mjs";
import { isValidTimingRecord, timingRecordLine } from "./provider-browser-install-timing.mjs";

export const INSTALLER_TIMEOUT_SECONDS = 600;
export const INSTALLER_TIMEOUT_MS = INSTALLER_TIMEOUT_SECONDS * 1000;
export const INSTALLER_TIMEOUT_GRACE_MS = 5_000;
export const INSTALLER_STEP = "Install provider browser boundary";
const supervisorArgument = "--installer-process-group";

// Root signalling reaches noninteractive sudo descendants of this owned group.
function signalGroup(pid, signal) {
  const result = spawnSync("sudo", ["-n", "/bin/kill", `-${signal}`, "--", `-${pid}`], {
    stdio: "ignore",
    timeout: 1_000,
  });
  if (result.status === 0) return;
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
  }
  throw new Error("provider-browser-install group signalling refused");
}

export async function resolveInstallerIdentity(env, fetchImpl = fetch) {
  if (
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "") ||
    !env.GH_TOKEN ||
    !env.RUNNER_NAME
  ) {
    throw new Error("provider-browser-install identity refused");
  }
  const response = await fetchImpl(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`,
    {
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error("provider-browser-install identity unavailable");
  const payload = await response.json();
  const jobs = payload.jobs?.filter(
    (job) => job.name === "Static Checks" && job.status === "in_progress" && job.runner_name === env.RUNNER_NAME,
  );
  if (
    payload.total_count > 100 ||
    jobs?.length !== 1 ||
    jobs[0].run_id !== Number(env.GITHUB_RUN_ID) ||
    jobs[0].run_attempt !== Number(env.GITHUB_RUN_ATTEMPT) ||
    jobs[0].head_sha !== env.BOUNDARY_HEAD_SHA
  ) {
    throw new Error("provider-browser-install owning job refused");
  }
  return {
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    jobId: String(jobs[0].id),
    headSha: env.BOUNDARY_HEAD_SHA,
  };
}

export function runInstaller({
  identity,
  env = process.env,
  cacheHit = false,
  now = () => new Date(),
  spawnImpl = spawn,
  signalGroupImpl = signalGroup,
  write = (line) => console.log(line),
} = {}) {
  const startedAt = now().toISOString();
  const base = {
    ...identity,
    step: INSTALLER_STEP,
    startedAt,
    endedAt: startedAt,
    elapsedMs: 0,
    phase: "runner-identity",
    source: "provider-download",
    cache: "not-applicable",
    retryCount: 0,
    terminalOutcome: "refused",
  };
  if (!isValidTimingRecord(base) || env.INSTALLER_TIMEOUT_SECONDS !== "600") {
    throw new Error("provider-browser-install authority or 600-second bound refused");
  }
  const childEnv = buildMinimalProcessEnvironment(
    env,
    Object.fromEntries(
      ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "ImageOS", "ImageVersion", "BOUNDARY_HEAD_SHA"].map((name) => [
        name,
        env[name],
      ]),
    ),
  );
  let phase = "runner-identity";
  let cache = "not-applicable";
  let source = "provider-download";
  let failure;
  let complete = false;
  let stopping = false;
  let settled = false;
  let deadline;
  let child;
  let installerStatus;
  let released = false;

  return new Promise((resolve) => {
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      const endedAt = now().toISOString();
      const record = {
        ...base,
        endedAt,
        elapsedMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
        phase: failure ? phase : "terminal",
        source,
        cache,
        terminalOutcome: failure ?? "success",
      };
      write(timingRecordLine(record));
      resolve({ status: failure ? 1 : status, record });
    };
    const stop = (outcome) => {
      if (stopping || settled) return;
      stopping = true;
      failure = outcome;
      clearTimeout(deadline);
      try {
        signalGroupImpl(child.pid, "TERM");
      } catch {
        failure = "cleanup-failure";
      }
      // A shell exit must not cancel the grace timer: descendants can ignore
      // TERM and close inherited streams while remaining in the owned group.
      setTimeout(() => {
        try {
          signalGroupImpl(child.pid, "KILL");
        } catch {
          failure = "cleanup-failure";
        }
        finish(1);
      }, INSTALLER_TIMEOUT_GRACE_MS);
    };
    try {
      child = spawnImpl(process.execPath, [fileURLToPath(import.meta.url), supervisorArgument], {
        detached: true,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
    } catch {
      failure = "refused";
      finish(1);
      return;
    }
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      failure = "refused";
      child.once("error", () => {});
      finish(1);
      return;
    }

    const releaseIfComplete = () => {
      if (!released && !stopping && !settled && installerStatus === 0 && complete && !failure) {
        released = true;
        clearTimeout(deadline);
        child.send("release");
      }
    };
    const consume = (stream) => {
      let pending = "";
      stream.on("data", (chunk) => {
        if (stopping || settled) return;
        // Only fixed classifications survive; raw provider output is neither
        // relayed nor accumulated without a bound.
        const text = pending + String(chunk);
        if (/checksum.*(fail|mismatch)|sha256.*mismatch/i.test(text)) failure = "checksum-failure";
        if (/cache.*restore.*fail/i.test(text)) failure = "cache-restore-failure";
        if (/partial.download|incomplete.download|download.*fail/i.test(text)) failure ??= "partial-download";
        if (/fallback.browser|executablePath.*\/usr\/bin/i.test(text)) failure = "refused";
        const lines = text.split(/\r?\n/);
        pending = lines.pop().slice(-4096);
        for (const line of lines) {
          if (line === "provider-boundary-setup-stage:runner-identity") phase = "runner-identity";
          if (line === "provider-boundary-setup-stage:install-chromium") {
            phase = "browser-download";
            source = cacheHit ? "cache" : "provider-download";
            cache = cacheHit ? "hit" : "miss";
          }
          if (line === "provider-boundary-setup-stage:install-native-dependencies") phase = "native-dependencies";
          if (line === "provider-boundary-setup-stage:install-boundary") phase = "boundary-install";
          if (line === "provider-boundary-setup-stage:complete") complete = true;
          if (/^provider-boundary-setup-refused:/.test(line))
            failure ??= phase === "browser-download" ? "partial-download" : "refused";
        }
        if (/Downloading (Chromium|Chrome|FFmpeg)/.test(text)) {
          source = "provider-download";
          cache = "miss";
        }
        if (failure) stop(failure);
        else releaseIfComplete();
      });
    };
    consume(child.stdout);
    consume(child.stderr);
    deadline = setTimeout(() => stop("timeout"), INSTALLER_TIMEOUT_MS);
    child.once("message", (message) => {
      if (stopping || settled) return;
      installerStatus = message?.installerStatus;
      if (installerStatus !== 0) {
        stop(failure ?? "refused");
        return;
      }
      releaseIfComplete();
    });
    child.once("error", () => {
      failure = "refused";
      finish(1);
    });
    child.once("close", (status) => {
      if (stopping || settled) return;
      if (status !== 0 || !released || !complete || failure) {
        stop(failure ?? "refused");
        return;
      }
      finish(0);
    });
  });
}

export function superviseInstaller({ runtime = process, spawnImpl = spawn, signalGroupImpl = signalGroup } = {}) {
  // This detached group leader survives TERM and installer exit until the
  // owner releases it or kills the group, reserving its group id during grace.
  runtime.on("SIGTERM", () => {});
  const installer = spawnImpl("bash", ["scripts/provider-object-disposition/browser-boundary/ci-setup.sh"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  installer.once("error", () => runtime.send({ installerStatus: 1 }));
  installer.once("close", (status) => runtime.send({ installerStatus: status ?? 1 }));
  runtime.once("message", (message) => {
    if (message === "release") runtime.exit(0);
  });
  runtime.once("disconnect", () => {
    try {
      signalGroupImpl(runtime.pid, "TERM");
    } catch {
      /* The KILL deadline remains mandatory. */
    }
    setTimeout(() => signalGroupImpl(runtime.pid, "KILL"), INSTALLER_TIMEOUT_GRACE_MS);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv[2] === supervisorArgument
) {
  superviseInstaller();
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const identity = await resolveInstallerIdentity(process.env);
    const { chromium } = await import("@playwright/test");
    const result = await runInstaller({ identity, cacheHit: existsSync(chromium.executablePath()) });
    process.exitCode = result.status;
  } catch {
    console.error("provider-browser-install-refused:authority");
    process.exitCode = 1;
  }
}
