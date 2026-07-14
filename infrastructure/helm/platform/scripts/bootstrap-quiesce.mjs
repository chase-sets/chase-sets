import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";
import process from "node:process";

const serviceAccountPath = "/var/run/secrets/kubernetes.io/serviceaccount";
const kedaPausedReplicasAnnotation = "autoscaling.keda.sh/paused-replicas";

export function parseQuiesceOptions(argv, env = process.env) {
  const separatorIndex = argv.indexOf("--");
  const command = separatorIndex === -1 ? argv : argv.slice(separatorIndex + 1);
  const deployments = parseDeploymentList(env.CHASE_SETS_QUIESCE_DEPLOYMENTS);

  return {
    deployments,
    command,
    namespace: env.CHASE_SETS_KUBERNETES_NAMESPACE ?? null,
    timeoutMs: Number(env.CHASE_SETS_QUIESCE_TIMEOUT_SECONDS ?? "300") * 1000,
    commandTimeoutMs: Number(env.CHASE_SETS_BOOTSTRAP_COMMAND_TIMEOUT_SECONDS ?? "780") * 1000,
    pollIntervalMs: Number(env.CHASE_SETS_QUIESCE_POLL_INTERVAL_MS ?? "2000"),
    restoreOnFailure: env.CHASE_SETS_QUIESCE_RESTORE_ON_FAILURE !== "false",
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
      if (await options.kubernetes.pauseScaledObject(deployment)) {
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
            resolve(text ? JSON.parse(text) : {});
          });
        },
      );

      req.on("error", reject);
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

  async function patchScaledObjectPausedReplicas(name, pausedReplicas) {
    try {
      await request("PATCH", scaledObjectPath(name), {
        metadata: {
          annotations: {
            [kedaPausedReplicasAnnotation]: pausedReplicas,
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
    async readScale(name) {
      const response = await request("GET", scalePath(name));
      return { specReplicas: Number(response.spec?.replicas ?? 0) };
    },
    async scaleDeployment(name, replicas) {
      await request("PATCH", scalePath(name), { spec: { replicas } });
    },
    async pauseScaledObject(name) {
      return patchScaledObjectPausedReplicas(name, "0");
    },
    async resumeScaledObject(name) {
      return patchScaledObjectPausedReplicas(name, null);
    },
    async waitForReplicas(name, replicas, waitOptions) {
      const deadline = Date.now() + waitOptions.timeoutMs;
      while (Date.now() <= deadline) {
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
    const child = spawn("sh", ["-lc", command.join(" ")], { stdio: "inherit" });
    let timedOut = false;
    let forceKillTimeout = null;
    const commandTimeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            void options.log?.(
              `Bootstrap command timed out after ${Math.round(options.timeoutMs / 1000)}s; terminating.`,
            );
            child.kill("SIGTERM");
            forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 5000);
          }, options.timeoutMs)
        : null;
    child.on("error", (error) => {
      if (commandTimeout) {
        clearTimeout(commandTimeout);
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      reject(error);
    });
    child.on("exit", (code) => {
      if (commandTimeout) {
        clearTimeout(commandTimeout);
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      resolve(timedOut ? 124 : (code ?? 1));
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
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isKubernetesNotFound(error) {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404;
}

async function main() {
  const parsed = parseQuiesceOptions(process.argv.slice(2));
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
