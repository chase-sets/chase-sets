import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildMinimalProcessEnvironment } from "./lib/process.mjs";
import { isValidTimingRecord, timingRecordLine } from "./provider-browser-install-timing.mjs";

export const INSTALLER_TIMEOUT_SECONDS = 600;
export const INSTALLER_TIMEOUT_MS = INSTALLER_TIMEOUT_SECONDS * 1000;
export const INSTALLER_TIMEOUT_GRACE_MS = 5_000;
export const INSTALLER_STEP = "Install provider browser boundary";
const supervisorArgument = "--installer-process-group";

// Root signalling reaches noninteractive sudo descendants of this owned group.
export function signalGroup(pid, signal) {
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

export async function resolveInstallerIdentity(
  env,
  fetchImpl = fetch,
  { jobName = "Static Checks", now = () => performance.now(), write = (line) => console.log(line) } = {},
) {
  const started = now();
  const elapsed = () => Math.max(0, Math.floor(now() - started));
  let observation = 0;
  let facts = {};
  const report = (reason) =>
    write(
      `provider-browser-install-authority-observation ${JSON.stringify({ reason, observation, elapsedMs: elapsed(), ...facts })}`,
    );
  const refuse = (reason) => {
    report(reason);
    return new Error(`provider-browser-install owning job refused:${reason}`);
  };
  if (
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") ||
    !Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT)) ||
    !/^[a-f0-9]{40}$/.test(env.BOUNDARY_HEAD_SHA ?? "") ||
    !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "") ||
    typeof env.GH_TOKEN !== "string" ||
    !env.GH_TOKEN ||
    typeof env.RUNNER_NAME !== "string" ||
    !env.RUNNER_NAME ||
    !["Static Checks", "Synthetic browser installer timeout"].includes(jobName)
  ) {
    throw refuse("invalid-environment");
  }
  while (observation < 37 && elapsed() < 180_000) {
    observation += 1;
    facts = {};
    const observedAt = now();
    const controller = new AbortController();
    let deadline;
    let phase = "request";
    let payload;
    try {
      payload = await Promise.race([
        (async () => {
          let response;
          try {
            response = await fetchImpl(
              `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`,
              {
                headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json" },
                signal: controller.signal,
              },
            );
          } catch {
            throw new Error("transport-failure");
          }
          if (!response?.ok) throw new Error("http-failure");
          phase = "body";
          try {
            return await response.json();
          } catch {
            throw new Error("body-failure");
          }
        })(),
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => {
              reject(new Error(elapsed() >= 180_000 ? "visibility-deadline" : `${phase}-timeout`));
              controller.abort();
            },
            Math.min(10_000, 180_000 - elapsed()),
          );
        }),
      ]);
    } catch (error) {
      const reason = [
        "transport-failure",
        "http-failure",
        "body-failure",
        "request-timeout",
        "body-timeout",
        "visibility-deadline",
      ].includes(error?.message)
        ? error.message
        : "transport-failure";
      throw refuse(reason);
    } finally {
      clearTimeout(deadline);
    }
    if (elapsed() >= 180_000) throw refuse("visibility-deadline");
    if (
      !payload ||
      !Array.isArray(payload.jobs) ||
      !Number.isInteger(payload.total_count) ||
      payload.total_count < 0 ||
      payload.total_count > 100 ||
      payload.jobs.length !== payload.total_count ||
      payload.jobs.some((job) => !job || typeof job !== "object" || typeof job.name !== "string")
    )
      throw refuse("malformed-incomplete-list");
    const jobs = payload.jobs.filter((job) => job.name === jobName);
    facts = { jobCount: payload.jobs.length, candidateCount: jobs.length };
    if (jobs.length > 1) throw refuse("duplicate-owner");
    if (jobs.length === 1) {
      const job = jobs[0];
      facts = {
        ...facts,
        status: ["queued", "in_progress", "completed", "cancelled"].includes(job.status) ? job.status : "unknown",
        runMatch: job.run_id === Number(env.GITHUB_RUN_ID),
        attemptMatch: job.run_attempt === Number(env.GITHUB_RUN_ATTEMPT),
        headMatch: job.head_sha === env.BOUNDARY_HEAD_SHA,
        runnerMatch: job.runner_name === env.RUNNER_NAME,
        runnerPending: job.runner_name === null,
        validJobId: Number.isSafeInteger(job.id) && job.id > 0,
      };
      if (
        !facts.runMatch ||
        !facts.attemptMatch ||
        !facts.headMatch ||
        !facts.validJobId ||
        (!facts.runnerMatch && !facts.runnerPending)
      )
        throw refuse("mismatched-owner");
      if (job.status === "in_progress" && facts.runnerMatch) {
        report("authority-resolved");
        const identity = {
          runId: env.GITHUB_RUN_ID,
          runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
          jobId: String(job.id),
          headSha: env.BOUNDARY_HEAD_SHA,
        };
        write(
          `provider-browser-install-authority-resolved ${JSON.stringify({ ...identity, runId: Number(identity.runId), jobId: Number(identity.jobId), elapsedMs: elapsed(), observation })}`,
        );
        return identity;
      }
      if (!["queued", "in_progress"].includes(job.status)) {
        throw refuse(["completed", "cancelled"].includes(job.status) ? "terminal-owner" : "unknown-owner-status");
      }
    }
    report("pending-visibility");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(Math.max(0, 5_000 - (now() - observedAt)), 180_000 - elapsed())),
    );
  }
  throw refuse("visibility-deadline");
}

