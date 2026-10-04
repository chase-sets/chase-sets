import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";
import process from "node:process";

const serviceAccountPath = "/var/run/secrets/kubernetes.io/serviceaccount";
const kedaPausedReplicasAnnotation = "autoscaling.keda.sh/paused-replicas";
export const QUIESCE_PROTOCOL_VERSION = "owner-fenced-seed-yield/v1";
export const quiesceOwnerAnnotation = "chase-sets.com/quiesce-owner";
export const SEED_REFUSED_EXIT_CODE = 75;
export const SEED_PREEMPTED_EXIT_CODE = 76;

export function parseQuiesceOptions(argv, env = process.env) {
  const separatorIndex = argv.indexOf("--");
  const command = separatorIndex === -1 ? argv : argv.slice(separatorIndex + 1);
  const deployments = parseDeploymentList(env.CHASE_SETS_QUIESCE_DEPLOYMENTS);

  return {
    mode: env.CHASE_SETS_QUIESCE_MODE ?? "helm-hook",
    owner: env.CHASE_SETS_QUIESCE_OWNER,
    deployments,
    command,
    namespace: env.CHASE_SETS_KUBERNETES_NAMESPACE ?? null,
    timeoutMs: Number(env.CHASE_SETS_QUIESCE_TIMEOUT_SECONDS ?? "300") * 1000,
    commandTimeoutMs: Number(env.CHASE_SETS_BOOTSTRAP_COMMAND_TIMEOUT_SECONDS ?? "780") * 1000,
    pollIntervalMs: Number(env.CHASE_SETS_QUIESCE_POLL_INTERVAL_MS ?? "2000"),
    restoreOnFailure: env.CHASE_SETS_QUIESCE_RESTORE_ON_FAILURE !== "false",
    restoreOnSuccess: env.CHASE_SETS_QUIESCE_RESTORE_ON_SUCCESS === "true",
    ignoreMissingDeployments: env.CHASE_SETS_QUIESCE_IGNORE_MISSING_DEPLOYMENTS !== "false",
  };
}

