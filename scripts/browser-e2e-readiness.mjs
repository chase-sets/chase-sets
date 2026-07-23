import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  createReadinessTimeline,
  formatServiceLifecycleEvidence,
  readJsonIfPresent,
  resolveBrowserE2eEvidencePaths,
  writeBrowserE2eReadinessEvidence,
} from "./browser-e2e-evidence.mjs";
import { resolveBrowserE2eSystemTarget } from "./dev-system-config.mjs";
import { resolveWorktreeSandbox } from "./lib/sandbox.mjs";

// Playwright permits each web server six hundred seconds to boot. Phase one
// includes a documented ninety-second Postgres allowance and sequential
// bootstraps, so it needs its own explicit, configurable share of that budget.
// A component that was ready and then regresses still fails quickly below.
export const defaultBrowserE2ePhaseOneTimeoutMs = 300_000;
export const browserE2ePhaseOneTimeoutEnv = "CHASE_SETS_BROWSER_E2E_PHASE_ONE_TIMEOUT_MS";
const defaultPollMs = 250;
const defaultRequestTimeoutMs = 2_000;
const defaultRegressionToleranceMs = 5_000;
const projectionTimeoutMs = 480_000;
const projectionStallTimeoutMs = 120_000;
// Each sample spans the bounded-context databases. A five-second cadence is
// frequent enough to prove progress while leaving connection capacity and CPU
// to the worker that readiness is observing.
const projectionPollMs = 5_000;
const browserE2eProjectionTargetContexts = new Set([
  "auth",
  "checkout",
  "discovery",
  "identity",
  "inventory",
  "marketplace",
  "platform-operations",
]);

export class BrowserE2eReadinessError extends Error {
  constructor(message, componentNames, { includesLifecycleEvidence = false } = {}) {
    super(message);
    this.name = "BrowserE2eReadinessError";
    this.componentNames = [...new Set(componentNames)].sort((left, right) => left.localeCompare(right, "en"));
    this.includesLifecycleEvidence = includesLifecycleEvidence;
  }
}

function readinessError(message, componentNames, options) {
  return new BrowserE2eReadinessError(message, componentNames, options);
}

async function lifecycleReport(componentNames, readLifecycleEvidence) {
  const lifecycleEvidence = await readLifecycleEvidence();
  return componentNames
    .map((componentName) => formatServiceLifecycleEvidence(lifecycleEvidence, componentName))
    .join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatDuration(timeoutMs) {
  return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000}s` : `${timeoutMs}ms`;
}

export function resolveBrowserE2ePhaseOneTimeoutMs(env = process.env) {
  const configured = env[browserE2ePhaseOneTimeoutEnv];
  if (configured === undefined || configured === "") {
    return defaultBrowserE2ePhaseOneTimeoutMs;
  }

  const timeoutMs = Number(configured);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${browserE2ePhaseOneTimeoutEnv} must be a positive integer number of milliseconds.`);
  }

  return timeoutMs;
}

