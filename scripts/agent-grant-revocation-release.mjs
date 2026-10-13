import { execFileSync, spawn as spawnCommand } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const roles = ["platform-api", "platform-worker"];
const component = "app.kubernetes.io/component";
const sha = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export function proofDigest(proof) {
  const keys = [...Object.keys(proof), ...Object.keys(proof.replicas[0])].sort();
  return createHash("sha256").update(JSON.stringify(proof, keys)).digest("hex");
}

export function captureServingSet({
  pods,
  namespace,
  releaseCommit,
  imageDigest,
  evidenceId,
  fenceId,
  support,
  now = new Date(),
}) {
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
    environment: "production",
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

async function activate(options, floor, { run, spawn }) {
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
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify({ replay: true, proof: status.proof }, null, 2)}\n`);
    return;
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
  child.stderr.resume();
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
    if ((await exited) !== 0 || !receipt || receipt.proofDigest !== proofDigest(proof))
      throw new Error("revocation_activation_unconfirmed");
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
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify({ proof, receipt }, null, 2)}\n`);
}

export async function main(args = process.argv.slice(2), { run = runCommand, spawn = spawnCommand } = {}) {
  const [action, ...flags] = args;
  if (flags.length % 2 || !["prepare", "activate", "check-rollback"].includes(action))
    throw new Error("revocation_activation_arguments_invalid");
  const allowed = new Set(
    action === "check-rollback"
      ? ["--namespace", "--commit"]
      : ["--namespace", "--release-commit", "--image-digest", ...(action === "activate" ? ["--out"] : [])],
  );
  const keys = flags.filter((_, index) => index % 2 === 0);
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length || keys.length !== allowed.size)
    throw new Error("revocation_activation_arguments_invalid");
  const values = Object.fromEntries(
    Array.from({ length: flags.length / 2 }, (_, index) => [flags[index * 2], flags[index * 2 + 1]]),
  );
  const namespace = values["--namespace"];
  if (!/^[a-z0-9-]{1,63}$/.test(namespace ?? "")) throw new Error("revocation_namespace_invalid");
  let floor = readFloor(namespace, run);
  if (!floor && action !== "activate") {
    let status;
    try {
      status = activationStatus(namespace, run);
    } catch {
      // A first support rollout may have no pod that can report activation.
    }
    if (status?.state === "activated")
      floor = admissionResources({
        namespace,
        minimumCommit: status.proof?.releaseCommit,
        imageDigests: [status.proof?.imageDigest],
        frozen: false,
      })[0];
  }
  if (action === "check-rollback") {
    if (floor && activationStatus(namespace, run).state === "dormant") {
      releaseUnactivatedFence(namespace, run);
      return;
    }
    if (floor)
      assertCompatible(values["--commit"], floor.metadata.annotations["chase-sets.com/revocation-minimum-commit"], run);
    return;
  }
  const options = {
    namespace,
    releaseCommit: values["--release-commit"],
    imageDigest: values["--image-digest"],
    evidenceId: `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}`,
    out: values["--out"],
  };
  if (!sha.test(options.releaseCommit) || !digestPattern.test(options.imageDigest))
    throw new Error("revocation_release_identity_invalid");
  if (action === "prepare") {
    if (!floor) return;
    if (activationStatus(namespace, run).state === "dormant") {
      releaseUnactivatedFence(namespace, run);
      return;
    }
    const minimumCommit = floor.metadata.annotations["chase-sets.com/revocation-minimum-commit"];
    assertCompatible(options.releaseCommit, minimumCommit, run);
    const imageDigests = JSON.parse(floor.metadata.annotations["chase-sets.com/revocation-image-digests"]);
    installFloor(
      admissionResources({
        namespace,
        minimumCommit,
        imageDigests: [...imageDigests, options.imageDigest],
        frozen: false,
      }),
      run,
    );
    return;
  }
  if (action !== "activate" || !options.out || !/^\d+\/\d+$/.test(options.evidenceId))
    throw new Error("revocation_activation_arguments_invalid");
  await activate(options, floor, { run, spawn });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write("agent_grant_revocation_release_refused\n");
    process.exitCode = 1;
  });