export function parseDeploymentList(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function runQuiescedBootstrap(options) {
  validateOptions(options);
  if (options.mode === "scenario-seed") return runQuiescedSeed(options);

  const originals = new Map();
  const kedaManagedDeployments = new Set();
  const pausedScaledObjects = new Set();

  async function resumePausedScaledObjects() {
    for (const deployment of pausedScaledObjects) {
      await options.log(`Resuming KEDA autoscaling for ${deployment}.`);
      await options.kubernetes.resumeScaledObject(deployment);
      pausedScaledObjects.delete(deployment);
    }
  }

  async function restoreDirectlyManagedDeployments() {
    for (const [deployment, replicas] of originals) {
      if (kedaManagedDeployments.has(deployment)) continue;
      await options.log(`Restoring ${deployment} to ${replicas} replicas after bootstrap.`);
      await options.kubernetes.scaleDeployment(deployment, replicas);
      await options.kubernetes.waitForReplicas(deployment, replicas, {
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
      });
    }
  }

  for (const deployment of options.deployments) {
    try {
      const scale = await options.kubernetes.readScale(deployment);
      originals.set(deployment, scale.specReplicas);
    } catch (error) {
      if (options.ignoreMissingDeployments && isKubernetesNotFound(error)) {
        await options.log(`Skipping missing deployment ${deployment}; first install has no workers to quiesce.`);
        continue;
      }
      throw error;
    }
  }

  try {
    for (const deployment of originals.keys()) {
      await options.log(`Quiescing ${deployment} before bootstrap.`);
      if (await options.kubernetes.pauseScaledObject(deployment, options.owner)) {
        kedaManagedDeployments.add(deployment);
        pausedScaledObjects.add(deployment);
      } else {
        await options.log(`No ScaledObject found for ${deployment}; scaling the Deployment directly.`);
      }
      await options.kubernetes.scaleDeployment(deployment, 0);
    }

    for (const deployment of originals.keys()) {
      await options.kubernetes.waitForReplicas(deployment, 0, {
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
      });
    }

    const exitCode = await options.spawnCommand(options.command, {
      timeoutMs: options.commandTimeoutMs,
      log: options.log,
    });
    if (exitCode === 0) {
      if (options.restoreOnSuccess) {
        await restoreDirectlyManagedDeployments();
      }
      await options.log("Bootstrap completed; Helm may continue the rollout.");
      return 0;
    }

    await options.log(`Bootstrap failed with exit code ${exitCode}.`);
    if (options.restoreOnFailure) {
      await resumePausedScaledObjects();

      const directlyManagedDeployments = [...originals].filter(
        ([deployment]) => !kedaManagedDeployments.has(deployment),
      );
      for (const [deployment, replicas] of directlyManagedDeployments) {
        await options.log(`Restoring ${deployment} to ${replicas} replicas after failed bootstrap.`);
        await options.kubernetes.scaleDeployment(deployment, replicas);
      }

      for (const [deployment, replicas] of directlyManagedDeployments) {
        await options.kubernetes.waitForReplicas(deployment, replicas, {
          timeoutMs: options.timeoutMs,
          pollIntervalMs: options.pollIntervalMs,
        });
      }
    }

    return exitCode;
  } finally {
    await resumePausedScaledObjects();
  }
}

// Both acquisition and release re-read authority after a conflict. A stale resourceVersion
// must never turn a seed's finally into a resume of a newer hook's pause.
export async function changeSeedOwnership(kubernetes, name, owner, action, authorize = async () => true) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resource = await kubernetes.readScaledObject(name);
    const { resourceVersion, annotations = {} } = resource.metadata ?? {};
    if (!resourceVersion) return false;
    if (action === "acquire") {
      if (kedaPausedReplicasAnnotation in annotations || quiesceOwnerAnnotation in annotations) return false;
    } else if (annotations[quiesceOwnerAnnotation] !== owner) {
      return false;
    }
    if (!(await authorize(resource))) return false;
    try {
      await kubernetes.patchScaledObject(name, {
        metadata: {
          resourceVersion,
          annotations: {
            [kedaPausedReplicasAnnotation]: action === "acquire" ? "0" : null,
            [quiesceOwnerAnnotation]: action === "acquire" ? owner : null,
          },
        },
      });
      return true;
    } catch (error) {
      if (error.statusCode !== 409) throw error;
    }
  }
  return false;
}

async function runQuiescedSeed(options) {
  const name = options.deployments[0];
  const result = async (status, exitCode) => {
    await options.log(`scenario-seed result=${status}`);
    return exitCode;
  };
  try {
    if (!(await changeSeedOwnership(options.kubernetes, name, options.owner, "acquire"))) {
      return result("refused", SEED_REFUSED_EXIT_CODE);
    }
  } catch {
    return result("refused", SEED_REFUSED_EXIT_CODE);
  }

  const controller = new AbortController();
  let stopped = false;
  let timer;
  let unreadableTimer;
  let wake;
  const preempt = () => controller.abort();
  const readable = () => {
    clearTimeout(unreadableTimer);
    unreadableTimer = setTimeout(preempt, 6000);
  };
  readable();
  const monitor = (async () => {
    while (!stopped && !controller.signal.aborted) {
      const pollStartedAt = Date.now();
      try {
        const resource = await options.kubernetes.readScaledObject(name);
        if (stopped) return;
        if (
          typeof resource.metadata?.resourceVersion !== "string" ||
          resource.metadata?.annotations?.[quiesceOwnerAnnotation] !== options.owner ||
          resource.metadata?.annotations?.[kedaPausedReplicasAnnotation] !== "0"
        ) {
          preempt();
          return;
        }
        readable();
      } catch {
        // The independent watchdog also fires during a stalled request.
      }
      if (stopped || controller.signal.aborted) return;
      await new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(
          resolve,
          Math.max(0, Math.min(options.pollIntervalMs ?? 2000, 2000) - (Date.now() - pollStartedAt)),
        );
      });
    }
  })();

  let exitCode;
  let commandError;
  try {
    // KEDA applies paused-replicas=0. Seeds never restore Deployment replicas or
    // perform a late scale PATCH that could race a hook's finally.
    await options.kubernetes.waitForReplicas(name, 0, {
      timeoutMs: options.timeoutMs,
      pollIntervalMs: Math.min(options.pollIntervalMs ?? 2000, 2000),
      signal: controller.signal,
    });
    exitCode = controller.signal.aborted
      ? SEED_PREEMPTED_EXIT_CODE
      : await options.spawnCommand(options.command, {
          timeoutMs: options.commandTimeoutMs,
          log: options.log,
          signal: controller.signal,
        });
  } catch (error) {
    commandError = error;
  } finally {
    stopped = true;
    clearTimeout(timer);
    wake?.();
    await monitor;
    clearTimeout(unreadableTimer);
    if (!controller.signal.aborted) {
      try {
        if (!(await changeSeedOwnership(options.kubernetes, name, options.owner, "release"))) preempt();
      } catch {
        preempt();
      }
    }
  }
  if (commandError && !controller.signal.aborted) throw commandError;
  return controller.signal.aborted
    ? result("preempted", SEED_PREEMPTED_EXIT_CODE)
    : result(exitCode === 0 ? "success" : "failure", exitCode);
}

