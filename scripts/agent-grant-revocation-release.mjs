import { execFileSync, spawn as spawnCommand } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const roles = ["platform-api", "platform-worker"];
const environments = ["staging", "production"];
const component = "app.kubernetes.io/component";
const sha = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const refusalPattern = /^revocation_[a-z_]{1,64}$/;
const recoveryRunner = "auth.agent-grant-revocation-recovery";
const logWindow = { since: "5m", tail: 200, maxPods: 100 };
const failureCategories = new Set([
  "pod_exec",
  "rbac",
  "database_connectivity",
  "schema_permission",
  "application",
  "unknown",
]);

export function proofDigest(proof) {
  const keys = [...Object.keys(proof), ...Object.keys(proof.replicas[0])].sort();
  return createHash("sha256").update(JSON.stringify(proof, keys)).digest("hex");
}

function lastRefusalLine(text) {
  return text
    .slice(-4096)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => refusalPattern.test(line))
    .at(-1);
}

function lastDiagnosticLine(text) {
  return text
    .slice(-4096)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((value) => value?.schemaVersion === "agent-grant-revocation-diagnostic/v1")
    .at(-1);
}

// Only a bounded code crosses the CLI boundary; raw kubectl, git and pod errors can carry secrets.
export function refusalCode(error) {
  if (error instanceof Error && refusalPattern.test(error.message)) return error.message;
  return lastRefusalLine(typeof error?.stderr === "string" ? error.stderr : "") ?? "revocation_release_refused";
}

export function sqlstateClass(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code.slice(0, 2) : "unknown";
}

export function failureCategory(error) {
  const candidate = error && typeof error === "object" ? error.failureCategory : undefined;
  return typeof candidate === "string" && failureCategories.has(candidate) ? candidate : "unknown";
}

function diagnosticFromError(error) {
  const value = error && typeof error === "object" ? error.diagnostic : undefined;
  if (!value || typeof value !== "object") return null;
  return {
    identity: {
      state: ["activated", "dormant", "unknown"].includes(value.identity?.state) ? value.identity.state : "unknown",
    },
    sqlstateClass: /^[0-9A-Z]{2}$/.test(value.sqlstateClass ?? "") ? value.sqlstateClass : "unknown",
    failureCategory: failureCategories.has(value.failureCategory) ? value.failureCategory : "unknown",
  };
}

export function diagnosticRecord({ options, refusal, failure, identityState = "unknown" }) {
  const inherited = diagnosticFromError(failure);
  const statusIdentityState = ["activated", "dormant", "unknown"].includes(identityState) ? identityState : "unknown";
  const childIdentityState = inherited?.identity?.state;
  const identity = ["activated", "dormant"].includes(childIdentityState)
    ? inherited.identity
    : { state: statusIdentityState };
  return {
    schemaVersion: "agent-grant-revocation-diagnostic/v1",
    evidenceId: /^\d+\/\d+$/.test(options.evidenceId ?? "") ? options.evidenceId : "unknown/unknown",
    environment: options.environment,
    releaseCommit: options.releaseCommit,
    imageDigest: options.imageDigest,
    identity,
    code: refusal ?? "revocation_activation_succeeded",
    sqlstateClass: inherited?.sqlstateClass ?? sqlstateClass(failure),
    failureCategory: inherited?.failureCategory ?? failureCategory(failure),
  };
}

