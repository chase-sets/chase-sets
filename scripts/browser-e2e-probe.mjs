import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  browserE2eLifecyclePathEnv,
  browserE2eReadinessEvidencePathEnv,
  createBrowserE2eLifecycleRecorder,
  formatServiceLifecycleEvidence,
  readJsonIfPresent,
  writeJsonAtomic,
} from "./browser-e2e-evidence.mjs";
import { resolveBrowserE2eSystemTarget } from "./dev-system-config.mjs";
import { buildMinimalProcessEnvironment, runCommand, spawnCommand, terminateProcessTree } from "./lib/process.mjs";
import { repoRoot } from "./lib/repo.mjs";
import { resolveWorktreeSandbox } from "./lib/sandbox.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";

const probeTimeoutMs = 600_000;
const probePollMs = 250;
const probeRequestTimeoutMs = 2_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultOutputDirectory(now = Date.now()) {
  const timestamp = new Date(now).toISOString().replaceAll(":", "").replaceAll(".", "-");
  return path.join(repoRoot, "artifacts", "browser-e2e-probe", `${timestamp}-${process.pid}`);
}

function parseArguments(argv) {
  const outputIndex = argv.indexOf("--output");
  if (outputIndex === -1) {
    return { outputDirectory: defaultOutputDirectory() };
  }
  const value = argv[outputIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--output requires a directory path.");
  }
  return { outputDirectory: path.resolve(value) };
}

function childOutcome(child) {
  return {
    pid: child?.pid ?? null,
    exitCode: child?.exitCode ?? null,
    signal: child?.signalCode ?? null,
  };
}

async function waitForChildExit(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return childOutcome(child);
  }

  await Promise.race([new Promise((resolve) => child.once("close", resolve)), sleep(timeoutMs)]);
  return childOutcome(child);
}

async function probePortal(url, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), probeRequestTimeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForReady({ portalUrl, devSystem, readiness, fetchImpl = fetch, now = Date.now, signal }) {
  const startedAt = now();
  while (now() - startedAt < probeTimeoutMs) {
    if (signal?.aborted) {
      throw new Error(`Standalone browser-e2e probe cancelled by ${signal.reason ?? "signal"}.`);
    }
    if (devSystem.probeSpawnError) {
      throw new Error(`browser-e2e dev-system failed to spawn: ${devSystem.probeSpawnError}`);
    }
    if (readiness.probeSpawnError) {
      throw new Error(`browser-e2e readiness coordinator failed to spawn: ${readiness.probeSpawnError}`);
    }
    if (devSystem.exitCode !== null || devSystem.signalCode !== null) {
      throw new Error(
        `browser-e2e dev-system exited before readiness (code=${devSystem.exitCode ?? "none"}, signal=${devSystem.signalCode ?? "none"}).`,
      );
    }
    if (readiness.exitCode !== null || readiness.signalCode !== null) {
      throw new Error(
        `browser-e2e readiness coordinator exited before readiness (code=${readiness.exitCode ?? "none"}, signal=${readiness.signalCode ?? "none"}).`,
      );
    }
    if (await probePortal(`${portalUrl}/health/ready`, fetchImpl)) {
      return;
    }
    await sleep(probePollMs);
  }
  throw new Error(`Standalone browser-e2e probe stalled after ${probeTimeoutMs / 1_000}s.`);
}