export function createKubernetesClient(options = {}) {
  const namespace = options.namespace ?? readFileSync(`${serviceAccountPath}/namespace`, "utf8").trim();
  const host = options.host ?? process.env.KUBERNETES_SERVICE_HOST;
  const port = options.port ?? process.env.KUBERNETES_SERVICE_PORT ?? "443";
  const token = options.token ?? readFileSync(`${serviceAccountPath}/token`, "utf8").trim();
  const ca = options.ca ?? readFileSync(`${serviceAccountPath}/ca.crt`);

  if (!host) {
    throw new Error("KUBERNETES_SERVICE_HOST is required for bootstrap quiesce.");
  }

  async function request(method, pathname, body) {
    const payload = body == null ? null : JSON.stringify(body);
    const response = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          method,
          host,
          port,
          path: pathname,
          ca,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(payload == null
              ? {}
              : {
                  "Content-Type": "application/merge-patch+json",
                  "Content-Length": Buffer.byteLength(payload),
                }),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 500) >= 400) {
              const error = new Error(`Kubernetes ${method} ${pathname} failed with ${res.statusCode}: ${text}`);
              error.statusCode = res.statusCode;
              reject(error);
              return;
            }
            try {
              resolve(text ? JSON.parse(text) : {});
            } catch (error) {
              reject(error);
            }
          });
        },
      );

      const deadline = setTimeout(() => req.destroy(new Error("Kubernetes request timed out after 2000ms.")), 2000);
      req.on("error", reject);
      req.on("close", () => clearTimeout(deadline));
      if (payload != null) {
        req.write(payload);
      }
      req.end();
    });

    return response;
  }

  function deploymentPath(name) {
    return `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`;
  }

  function scalePath(name) {
    return `${deploymentPath(name)}/scale`;
  }

  function scaledObjectPath(name) {
    return `/apis/keda.sh/v1alpha1/namespaces/${encodeURIComponent(namespace)}/scaledobjects/${encodeURIComponent(name)}`;
  }

  async function patchScaledObjectPausedReplicas(name, pausedReplicas, owner = null) {
    try {
      await request("PATCH", scaledObjectPath(name), {
        metadata: {
          annotations: {
            [kedaPausedReplicasAnnotation]: pausedReplicas,
            [quiesceOwnerAnnotation]: owner,
          },
        },
      });
      return true;
    } catch (error) {
      if (isKubernetesNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  return {
    readScaledObject: (name) => request("GET", scaledObjectPath(name)),
    patchScaledObject: (name, body) => request("PATCH", scaledObjectPath(name), body),
    async readScale(name) {
      const response = await request("GET", scalePath(name));
      return { specReplicas: Number(response.spec?.replicas ?? 0) };
    },
    async scaleDeployment(name, replicas) {
      await request("PATCH", scalePath(name), { spec: { replicas } });
    },
    async pauseScaledObject(name, owner) {
      return patchScaledObjectPausedReplicas(name, "0", owner);
    },
    async resumeScaledObject(name) {
      return patchScaledObjectPausedReplicas(name, null);
    },
    async waitForReplicas(name, replicas, waitOptions) {
      const deadline = Date.now() + waitOptions.timeoutMs;
      while (Date.now() <= deadline) {
        if (waitOptions.signal?.aborted) return;
        const response = await request("GET", deploymentPath(name));
        const status = response.status ?? {};
        const ready =
          replicas === 0
            ? Number(status.replicas ?? 0) === 0 && Number(status.availableReplicas ?? 0) === 0
            : Number(status.readyReplicas ?? 0) >= replicas;

        if (ready) {
          return;
        }

        await sleep(waitOptions.pollIntervalMs);
      }
      throw new Error(`Timed out waiting for ${name} to reach ${replicas} replicas.`);
    },
  };
}

export function spawnShellCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve(SEED_PREEMPTED_EXIT_CODE);
      return;
    }
    const child = spawn("sh", ["-lc", command.join(" ")], { stdio: "inherit", detached: true });
    let timedOut = false;
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    options.signal?.addEventListener("abort", killGroup, { once: true });
    const commandTimeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            void options.log?.(
              `Bootstrap command timed out after ${Math.round(options.timeoutMs / 1000)}s; terminating.`,
            );
            killGroup();
          }, options.timeoutMs)
        : null;
    child.on("error", (error) => {
      if (commandTimeout) {
        clearTimeout(commandTimeout);
      }
      options.signal?.removeEventListener("abort", killGroup);
      reject(error);
    });
    child.on("exit", (code) => {
      if (commandTimeout) {
        clearTimeout(commandTimeout);
      }
      options.signal?.removeEventListener("abort", killGroup);
      resolve(options.signal?.aborted ? SEED_PREEMPTED_EXIT_CODE : timedOut ? 124 : (code ?? 1));
    });
  });
}