export function captureServingSet({
  pods,
  environment,
  namespace,
  releaseCommit,
  imageDigest,
  evidenceId,
  fenceId,
  support,
  now = new Date(),
}) {
  if (!environments.includes(environment)) throw new Error("revocation_environment_invalid");
  if (
    !sha.test(releaseCommit) ||
    !digestPattern.test(imageDigest) ||
    !Array.isArray(pods?.items) ||
    pods.metadata?.continue
  )
    throw new Error("revocation_census_incomplete");
  const replicas = [];
  for (const pod of pods.items) {
    const containers = pod.spec?.containers?.filter((container) => roles.includes(container.name)) ?? [];
    if (!containers.length && !roles.includes(pod.metadata?.labels?.[component])) continue;
    if (containers.length !== 1 || pod.metadata?.namespace !== namespace || !pod.metadata.uid || !pod.metadata.name)
      throw new Error("revocation_census_invalid_member");
    const container = containers[0];
    const statuses = pod.status?.containerStatuses?.filter((status) => status.name === container.name) ?? [];
    if (
      pod.status?.phase !== "Running" ||
      statuses.length !== 1 ||
      !statuses[0].ready ||
      !statuses[0].state?.running ||
      !container.image.endsWith(`@${imageDigest}`) ||
      !statuses[0].imageID?.endsWith(`@${imageDigest}`) ||
      support.get(pod.metadata.uid) !== 1
    )
      throw new Error("revocation_census_unsupported_member");
    replicas.push({
      id: pod.metadata.name,
      uid: pod.metadata.uid,
      role: container.name,
      commit: releaseCommit,
      digest: imageDigest,
      supportVersion: 1,
    });
  }
  replicas.sort((a, b) => a.id.localeCompare(b.id));
  if (
    !roles.every((role) => replicas.some((replica) => replica.role === role)) ||
    replicas.length > 500 ||
    new Set(replicas.map((replica) => replica.id)).size !== replicas.length
  )
    throw new Error("revocation_census_incomplete");
  return {
    environment,
    namespace,
    releaseCommit,
    imageDigest,
    evidenceId,
    fenceId,
    capturedAt: now.toISOString(),
    expectedReplicas: replicas.map((replica) => replica.id),
    replicas,
  };
}