async function probeComponent(component, fetchImpl, requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(component.url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const ready = response.status >= 200 && response.status < 300;
    return {
      ...component,
      ready,
      observation: ready ? `HTTP ${response.status}` : `HTTP ${response.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...component,
      ready: false,
      observation: message || "request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForBrowserE2eReadiness({
  components,
  fetchImpl = fetch,
  timeoutMs = defaultBrowserE2ePhaseOneTimeoutMs,
  pollMs = defaultPollMs,
  requestTimeoutMs = defaultRequestTimeoutMs,
  regressionToleranceMs = defaultRegressionToleranceMs,
  now = Date.now,
  sleepImpl = sleep,
  onObservations = () => undefined,
  readLifecycleEvidence = () => null,
} = {}) {
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error("Browser e2e readiness requires at least one named component.");
  }

  const states = new Map(
    components.map((component) => [
      component.name,
      {
        everReady: false,
        ready: false,
        lastObservation: "not checked",
        unavailableSince: null,
      },
    ]),
  );
  const startedAt = now();

  while (now() - startedAt < timeoutMs) {
    const observations = await Promise.all(
      components.map((component) => probeComponent(component, fetchImpl, requestTimeoutMs)),
    );
    await onObservations(observations);

    for (const observation of observations) {
      const state = states.get(observation.name);
      state.ready = observation.ready;
      state.lastObservation = observation.observation;

      if (observation.ready) {
        state.everReady = true;
        state.unavailableSince = null;
        continue;
      }

      if (state.everReady) {
        state.unavailableSince ??= now();
        if (now() - state.unavailableSince >= regressionToleranceMs) {
          const evidence = await lifecycleReport([observation.name], readLifecycleEvidence);
          throw readinessError(
            `Browser e2e boot failed: ${observation.name} became unavailable after reporting ready ` +
              `(${observation.observation}).\n${evidence}`,
            [observation.name],
            { includesLifecycleEvidence: true },
          );
        }
      }
    }

    const lifecycleEvidence = await readLifecycleEvidence();
    for (const observation of observations) {
      if (observation.ready) {
        continue;
      }
      const lifecycle = lifecycleEvidence?.services?.find((service) => service.name === observation.name);
      if (lifecycle && lifecycle.status !== "running") {
        throw readinessError(
          `Browser e2e boot failed: ${observation.name} exited before reporting ready ` +
            `(${observation.observation}). ${formatServiceLifecycleEvidence(lifecycleEvidence, observation.name)}`,
          [observation.name],
          { includesLifecycleEvidence: true },
        );
      }
    }

    if (observations.every((observation) => observation.ready)) {
      return observations;
    }

    await sleepImpl(pollMs);
  }

  const stalledComponents = components.filter((component) => !states.get(component.name).ready);
  const stalled = stalledComponents.map(
    (component) => `${component.name} (${states.get(component.name).lastObservation})`,
  );
  const stalledComponentNames = stalledComponents.map((component) => component.name);
  const evidence = await lifecycleReport(stalledComponentNames, readLifecycleEvidence);
  throw readinessError(
    `Browser e2e boot stalled after ${formatDuration(timeoutMs)}: ${stalled.join(", ") || "readiness regressed"}.\n${evidence}`,
    stalledComponentNames,
    { includesLifecycleEvidence: true },
  );
}

export function browserE2eComponents(sandbox) {
  return [
    { name: "marketplace", url: `${sandbox.urls.marketplaceWeb}/health/ready` },
    { name: "platform-api", url: `${sandbox.urls.platformApi}/health/ready` },
    { name: "platform-worker", url: `${sandbox.urls.platformWorker}/health/ready` },
  ];
}

function selectActiveCheckpointRows(rows, targetContextName) {
  const active = new Map();

  for (const row of rows) {
    const key = `${targetContextName}\0${row.projection_name}\0${row.source_context_name}`;
    const version = Number.parseInt(String(row.subscription_version), 10);
    const existing = active.get(key);
    if (!existing || version > existing.subscriptionVersion) {
      active.set(key, {
        key,
        targetContextName,
        projectionName: String(row.projection_name),
        sourceContextName: String(row.source_context_name),
        subscriptionVersion: version,
        position: String(row.last_global_position),
      });
    }
  }

  return [...active.values()];
}

export function evaluateProjectionReadiness(samples, { activeWakeIntentCount = 0 } = {}) {
  const heads = new Map(samples.map((sample) => [sample.contextName, BigInt(sample.head)]));
  const activeCheckpoints = samples.flatMap((sample) =>
    browserE2eProjectionTargetContexts.has(sample.contextName)
      ? selectActiveCheckpointRows(sample.checkpoints, sample.contextName)
      : [],
  );
  const lagging = activeCheckpoints
    .map((checkpoint) => {
      const head = heads.get(checkpoint.sourceContextName);
      if (head === undefined) {
        return {
          ...checkpoint,
          head: null,
          gap: null,
        };
      }

      const position = BigInt(checkpoint.position);
      return {
        ...checkpoint,
        head: String(head),
        gap: String(head > position ? head - position : 0n),
      };
    })
    .filter((checkpoint) => checkpoint.head === null || checkpoint.gap !== "0")
    .sort((left, right) => left.key.localeCompare(right.key));

  return {
    ready: activeCheckpoints.length > 0 && lagging.length === 0 && activeWakeIntentCount === 0,
    activeCheckpointCount: activeCheckpoints.length,
    activeWakeIntentCount,
    lagging,
    positions: new Map(activeCheckpoints.map((checkpoint) => [checkpoint.key, BigInt(checkpoint.position)])),
  };
}

function summarizeLaggingCheckpoints(lagging) {
  const entries = lagging.slice(0, 5).map((checkpoint) => {
    const name = `${checkpoint.targetContextName}/${checkpoint.projectionName}<-${checkpoint.sourceContextName}`;
    return checkpoint.head === null
      ? `${name} (source head unavailable)`
      : `${name} (${checkpoint.position}/${checkpoint.head})`;
  });
  const remaining = lagging.length - entries.length;
  return `${entries.join(", ")}${remaining > 0 ? `, +${remaining} more` : ""}`;
}

function positionsAdvanced(previous, current) {
  for (const [key, position] of current) {
    const previousPosition = previous.get(key);
    if (previousPosition === undefined || position > previousPosition) {
      return true;
    }
  }
  return false;
}

function normalizeWorkerSnapshot(snapshot) {
  if (Array.isArray(snapshot)) {
    return { projectionSamples: snapshot, activeWakeIntentCount: 0 };
  }

  return snapshot;
}

function summarizeWorkerLag(evaluation) {
  const projectionLag = summarizeLaggingCheckpoints(evaluation?.lagging ?? []);
  const wakeLag = evaluation?.activeWakeIntentCount
    ? `${evaluation.activeWakeIntentCount} active projection wake intent${evaluation.activeWakeIntentCount === 1 ? "" : "s"}`
    : "";
  return [projectionLag, wakeLag].filter(Boolean).join(", ") || "worker readiness did not converge";
}

export async function waitForProjectionReadiness({
  readSnapshot,
  assertLiveness = async () => undefined,
  timeoutMs = projectionTimeoutMs,
  stallTimeoutMs = projectionStallTimeoutMs,
  pollMs = projectionPollMs,
  now = Date.now,
  sleepImpl = sleep,
  onObservation = () => undefined,
} = {}) {
  const startedAt = now();
  let lastProgressAt = startedAt;
  let previousPositions = new Map();
  let previousWakeIntentCount = Number.POSITIVE_INFINITY;
  let lastEvaluation = null;
  let consecutiveReadySamples = 0;

  while (now() - startedAt < timeoutMs) {
    await assertLiveness();
    const snapshot = normalizeWorkerSnapshot(await readSnapshot());
    lastEvaluation = evaluateProjectionReadiness(snapshot.projectionSamples, {
      activeWakeIntentCount: snapshot.activeWakeIntentCount,
    });
    await onObservation({
      name: "platform-worker",
      ready: lastEvaluation.ready,
      observation: lastEvaluation.ready
        ? `${lastEvaluation.activeCheckpointCount} active projection checkpoints caught up`
        : summarizeWorkerLag(lastEvaluation),
    });
    if (lastEvaluation.ready) {
      consecutiveReadySamples += 1;
      if (consecutiveReadySamples >= 2) {
        return lastEvaluation;
      }
    } else {
      consecutiveReadySamples = 0;
    }

    if (
      positionsAdvanced(previousPositions, lastEvaluation.positions) ||
      lastEvaluation.activeWakeIntentCount < previousWakeIntentCount
    ) {
      lastProgressAt = now();
    } else if (now() - lastProgressAt >= stallTimeoutMs) {
      throw readinessError(
        `Browser e2e boot failed: platform-worker work stalled for ${formatDuration(stallTimeoutMs)}: ` +
          `${summarizeWorkerLag(lastEvaluation)}.`,
        ["platform-worker"],
      );
    }
    previousPositions = lastEvaluation.positions;
    previousWakeIntentCount = lastEvaluation.activeWakeIntentCount;
    await sleepImpl(pollMs);
  }

  throw readinessError(
    `Browser e2e boot stalled after ${formatDuration(timeoutMs)}: platform-worker ` +
      `${summarizeWorkerLag(lastEvaluation)}.`,
    ["platform-worker"],
  );
}

export async function primeBrowserE2eProjectionWakeRelayCursors({
  sandbox = resolveWorktreeSandbox(),
  createClient = (connectionString) => new pg.Client({ connectionString }),
} = {}) {
  const controlClient = createClient(sandbox.controlDatabaseUrl);
  let primedCount = 0;

  try {
    await controlClient.connect();

    for (const [contextName, connectionString] of Object.entries(sandbox.contextDatabaseUrls)) {
      const contextClient = createClient(connectionString);
      try {
        await contextClient.connect();
        const head = await contextClient.query(
          "SELECT COALESCE(MAX(global_position), 0)::text AS head FROM event_store_events WHERE stream_context_name = $1",
          [contextName],
        );
        const position = head.rows[0]?.head ?? "0";
        await controlClient.query(
          `INSERT INTO platform_projection_wake_relay_cursors (
             source_context_name,
             last_fanout_position,
             last_required_cursor,
             owner_id,
             fencing_token,
             metadata,
             updated_at
           ) VALUES ($1, $2::bigint, $3, 'browser-e2e-bootstrap', 1, $4::jsonb, now())
           ON CONFLICT (source_context_name) DO UPDATE
           SET last_fanout_position = GREATEST(
                 platform_projection_wake_relay_cursors.last_fanout_position,
                 EXCLUDED.last_fanout_position
               ),
               last_required_cursor = CASE
                 WHEN EXCLUDED.last_fanout_position >= platform_projection_wake_relay_cursors.last_fanout_position
                   THEN EXCLUDED.last_required_cursor
                 ELSE platform_projection_wake_relay_cursors.last_required_cursor
               END,
               metadata = platform_projection_wake_relay_cursors.metadata || EXCLUDED.metadata,
               updated_at = now()`,
          [contextName, position, `${contextName}:${position}`, JSON.stringify({ browserE2eSeedPrimed: true })],
        );
        primedCount += 1;
      } finally {
        await contextClient.end().catch(() => undefined);
      }
    }
  } finally {
    await controlClient.end().catch(() => undefined);
  }

  return primedCount;
}

function createProjectionSnapshotReader(sandbox) {
  async function query(connectionString, text, values = []) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      return await client.query(text, values);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async function readProjectionSample(contextName, connectionString) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      const head = await client.query(
        "SELECT COALESCE(MAX(global_position), 0)::text AS head FROM event_store_events WHERE stream_context_name = $1",
        [contextName],
      );
      const checkpoints = await client.query(
        `SELECT projection_name,
                source_context_name,
                subscription_version,
                last_global_position::text
         FROM event_subscription_checkpoints`,
      );
      return {
        contextName,
        head: head.rows[0]?.head ?? "0",
        checkpoints: checkpoints.rows,
      };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  return {
    read: async () => {
      const projectionSamples = [];

      // Keep the readiness probe's database footprint constant. Opening one
      // pool per bounded context can exhaust the shared local Postgres server
      // while the worker is doing its heaviest seed catch-up work.
      for (const [contextName, connectionString] of Object.entries(sandbox.contextDatabaseUrls)) {
        projectionSamples.push(await readProjectionSample(contextName, connectionString));
      }

      const wakeIntents = await query(
        sandbox.controlDatabaseUrl,
        `SELECT COUNT(*)::integer AS count
         FROM platform_projection_wake_intents
         WHERE state IN ('queued', 'claimed', 'failed')
           AND expires_at > now()`,
      );

      return {
        projectionSamples,
        activeWakeIntentCount: wakeIntents.rows[0]?.count ?? 0,
      };
    },
    close: async () => undefined,
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export async function runBrowserE2eReadinessCoordinator({
  sandbox = resolveWorktreeSandbox(),
  waitForReadiness = waitForBrowserE2eReadiness,
  phaseOneTimeoutMs = resolveBrowserE2ePhaseOneTimeoutMs(),
  target = resolveBrowserE2eSystemTarget(),
} = {}) {
  const evidencePaths = resolveBrowserE2eEvidencePaths(sandbox);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const timeline = createReadinessTimeline({ startedAtMs });
  const persistEvidence = (outcome, error = null) =>
    writeBrowserE2eReadinessEvidence({
      filePath: evidencePaths.readinessPath,
      sandboxId: sandbox.id,
      target,
      startedAt,
      outcome,
      error,
      timeline: timeline.snapshot(),
      lifecyclePath: evidencePaths.lifecyclePath,
    });
  let ready = false;
  const server = http.createServer((request, response) => {
    if (request.url !== "/health/ready") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: ready ? "ok" : "starting" }));
  });

  await listen(server, sandbox.ports.portal);
  persistEvidence("starting");
  console.log(
    `[browser-e2e-readiness] Awaiting marketplace, platform-api, and platform-worker at ${sandbox.urls.portal}/health/ready.`,
  );

  const stop = async () => {
    await close(server);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await waitForReadiness({
      components: browserE2eComponents(sandbox),
      timeoutMs: phaseOneTimeoutMs,
      readLifecycleEvidence: () => readJsonIfPresent(evidencePaths.lifecyclePath),
      onObservations: (observations) => {
        timeline.record("service-readiness", observations);
        persistEvidence("starting");
      },
    });
    const projectionSnapshots = createProjectionSnapshotReader(sandbox);
    let workerUnavailableSince = null;
    try {
      const projectionReadiness = await waitForProjectionReadiness({
        readSnapshot: projectionSnapshots.read,
        assertLiveness: async () => {
          const [worker] = await Promise.all(
            browserE2eComponents(sandbox)
              .filter((component) => component.name === "platform-worker")
              .map((component) => probeComponent(component, fetch, defaultRequestTimeoutMs)),
          );
          if (worker.ready) {
            workerUnavailableSince = null;
            return;
          }

          workerUnavailableSince ??= Date.now();
          if (Date.now() - workerUnavailableSince >= defaultRegressionToleranceMs) {
            throw readinessError(
              `Browser e2e boot failed: platform-worker became unavailable while projections were catching up ` +
                `(${worker.observation}).`,
              ["platform-worker"],
            );
          }
        },
        onObservation: (observation) => {
          timeline.record("projection-readiness", [observation]);
          persistEvidence("starting");
        },
      });
      console.log(
        `[browser-e2e-readiness] platform-worker caught up ${projectionReadiness.activeCheckpointCount} active projection checkpoints and drained its wake ledger.`,
      );
    } finally {
      await projectionSnapshots.close();
    }
    persistEvidence("ready");
    ready = true;
    console.log("[browser-e2e-readiness] marketplace, platform-api, and platform-worker are ready.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const componentNames =
      error instanceof BrowserE2eReadinessError
        ? error.componentNames
        : browserE2eComponents(sandbox).map((component) => component.name);
    const lifecycleEvidence = readJsonIfPresent(evidencePaths.lifecyclePath);
    const lifecycleReport =
      error instanceof BrowserE2eReadinessError && error.includesLifecycleEvidence
        ? ""
        : componentNames
            .map((componentName) => formatServiceLifecycleEvidence(lifecycleEvidence, componentName))
            .join("\n");
    const report = [message, lifecycleReport].filter(Boolean).join("\n");
    persistEvidence("failed", report);
    console.error(`[browser-e2e-readiness] ${report}`);
    await stop();
    throw error;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void runBrowserE2eReadinessCoordinator().catch(() => {
    process.exit(1);
  });
}