function validateOptions(options) {
  if (!Array.isArray(options.deployments) || options.deployments.length === 0) {
    throw new Error("CHASE_SETS_QUIESCE_DEPLOYMENTS must include at least one deployment.");
  }
  if (!Array.isArray(options.command) || options.command.length === 0) {
    throw new Error("Bootstrap command is required after '--'.");
  }
  if (
    options.mode === "scenario-seed" &&
    (options.deployments.length !== 1 || !/^scenario-seed:[a-z0-9][a-z0-9.-]*$/.test(options.owner ?? ""))
  ) {
    throw new Error("Scenario seed requires one worker and a scenario-seed:<jobName> owner.");
  }
  if (options.mode && !["helm-hook", "scenario-seed"].includes(options.mode)) throw new Error("Unknown quiesce mode.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isKubernetesNotFound(error) {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404;
}

async function main() {
  if (process.argv[2] === "--protocol-version") {
    console.log(QUIESCE_PROTOCOL_VERSION);
    return;
  }
  const parsed = parseQuiesceOptions(process.argv.slice(2));
  if (parsed.mode === "helm-hook" && !/^helm-hook:.+/.test(parsed.owner ?? "")) {
    throw new Error("Helm hook requires a helm-hook:<pod> owner.");
  }
  const exitCode = await runQuiescedBootstrap({
    ...parsed,
    kubernetes: createKubernetesClient({ namespace: parsed.namespace }),
    spawnCommand: spawnShellCommand,
    log: (message) => {
      console.log(`[bootstrap-quiesce] ${message}`);
    },
  });
  process.exitCode = exitCode;
}

if (process.argv[1]?.endsWith("bootstrap-quiesce.mjs")) {
  main().catch((error) => {
    console.error(`[bootstrap-quiesce] ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