export function admissionResources({ namespace, minimumCommit, imageDigests, frozen }) {
  if (
    !/^[a-z0-9-]{1,63}$/.test(namespace) ||
    !sha.test(minimumCommit) ||
    !imageDigests.length ||
    imageDigests.some((digest) => !digestPattern.test(digest))
  )
    throw new Error("revocation_floor_invalid");
  const name = `agent-grant-revocation-${namespace}`;
  const digests = [...new Set(imageDigests)].sort();
  return [
    {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicy",
      metadata: {
        name,
        annotations: {
          "chase-sets.com/revocation-minimum-commit": minimumCommit,
          "chase-sets.com/revocation-image-digests": JSON.stringify(digests),
        },
      },
      spec: {
        failurePolicy: "Fail",
        matchConstraints: {
          resourceRules: [
            { apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE", "UPDATE", "DELETE"], resources: ["pods"] },
          ],
        },
        variables: [{ name: "pod", expression: "request.operation == 'DELETE' ? oldObject : object" }],
        matchConditions: [
          {
            name: "revocation-runtime",
            expression: `(request.operation == 'DELETE' ? oldObject : object).spec.containers.exists(c, c.name in ['platform-api', 'platform-worker'])`,
          },
        ],
        validations: [
          {
            expression: frozen
              ? "false"
              : `request.operation == 'DELETE' || variables.pod.spec.containers.filter(c, c.name in ['platform-api', 'platform-worker']).all(c, ${JSON.stringify(digests)}.exists(d, c.image.endsWith('@' + d)))`,
            message: frozen
              ? "Agent Grant revocation membership is fenced for activation"
              : "Agent Grant revocation requires a floor-compatible immutable image",
          },
        ],
      },
    },
    {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicyBinding",
      metadata: { name },
      spec: {
        policyName: name,
        validationActions: ["Deny"],
        matchResources: { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": namespace } } },
      },
    },
  ];
}

function runCommand(file, args, input) {
  return execFileSync(file, args, {
    encoding: "utf8",
    input,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readFloor(namespace, run) {
  const raw = run("kubectl", [
    "get",
    "validatingadmissionpolicy",
    `agent-grant-revocation-${namespace}`,
    "--ignore-not-found",
    "-o",
    "json",
  ]);
  return raw ? JSON.parse(raw) : null;
}

function assertCompatible(commit, minimumCommit, run) {
  if (!sha.test(commit) || !sha.test(minimumCommit)) throw new Error("revocation_rollback_floor");
  run("git", ["merge-base", "--is-ancestor", minimumCommit, commit]);
  const source = run("git", [
    "show",
    `${commit}:bounded-contexts/identity/features/agent-grants/api/revocation-floor.ts`,
  ]);
  if (!source.includes("AGENT_GRANT_REVOCATION_SUPPORT_VERSION = 1;")) throw new Error("revocation_rollback_floor");
}

function installFloor(resources, run) {
  for (const resource of resources) run("kubectl", ["apply", "-f", "-"], JSON.stringify(resource));
  const policy = JSON.parse(
    run("kubectl", ["get", "validatingadmissionpolicy", resources[0].metadata.name, "-o", "json"]),
  );
  run("kubectl", [
    "wait",
    `validatingadmissionpolicy/${policy.metadata.name}`,
    `--for=jsonpath={.status.observedGeneration}=${policy.metadata.generation}`,
    "--timeout=60s",
  ]);
  const observed = JSON.parse(run("kubectl", ["get", "validatingadmissionpolicy", policy.metadata.name, "-o", "json"]));
  if (observed.status?.typeChecking?.expressionWarnings?.length) throw new Error("revocation_floor_invalid");
  return observed;
}

function activationStatus(namespace, run) {
  const pods = JSON.parse(run("kubectl", ["get", "pods", "-n", namespace, "--chunk-size=0", "-o", "json"]));
  const pod = pods.items.find(
    (pod) =>
      pod.status?.phase === "Running" && pod.spec?.containers?.some((container) => container.name === "platform-api"),
  );
  if (!pod) throw new Error("revocation_status_unavailable");
  const status = JSON.parse(
    run("kubectl", [
      "exec",
      "-n",
      namespace,
      pod.metadata.name,
      "-c",
      "platform-api",
      "--",
      "pnpm",
      "--filter",
      "@chase-sets/app-platform-api",
      "exec",
      "tsx",
      "scripts/activate-agent-grant-revocation.mts",
      "--status",
    ]),
  );
  if (!["activated", "dormant"].includes(status.state)) throw new Error("revocation_status_unavailable");
  return status;
}

function releaseUnactivatedFence(namespace, run) {
  if (activationStatus(namespace, run).state !== "dormant") return;
  const name = `agent-grant-revocation-${namespace}`;
  run("kubectl", ["delete", "validatingadmissionpolicybinding", name, "--ignore-not-found"]);
  run("kubectl", ["delete", "validatingadmissionpolicy", name, "--ignore-not-found"]);
}

function durableFloor(namespace, run) {
  const floor = readFloor(namespace, run);
  if (floor) return floor;
  let status;
  try {
    status = activationStatus(namespace, run);
  } catch {
    // A first support rollout may have no pod that can report activation.
  }
  return status?.state === "activated"
    ? admissionResources({
        namespace,
        minimumCommit: status.proof?.releaseCommit,
        imageDigests: [status.proof?.imageDigest],
        frozen: false,
      })[0]
    : null;
}

function checkRollback(namespace, commit, run) {
  const floor = durableFloor(namespace, run);
  if (floor && activationStatus(namespace, run).state === "dormant") {
    releaseUnactivatedFence(namespace, run);
    return;
  }
  if (floor) assertCompatible(commit, floor.metadata.annotations["chase-sets.com/revocation-minimum-commit"], run);
}

function prepare(options, run) {
  const floor = durableFloor(options.namespace, run);
  if (!floor) return "prepared";
  if (activationStatus(options.namespace, run).state === "dormant") {
    releaseUnactivatedFence(options.namespace, run);
    return "prepared";
  }
  const minimumCommit = floor.metadata.annotations["chase-sets.com/revocation-minimum-commit"];
  assertCompatible(options.releaseCommit, minimumCommit, run);
  const imageDigests = JSON.parse(floor.metadata.annotations["chase-sets.com/revocation-image-digests"]);
  installFloor(
    admissionResources({
      namespace: options.namespace,
      minimumCommit,
      imageDigests: [...imageDigests, options.imageDigest],
      frozen: false,
    }),
    run,
  );
  return "prepared";
}

async function activate(options, { run, spawn }) {
  const floor = readFloor(options.namespace, run);
  const status = activationStatus(options.namespace, run);
  if (status.state === "activated") {
    if (status.proof?.releaseCommit !== options.releaseCommit || status.proof?.imageDigest !== options.imageDigest)
      throw new Error("revocation_activation_conflict");
    if (!floor) throw new Error("revocation_floor_missing");
    const minimumCommit = floor.metadata.annotations["chase-sets.com/revocation-minimum-commit"];
    assertCompatible(options.releaseCommit, minimumCommit, run);
    const imageDigests = JSON.parse(floor.metadata.annotations["chase-sets.com/revocation-image-digests"]);
    // An earlier command may have committed and lost its reply while frozen.
    installFloor(admissionResources({ ...options, minimumCommit, imageDigests, frozen: false }), run);
    writeJson(options.out, { replay: true, proof: status.proof });
    return "replayed";
  }
  const minimumCommit =
    floor?.metadata.annotations["chase-sets.com/revocation-minimum-commit"] ?? options.releaseCommit;
  assertCompatible(options.releaseCommit, minimumCommit, run);
  const imageDigests = floor ? JSON.parse(floor.metadata.annotations["chase-sets.com/revocation-image-digests"]) : [];
  imageDigests.push(options.imageDigest);
  const readPods = () =>
    JSON.parse(run("kubectl", ["get", "pods", "-n", options.namespace, "--chunk-size=0", "-o", "json"]));
  const support = new Map();
  const initial = readPods();
  for (const pod of initial.items) {
    for (const container of pod.spec.containers.filter((container) => roles.includes(container.name))) {
      const output = JSON.parse(
        run("kubectl", [
          "exec",
          "-n",
          options.namespace,
          pod.metadata.name,
          "-c",
          container.name,
          "--",
          "pnpm",
          "--filter",
          "@chase-sets/app-platform-api",
          "exec",
          "tsx",
          "scripts/activate-agent-grant-revocation.mts",
          "--support",
        ]),
      );
      support.set(pod.metadata.uid, output.supportVersion);
    }
  }
  captureServingSet({ ...options, pods: initial, support, fenceId: "preflight" });
  const installed = installFloor(admissionResources({ ...options, minimumCommit, imageDigests, frozen: true }), run);
  const fenceId = `${installed.metadata.uid}:${installed.metadata.resourceVersion}`;
  const capture = () => {
    const current = readFloor(options.namespace, run);
    if (`${current?.metadata.uid}:${current?.metadata.resourceVersion}` !== fenceId)
      throw new Error("revocation_membership_changed");
    return captureServingSet({ ...options, pods: readPods(), support, fenceId });
  };
  const proof = capture();
  const api = proof.replicas.find((replica) => replica.role === "platform-api");
  // The admission fence remains installed on any uncertain command outcome.
  // Removing it after a lost commit reply would allow a pre-support rollback.
  const child = spawn(
    "kubectl",
    [
      "exec",
      "-i",
      "-n",
      options.namespace,
      api.id,
      "-c",
      "platform-api",
      "--",
      "pnpm",
      "--filter",
      "@chase-sets/app-platform-api",
      "exec",
      "tsx",
      "scripts/activate-agent-grant-revocation.mts",
    ],
    { stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 },
  );
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });
  let receipt;
  child.stdin.write(`${JSON.stringify(proof)}\n`);
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (Buffer.byteLength(line, "utf8") > 64 * 1024) throw new Error("revocation_command_protocol_invalid");
      const message = JSON.parse(line);
      if (message.state === "revalidate") child.stdin.write(`${JSON.stringify(capture())}\n`);
      else if (message.state === "activated") receipt = message;
      else throw new Error("revocation_command_protocol_invalid");
    }
    const code = await exited;
    if (code !== 0 || !receipt || receipt.proofDigest !== proofDigest(proof)) {
      const error = new Error((code !== 0 && lastRefusalLine(stderr)) || "revocation_activation_unconfirmed");
      const diagnostic = lastDiagnosticLine(stderr);
      if (diagnostic) error.diagnostic = diagnostic;
      throw error;
    }
  } catch (error) {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await exited;
    // This read takes Identity's activation lock. A missing response is never
    // treated as a dormant release or permission to remove the floor.
    releaseUnactivatedFence(options.namespace, run);
    throw error;
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await exited;
  }
  installFloor(admissionResources({ ...options, minimumCommit, imageDigests, frozen: false }), run);
  writeJson(options.out, { proof, receipt });
  return "activated";
}

export function summarizeRuntimeLog(text, tail = logWindow.tail) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const recovery = { completed: 0, failed: 0, firstAt: null, lastAt: null };
  let unparsed = 0;
  let errors = 0;
  let revocationErrors = 0;
  for (const line of lines) {
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      // Counted below; raw lines are never retained.
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      unparsed += 1;
      continue;
    }
    if (entry.level === "error") {
      errors += 1;
      if (line.includes("revocation")) revocationErrors += 1;
    }
    const outcome =
      entry.type === "worker.runner.completed" && entry.runnerName === recoveryRunner
        ? "completed"
        : entry.type === "platform-worker.runner.failed" && entry.runner === recoveryRunner
          ? "failed"
          : null;
    if (!outcome) continue;
    recovery[outcome] += 1;
    if (instantPattern.test(entry.timestamp ?? "")) {
      if (!recovery.firstAt || entry.timestamp < recovery.firstAt) recovery.firstAt = entry.timestamp;
      if (!recovery.lastAt || entry.timestamp > recovery.lastAt) recovery.lastAt = entry.timestamp;
    }
  }
  return { lines: lines.length, truncated: lines.length >= tail, unparsed, errors, revocationErrors, recovery };
}