export async function runHostedInstaller({
  env = process.env,
  fetchImpl = fetch,
  now = () => performance.now(),
  write = (line) => console.log(line),
  loadPlaywright = () => import("@playwright/test"),
  installerOptions = {},
} = {}) {
  let identity;
  try {
    identity = await resolveInstallerIdentity(env, fetchImpl, { now, write });
  } catch {
    return { status: 1 };
  }
  let chromium;
  try {
    ({ chromium } = await loadPlaywright());
  } catch {
    write("provider-browser-install-refused:playwright-import");
    return { status: 1 };
  }
  try {
    return await runInstaller({
      ...installerOptions,
      identity,
      env,
      write,
      cacheHit: existsSync(chromium.executablePath()),
    });
  } catch {
    write("provider-browser-install-refused:pre-spawn");
    return { status: 1 };
  }
}

export function runInstaller({
  identity,
  env = process.env,
  cacheHit = false,
  now = () => new Date(),
  spawnImpl = spawn,
  signalGroupImpl = signalGroup,
  write = (line) => console.log(line),
  installerCommand = ["bash", "scripts/provider-object-disposition/browser-boundary/ci-setup.sh"],
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
      [
        "GITHUB_ACTIONS",
        "RUNNER_ENVIRONMENT",
        "ImageOS",
        "ImageVersion",
        "BOUNDARY_HEAD_SHA",
        "PLAYWRIGHT_BROWSERS_PATH",
        "HOME",
      ].map((name) => [name, env[name]]),
    ),
  );
  childEnv.PROVIDER_BROWSER_INSTALL_COMMAND = JSON.stringify(installerCommand);
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