function requestDevSystemShutdown(child) {
  if (child?.connected) {
    try {
      child.send({ type: "browser-e2e-probe-shutdown" });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function assertReadyEvidence({ lifecyclePath, readinessPath }) {
  const lifecycle = readJsonIfPresent(lifecyclePath);
  const readiness = readJsonIfPresent(readinessPath);
  const requiredComponents = ["marketplace", "platform-api", "platform-worker"];

  for (const componentName of requiredComponents) {
    const service = lifecycle?.services?.find((candidate) => candidate.name === componentName);
    if (!service?.spawnedAt || !Number.isInteger(service.pid)) {
      throw new Error(`Standalone browser-e2e probe is missing lifecycle identity for ${componentName}.`);
    }
    const readyObservation = readiness?.readinessTimeline?.some(
      (entry) => entry.phase === "service-readiness" && entry.component === componentName && entry.ready,
    );
    if (!readyObservation) {
      throw new Error(`Standalone browser-e2e probe is missing a ready timeline entry for ${componentName}.`);
    }
  }

  const projectionsReady = readiness?.readinessTimeline?.some(
    (entry) => entry.phase === "projection-readiness" && entry.component === "platform-worker" && entry.ready,
  );
  if (readiness?.outcome !== "ready" || readiness.playwrightSpecsRun !== 0 || !projectionsReady) {
    throw new Error("Standalone browser-e2e probe readiness evidence is incomplete.");
  }
}

function buildProbeFailureReport(message, { lifecyclePath, readinessPath, webServersPath }) {
  const report = [message];
  const readiness = readJsonIfPresent(readinessPath);
  if (readiness?.error) {
    report.push(readiness.error);
  }

  const lifecycle = readJsonIfPresent(lifecyclePath);
  const failedServices = lifecycle?.services?.filter((service) => service.status !== "running") ?? [];
  report.push(...failedServices.map((service) => formatServiceLifecycleEvidence(lifecycle, service.name)));
  const webServers = readJsonIfPresent(webServersPath);
  const failedWebServers = webServers?.services?.filter((service) => service.status !== "running") ?? [];
  report.push(...failedWebServers.map((service) => formatServiceLifecycleEvidence(webServers, service.name)));
  return [...new Set(report)].join("\n");
}

export async function runBrowserE2eProbe({
  outputDirectory,
  sandbox = resolveWorktreeSandbox(),
  target = resolveBrowserE2eSystemTarget(),
  spawn = spawnCommand,
  run = runCommand,
  terminate = terminateProcessTree,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const resolvedOutputDirectory = path.resolve(outputDirectory ?? defaultOutputDirectory(now()));
  mkdirSync(resolvedOutputDirectory, { recursive: true });
  const lifecyclePath = path.join(resolvedOutputDirectory, "lifecycle.json");
  const readinessPath = path.join(resolvedOutputDirectory, "readiness.json");
  const webServersPath = path.join(resolvedOutputDirectory, "web-servers.json");
  const bundlePath = path.join(resolvedOutputDirectory, "probe.json");
  const hashPath = path.join(resolvedOutputDirectory, "probe.sha256");
  const startedAt = new Date(now()).toISOString();
  const childEnvironment = buildMinimalProcessEnvironment(process.env, {
    CHASE_SETS_BROWSER_E2E_PROBE: "true",
    [browserE2eLifecyclePathEnv]: lifecyclePath,
    [browserE2eReadinessEvidencePathEnv]: readinessPath,
    NOTIFICATION_EMAIL_PROVIDER: "noop",
    STRIPE_PUBLISHABLE_KEY: "",
    STRIPE_SECRET_KEY: "",
  });
  const commands = [
    {
      name: "dev-system",
      command: "node",
      args: ["./scripts/dev-system.mjs", "dev", target],
    },
    {
      name: "readiness",
      command: "node",
      args: ["./scripts/browser-e2e-readiness.mjs"],
    },
  ];
  let devSystem = null;
  let readiness = null;
  let outcome = "failed";
  let errorMessage = null;
  let devDown = { attempted: false, succeeded: false, error: null };
  const cancellation = new AbortController();
  const webServerRecorder = createBrowserE2eLifecycleRecorder({
    filePath: webServersPath,
    sandboxId: sandbox.id,
    target: `${target}-probe-web-servers`,
    now,
  });
  const signalHandlers = new Map(
    ["SIGINT", "SIGTERM"].map((signalName) => [signalName, () => cancellation.abort(signalName)]),
  );
  for (const [signalName, handler] of signalHandlers) {
    process.once(signalName, handler);
  }

  try {
    devSystem = spawn(commands[0].command, commands[0].args, {
      cwd: repoRoot,
      env: childEnvironment,
      inheritEnv: false,
      prefix: "browser-e2e-dev-system",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    devSystem.once("error", (error) => {
      devSystem.probeSpawnError = error instanceof Error ? error.message : String(error);
    });
    webServerRecorder.observe("dev-system", devSystem);
    readiness = spawn(commands[1].command, commands[1].args, {
      cwd: repoRoot,
      env: childEnvironment,
      inheritEnv: false,
      prefix: "browser-e2e-readiness",
    });
    readiness.once("error", (error) => {
      readiness.probeSpawnError = error instanceof Error ? error.message : String(error);
    });
    webServerRecorder.observe("readiness", readiness);
    await waitForReady({
      portalUrl: sandbox.urls.portal,
      devSystem,
      readiness,
      fetchImpl,
      now,
      signal: cancellation.signal,
    });
    assertReadyEvidence({ lifecyclePath, readinessPath });
    outcome = "ready";
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    if (devSystem && !requestDevSystemShutdown(devSystem)) {
      terminate(devSystem, "SIGTERM");
    }
    if (readiness) {
      terminate(readiness, "SIGTERM");
    }
    await Promise.all([waitForChildExit(devSystem), waitForChildExit(readiness)]);

    if (devSystem?.exitCode === null && devSystem?.signalCode === null) {
      terminate(devSystem, "SIGKILL");
    }
    if (readiness?.exitCode === null && readiness?.signalCode === null) {
      terminate(readiness, "SIGKILL");
    }
    await Promise.all([waitForChildExit(devSystem, 1_000), waitForChildExit(readiness, 1_000)]);

    devDown.attempted = true;
    try {
      await run("node", ["./scripts/dev-system.mjs", "down"], {
        cwd: repoRoot,
        env: childEnvironment,
        inheritEnv: false,
        prefix: "browser-e2e-probe-down",
      });
      devDown.succeeded = true;
    } catch (error) {
      devDown.error = error instanceof Error ? error.message : String(error);
      if (outcome === "ready") {
        outcome = "failed";
        errorMessage = `Lane-local teardown failed: ${devDown.error}`;
      }
    }
    for (const [signalName, handler] of signalHandlers) {
      process.off(signalName, handler);
    }
  }

  if (outcome !== "ready") {
    errorMessage = buildProbeFailureReport(errorMessage ?? "Standalone browser-e2e probe failed.", {
      lifecyclePath,
      readinessPath,
      webServersPath,
    });
  }
  const completedAt = new Date(now()).toISOString();
  const bundle = {
    schemaVersion: 1,
    kind: "browser-e2e-standalone-probe",
    sandboxId: sandbox.id,
    target,
    startedAt,
    completedAt,
    outcome,
    error: errorMessage,
    playwrightSpecsRun: 0,
    commands,
    lifecycle: readJsonIfPresent(lifecyclePath),
    readiness: readJsonIfPresent(readinessPath),
    webServers: readJsonIfPresent(webServersPath),
    teardown: {
      devSystem: childOutcome(devSystem),
      readiness: childOutcome(readiness),
      devDown,
    },
  };
  writeJsonAtomic(bundlePath, bundle);
  const hash = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
  writeFileSync(hashPath, `${hash}  probe.json\n`, "utf8");

  if (outcome !== "ready") {
    const error = new Error(errorMessage ?? "Standalone browser-e2e probe failed.");
    error.evidence = { bundlePath, hashPath, hash };
    throw error;
  }
  return { bundlePath, hashPath, hash, bundle };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  acquireHeavySlot("script-battery");
  try {
    const result = await runBrowserE2eProbe(parseArguments(process.argv.slice(2)));
    console.log(`[browser-e2e-probe] ready; zero Playwright specs ran.`);
    console.log(`[browser-e2e-probe] evidence=${result.bundlePath}`);
    console.log(`[browser-e2e-probe] sha256=${result.hash}`);
  } catch (error) {
    console.error(`[browser-e2e-probe] ${error instanceof Error ? error.message : String(error)}`);
    if (error?.evidence) {
      console.error(`[browser-e2e-probe] evidence=${error.evidence.bundlePath}`);
      console.error(`[browser-e2e-probe] sha256=${error.evidence.hash}`);
    }
    process.exitCode = 1;
  }
}