function runtimeLogs(namespace, run) {
  const pods = JSON.parse(run("kubectl", ["get", "pods", "-n", namespace, "--chunk-size=0", "-o", "json"]));
  const members = (pods.items ?? []).flatMap((pod) =>
    (pod.spec?.containers ?? [])
      .filter((container) => roles.includes(container.name))
      .map((container) => ({ pod: String(pod.metadata?.name ?? ""), role: container.name })),
  );
  const observed = members.slice(0, logWindow.maxPods).map((member) => {
    if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(member.pod))
      return { ...member, pod: null, read: "unknown", code: "revocation_status_pod_invalid" };
    try {
      const text = run("kubectl", [
        "logs",
        "-n",
        namespace,
        member.pod,
        "-c",
        member.role,
        `--since=${logWindow.since}`,
        `--tail=${logWindow.tail}`,
      ]);
      return { ...member, read: "observed", ...summarizeRuntimeLog(text) };
    } catch (error) {
      return { ...member, read: "unknown", code: refusalCode(error) };
    }
  });
  return {
    since: logWindow.since,
    tail: logWindow.tail,
    complete:
      members.length > 0 &&
      members.length <= logWindow.maxPods &&
      observed.every((pod) => pod.read === "observed" && !pod.truncated),
    pods: observed,
  };
}