export function superviseInstaller({
  runtime = process,
  spawnImpl = spawn,
  signalGroupImpl = signalGroup,
  installerCommand = JSON.parse(
    runtime.env?.PROVIDER_BROWSER_INSTALL_COMMAND ??
      '["bash","scripts/provider-object-disposition/browser-boundary/ci-setup.sh"]',
  ),
} = {}) {
  // This detached group leader survives TERM and installer exit until the
  // owner releases it or kills the group, reserving its group id during grace.
  runtime.on("SIGTERM", () => {});
  const installer = spawnImpl(installerCommand[0], installerCommand.slice(1), {
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

// Shared deadline-bound process supervision for hosted browser installers. The
// provider-boundary installer above remains the authority-aware implementation;
// this small primitive owns only process lifetime and never receives provider
// credentials.
export function runBoundedProcess({
  command,
  env = process.env,
  timeoutMs = INSTALLER_TIMEOUT_MS,
  graceMs = INSTALLER_TIMEOUT_GRACE_MS,
  maxAttempts = 1,
  retryDelayMs = 0,
  spawnImpl = spawn,
  signalGroupImpl = signalGroup,
  write = (line) => console.log(line),
  site = "unknown",
  now = () => Date.now(),
  runtime = process,
  processKillImpl = process.kill,
} = {}) {
  if (!Array.isArray(command) || command.length < 1 || !command.every((value) => typeof value === "string" && value))
    return Promise.resolve({ status: 1, reason: "invalid-command", attempts: 0 });
  if (
    ![1, 2].includes(maxAttempts) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(graceMs) ||
    graceMs < 0
  )
    return Promise.resolve({ status: 1, reason: "invalid-budget", attempts: 0 });

  let cancelCurrent;
  const onCancel = () => cancelCurrent?.();
  runtime.on?.("SIGTERM", onCancel);
  runtime.on?.("SIGINT", onCancel);
  runtime.on?.("SIGHUP", onCancel);
  const runAttempt = (attempt) =>
    new Promise((resolve) => {
      let child;
      let settled = false;
      let deadline;
      let killTimer;
      let reason = "exit";
      let stopping = false;
      const finish = (status, terminalReason = reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(killTimer);
        resolve({ status: status ?? 1, reason: terminalReason, attempt });
      };
      const stop = (terminalReason) => {
        if (settled || stopping) return;
        stopping = true;
        reason = terminalReason;
        try {
          signalGroupImpl(child.pid, "TERM");
        } catch {
          finish(1, "cleanup-refused");
          return;
        }
        killTimer = setTimeout(() => {
          try {
            signalGroupImpl(child.pid, "KILL");
          } catch {
            finish(1, "cleanup-refused");
            return;
          }
          try {
            processKillImpl(-child.pid, 0);
            finish(1, "cleanup-refused");
          } catch (error) {
            if (error?.code === "ESRCH") finish(1, terminalReason);
            else finish(1, "cleanup-refused");
          }
        }, graceMs);
      };
      cancelCurrent = () => stop("cancellation");
      try {
        child = spawnImpl(command[0], command.slice(1), {
          detached: true,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        finish(1, "spawn-refused");
        return;
      }
      if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
        finish(1, "spawn-refused");
        return;
      }
      const consume = (stream) =>
        stream?.on("data", (chunk) => {
          const text = String(chunk).replace(/\s+/g, " ").trim().slice(0, 240);
          if (text) write(`Playwright Chromium install site=${site} attempt=${attempt}: ${text}`);
        });
      consume(child.stdout);
      consume(child.stderr);
      deadline = setTimeout(() => stop("timeout"), timeoutMs);
      child.once("error", () => finish(1, "process-error"));
      child.once("close", (status) => {
        if (settled || stopping) return;
        if (status === 0) finish(0, "success");
        else {
          try {
            processKillImpl(-child.pid, 0);
            stop("exit");
          } catch (error) {
            if (error?.code === "ESRCH") finish(status || 1, "exit");
            else finish(1, "cleanup-refused");
          }
        }
      });
    });

  const execute = async () => {
    const started = now();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      write(`Playwright Chromium install site=${site} attempt=${attempt}/${maxAttempts}`);
      const result = await runAttempt(attempt);
      if (result.status === 0) return { ...result, elapsedMs: now() - started };
      const retryable = attempt < maxAttempts && ["timeout", "exit", "process-error"].includes(result.reason);
      if (!retryable) {
        write(`Playwright Chromium install failed: site=${site} attempt=${attempt} reason=${result.reason}`);
        return { ...result, elapsedMs: now() - started };
      }
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    return { status: 1, reason: "exhausted", attempts: maxAttempts, elapsedMs: now() - started };
  };
  return execute().finally(() => {
    runtime.off?.("SIGTERM", onCancel);
    runtime.off?.("SIGINT", onCancel);
    runtime.off?.("SIGHUP", onCancel);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv[2] === supervisorArgument
) {
  superviseInstaller();
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = (await runHostedInstaller()).status;
}