function floorStatus(namespace, run) {
  const floor = readFloor(namespace, run);
  if (!floor) return { state: "absent" };
  const annotations = floor.metadata?.annotations ?? {};
  let imageDigests;
  try {
    imageDigests = JSON.parse(annotations["chase-sets.com/revocation-image-digests"]);
  } catch {
    imageDigests = null;
  }
  const minimumCommit = annotations["chase-sets.com/revocation-minimum-commit"];
  if (
    !sha.test(minimumCommit ?? "") ||
    !Array.isArray(imageDigests) ||
    imageDigests.some((digest) => !digestPattern.test(digest))
  )
    return { state: "invalid" };
  return {
    state: "present",
    minimumCommit,
    imageDigests,
    frozen: floor.spec?.validations?.[0]?.expression === "false",
  };
}

function identityStatus(namespace, run) {
  const { state, proof, activation, nonterminal } = activationStatus(namespace, run);
  const validActivation =
    typeof activation?.eventId === "string" &&
    activation.eventId.length <= 128 &&
    Number.isSafeInteger(activation.streamVersion) &&
    instantPattern.test(activation.recordedAt ?? "") &&
    /^[a-f0-9]{64}$/.test(activation.proofDigest ?? "");
  const validNonterminal =
    Number.isSafeInteger(nonterminal?.count) &&
    nonterminal.count >= 0 &&
    (nonterminal.oldestAgeMs === null || Number.isFinite(nonterminal.oldestAgeMs)) &&
    [null, "admission", "activation", "unknown"].includes(nonterminal.oldestSource);
  return {
    state,
    proof: proof ?? null,
    activation: validActivation
      ? {
          eventId: activation.eventId,
          streamVersion: activation.streamVersion,
          recordedAt: activation.recordedAt,
          proofDigest: activation.proofDigest,
        }
      : null,
    // An older serving release reports state without the read-only summary.
    nonterminal: validNonterminal
      ? { count: nonterminal.count, oldestAgeMs: nonterminal.oldestAgeMs, oldestSource: nonterminal.oldestSource }
      : null,
  };
}

/**
 * The post-command record a deploy job retains. Every section is read
 * independently; a failed read is recorded as an unknown code, never as a pass.
 */
function captureStatus(
  { environment, namespace, command, outcome, refusal, evidenceId, releaseCommit, imageDigest, failure },
  { run, now },
) {
  const section = (read) => {
    try {
      return read();
    } catch (error) {
      return { state: "unknown", code: refusalCode(error) };
    }
  };
  const status = {
    schemaVersion: "agent-grant-revocation-status/v1",
    environment,
    namespace,
    evidenceId,
    releaseCommit,
    imageDigest,
    command,
    result: refusal ? "refused" : outcome,
    refusal,
    capturedAt: now().toISOString(),
    floor: section(() => floorStatus(namespace, run)),
    identity: section(() => identityStatus(namespace, run)),
    logs: section(() => runtimeLogs(namespace, run)),
  };
  status.diagnostic = refusal
    ? diagnosticRecord({
        options: { evidenceId, environment, releaseCommit, imageDigest },
        refusal,
        failure,
        identityState: status.identity?.state,
      })
    : null;
  return status;
}

export async function main(
  args = process.argv.slice(2),
  { run = runCommand, spawn = spawnCommand, now = () => new Date() } = {},
) {
  const [action, ...flags] = args;
  if (flags.length % 2 || !["prepare", "activate", "check-rollback"].includes(action))
    throw new Error("revocation_activation_arguments_invalid");
  const allowed = new Set(
    action === "check-rollback"
      ? ["--namespace", "--commit"]
      : [
          "--environment",
          "--namespace",
          "--release-commit",
          "--image-digest",
          "--status-out",
          ...(action === "activate" ? ["--out"] : []),
        ],
  );
  const keys = flags.filter((_, index) => index % 2 === 0);
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length || keys.length !== allowed.size)
    throw new Error("revocation_activation_arguments_invalid");
  const values = Object.fromEntries(
    Array.from({ length: flags.length / 2 }, (_, index) => [flags[index * 2], flags[index * 2 + 1]]),
  );
  const namespace = values["--namespace"];
  if (!/^[a-z0-9-]{1,63}$/.test(namespace ?? "")) throw new Error("revocation_namespace_invalid");
  if (action === "check-rollback") {
    checkRollback(namespace, values["--commit"], run);
    return;
  }
  const options = {
    environment: values["--environment"],
    namespace,
    releaseCommit: values["--release-commit"],
    imageDigest: values["--image-digest"],
    evidenceId: `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}`,
    out: values["--out"],
  };
  if (!environments.includes(options.environment)) throw new Error("revocation_environment_invalid");
  if (!sha.test(options.releaseCommit) || !digestPattern.test(options.imageDigest))
    throw new Error("revocation_release_identity_invalid");
  if (!values["--status-out"] || (action === "activate" && (!options.out || !/^\d+\/\d+$/.test(options.evidenceId))))
    throw new Error("revocation_activation_arguments_invalid");
  let failure;
  let outcome;
  try {
    outcome = action === "prepare" ? prepare(options, run) : await activate(options, { run, spawn });
  } catch (error) {
    failure = error;
  }
  const refusal = failure === undefined ? null : refusalCode(failure);
  let status;
  try {
    status = captureStatus({ ...options, command: action, outcome, refusal, failure }, { run, now });
    writeJson(values["--status-out"], status);
  } catch {
    // A refusal keeps its own code; a success without its record is not a success.
    if (!refusal) throw new Error("revocation_status_unwritten");
  }
  if (refusal)
    process.stdout.write(
      `${JSON.stringify(status?.diagnostic ?? diagnosticRecord({ options, refusal, failure, identityState: "unknown" }))}\n`,
    );
  if (failure !== undefined) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${refusalCode(error)}\n`);
    process.exitCode = 1;
  });
