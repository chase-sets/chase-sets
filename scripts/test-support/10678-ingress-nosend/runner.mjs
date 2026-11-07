// Hosted-only manual entry point. Nothing in this directory is auto-discovered as a script test.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isIPv4 } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDoksIngressValues } from "../../render-platform-helm-values.mjs";
import {
  assembleReceipt,
  invariant,
  isHash,
  isImage,
  isRef,
  matrix,
  parseAccess,
  parseProtocol,
  scanExposure,
  sha256,
  validateBundle,
} from "./helpers.mjs";
import {
  compareConfigMaps,
  enforceExecutables,
  enforceIdentityPins,
  hostedContext,
  invocation,
  inventoryPublicationFiles,
  measurementPublicationRehearsal,
  observeIdentity,
  preserveAuthority,
  preserveMetadata,
  projectIdentity,
  readAuthority,
  retainedPath,
  serializeIdentity,
} from "./inventory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const protocol = parseProtocol(readFileSync(path.join(here, "protocol.json"), "utf8"));
const phase = process.argv[2];
invariant(["prepare", "measure", "seal"].includes(phase) && process.argv.length === 4, "CLOSED_ARGV_REQUIRED");
invariant(
  process.platform === "linux" &&
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted",
  "HOSTED_LINUX_ONLY",
);
const event = hostedContext(protocol);
const configPath = realpathSync(process.argv[3]);
let authority = readAuthority(configPath, process.env.DIAGNOSTIC_FREEZE_SHA256, {
  head: event.head,
  phase: "measurement",
  protocol,
});
const config = authority.config;
const retainedConfigMap = path.join(repo, retainedPath);
invariant(process.getuid() !== 0, "NONROOT_RUNNER_CONTROL_REQUIRED");
const run = process.env.GITHUB_RUN_ID;
const attempt = process.env.GITHUB_RUN_ATTEMPT;
invariant(/^\d+$/.test(run) && /^\d+$/.test(attempt), "INVALID_RUN_IDENTITY");
const jobId = process.env.DIAGNOSTIC_JOB_ID;
invariant(jobId === undefined || /^\d+$/.test(jobId), "INVALID_EXECUTING_JOB_ID");
const jobIdentity = { key: protocol.job, numericId: jobId ?? "PENDING_HOST_ATTEMPT_SPECIFIC_JOB_AUTHORITY" };
const id = `nosend-${run}-${attempt}`;
const temp = realpathSync(process.env.RUNNER_TEMP);
const root = path.join(temp, "10678-ingress-nosend", `${run}-${attempt}`);
const privateDir = path.join(root, "private");
const capture = path.join(root, "diagnostic");
const stateFile = path.join(privateDir, "state.json");
const runtime = path.join(privateDir, "runtime");
const kubeconfig = path.join(privateDir, "kubeconfig");
const context = `kind-${id}`;
const publicationFiles = new Map();
const json = (file, data) => {
  if (path.dirname(file) === capture) publicationFiles.set(path.basename(file), "MEASUREMENT_JSON");
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
};
const text = (file) => readFileSync(file, "utf8");
let state;
if (phase === "prepare") {
  mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
  mkdirSync(root, { mode: 0o700 }); // EEXIST is a no-replay refusal, not permission to reset a run.
  for (const dir of [privateDir, capture, runtime, path.join(privateDir, "home"), path.join(privateDir, "docker")])
    mkdirSync(dir, { mode: 0o700 });
  state = {
    id,
    run,
    attempt,
    authority: authority.identity,
    commands: [],
    rows: [],
    phases: {},
    resources: [],
    boundaryInstalled: false,
  };
} else state = JSON.parse(text(stateFile));
for (const [file, role] of Object.entries(state.publicationRoles ?? {})) publicationFiles.set(file, role);
invariant(state.id === id, "STATE_IDENTITY_MISMATCH");
invariant(
  JSON.stringify(state.authority) === JSON.stringify(authority.identity),
  "STATE_ENVELOPE_SUBSTITUTION_REFUSED",
);
const save = () => {
  state.publicationRoles = Object.fromEntries(publicationFiles);
  json(stateFile, state);
};
const preserveMeasurementMetadata = (directory, prefix, role) => {
  preserveMetadata(directory, capture, prefix);
  for (const name of readdirSync(directory))
    if (statSync(path.join(directory, name)).isFile()) publicationFiles.set(`${prefix}${name}`, role);
};
const mark = (name, fields = {}) => {
  state.phases[name] = new Date().toISOString();
  json(path.join(capture, `phase-${name}.json`), { name, utc: state.phases[name], run, attempt, ...fields });
  save();
};
const childEnv = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: path.join(privateDir, "home"),
  XDG_CONFIG_HOME: path.join(privateDir, "home", "config"),
  XDG_CACHE_HOME: path.join(privateDir, "home", "cache"),
  DOCKER_CONFIG: path.join(privateDir, "docker"),
  KUBECONFIG: kubeconfig,
  HELM_CONFIG_HOME: path.join(privateDir, "home", "helm-config"),
  HELM_CACHE_HOME: path.join(privateDir, "home", "helm-cache"),
  HELM_DATA_HOME: path.join(privateDir, "home", "helm-data"),
  KIND_EXPERIMENTAL_DOCKER_NETWORK: id,
  LANG: "C.UTF-8",
  TZ: "UTC",
  CI: "true",
  npm_config_registry: "https://registry.npmjs.org/",
};

function pinFile(file, expected) {
  invariant(isHash(expected) && sha256(readFileSync(file)) === expected, "FILE_DIGEST_MISMATCH");
}

function verifyFreeze() {
  invariant(JSON.stringify(hostedContext(protocol)) === JSON.stringify(event), "EXECUTION_EVENT_DRIFT");
  authority = readAuthority(configPath, process.env.DIAGNOSTIC_FREEZE_SHA256, {
    head: event.head,
    phase: "measurement",
    protocol,
  });
  invariant(
    JSON.stringify(state.authority) === JSON.stringify(authority.identity),
    "STATE_ENVELOPE_SUBSTITUTION_REFUSED",
  );
  enforceExecutables(config.tools);
  pinFile(config.chart.path, config.chart.sha256);
  pinFile(retainedConfigMap, protocol.retainedConfigMapSha256);
  invariant(config.images?.prefetch?.every(isImage) && isImage(config.images.kind), "IMMUTABLE_IMAGES_REQUIRED");
  invariant(
    protocol.stacks.every((s) => isImage(config.images[s.id])),
    "IMMUTABLE_NODE_IMAGES_REQUIRED",
  );
  invariant(
    [config.images.kind, ...protocol.stacks.map((s) => config.images[s.id])].every((i) =>
      config.images.prefetch.includes(i),
    ),
    "INCOMPLETE_IMAGE_PREFETCH",
  );
}

async function command(tool, args, label, { cwd = repo, allowFailure = false, privileged = false } = {}) {
  invariant(/^[a-zA-Z0-9_.-]+$/.test(label), "INVALID_CAPTURE_LABEL");
  const n = String(state.commands.length + 1).padStart(4, "0");
  const output = path.join(capture, `${n}-${label}.stdout`);
  const error = path.join(capture, `${n}-${label}.stderr`);
  const entry = {
    tool,
    args,
    cwd,
    output: path.basename(output),
    error: path.basename(error),
    startedAt: new Date().toISOString(),
  };
  state.commands.push(entry);
  publicationFiles.set(path.basename(output), "MEASUREMENT_STDOUT");
  publicationFiles.set(path.basename(error), "MEASUREMENT_STDERR");
  save();
  const outFd = openSync(output, "wx", 0o600);
  const errFd = openSync(error, "wx", 0o600);
  try {
    const target = invocation(config.tools, tool, args);
    const executable = privileged ? config.tools.sudo.path : target.executable;
    const argv = privileged ? ["-n", target.executable, ...target.args] : target.args;
    entry.exit = await new Promise((resolve, reject) => {
      const child = spawn(executable, argv, { cwd, env: childEnv, stdio: ["ignore", outFd, errFd], shell: false });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        entry.signal = signal;
        resolve(code);
      });
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
    entry.completedAt = new Date().toISOString();
    save();
  }
  invariant(allowFailure || entry.exit === 0, `COMMAND_FAILED_${label}`);
  return { entry, output, value: text(output) };
}
const kubectl = (args, label, options) =>
  command("kubectl", ["--kubeconfig", kubeconfig, "--context", context, ...args], label, options);
const docker = (args, label, options) => command("docker", args, label, options);
async function documents(file, label) {
  const result = await command("yq", ["eval-all", "-o=json", "-I=0", "[.]", file], label);
  return JSON.parse(result.value).filter(Boolean);
}
function allImages(value) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "image" && typeof child === "string" ? [child] : allImages(child),
  );
}
async function apply(objects, label, privateOnly = false) {
  const file = path.join(privateOnly ? privateDir : capture, `${label}.json`);
  json(file, { apiVersion: "v1", kind: "List", items: objects });
  await kubectl(["apply", "-f", file], label);
}

async function prepareStacks() {
  state.stacks = {};
  for (const stack of protocol.stacks) {
    const source = path.join(privateDir, `source-${stack.id}`);
    mkdirSync(source);
    const archive = path.join(privateDir, `${stack.id}.tar`);
    await command("git", ["archive", "--format=tar", `--output=${archive}`, stack.ref], `source-${stack.id}`);
    await command("tar", ["-xf", archive, "-C", source], `extract-${stack.id}`);
    const declaredNodeImage = text(path.join(source, "Dockerfile")).match(/^FROM\s+(\S+)/m)?.[1];
    invariant(declaredNodeImage, "SOURCE_NODE_IMAGE_UNAVAILABLE");
    if (stack.id === "current")
      invariant(config.images.current === declaredNodeImage, "CURRENT_SOURCE_NODE_IMAGE_MISMATCH");
    else
      invariant(
        declaredNodeImage === "node:24-bookworm-slim" &&
          /^(?:docker\.io\/library\/)?node:24-bookworm-slim@sha256:/.test(config.images.historical),
        "HISTORICAL_NODE_FAMILY_MISMATCH",
      );
    await command(
      "pnpm",
      [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--ignore-pnpmfile",
        "--config.manage-package-manager-versions=false",
      ],
      `install-${stack.id}`,
      { cwd: source },
    );
    const adapter = JSON.parse(
      text(path.join(source, "deployables/platform-api/node_modules/@hono/node-server/package.json")),
    );
    invariant(adapter.version === stack.adapter, "ACTUAL_ADAPTER_MISMATCH");
    const entry = path.join(source, "deployables/platform-api/10678-synthetic.mjs");
    writeFileSync(entry, readFileSync(path.join(here, "synthetic-handler.mjs")));
    const bundle = path.join(privateDir, `${stack.id}.cjs`);
    const metafile = path.join(capture, `bundle-${stack.id}.json`);
    publicationFiles.set(path.basename(metafile), "MEASUREMENT_BUNDLE_METADATA");
    await command(
      "esbuild",
      [
        entry,
        "--bundle",
        "--platform=node",
        "--format=cjs",
        `--outfile=${bundle}`,
        `--metafile=${metafile}`,
        `--alias:@chase-sets/observability=${source}/infrastructure/observability/index.ts`,
        `--alias:@chase-sets/platform-runtime/process-lifecycle=${source}/infrastructure/platform-runtime/process-lifecycle.ts`,
      ],
      `bundle-${stack.id}`,
      { cwd: source },
    );
    const meta = JSON.parse(text(metafile));
    validateBundle(meta);
    const closure = Object.keys(meta.inputs).map((f) => ({
      file: f,
      sha256: sha256(readFileSync(path.resolve(source, f))),
    }));
    const runtimeDir = path.join(runtime, stack.id);
    mkdirSync(runtimeDir);
    writeFileSync(path.join(runtimeDir, "protocol.json"), readFileSync(path.join(here, "protocol.json")));
    state.stacks[stack.id] = {
      sourceRef: stack.ref,
      declaredNodeImage,
      adapter: adapter.version,
      historicalNodePatch: stack.historicalNodePatch ?? "NOT_APPLICABLE",
      bundle,
      bundleSha256: sha256(readFileSync(bundle)),
      lockfileSha256: sha256(readFileSync(path.join(source, "pnpm-lock.yaml"))),
      closure,
    };
    json(path.join(capture, `closure-${stack.id}.json`), state.stacks[stack.id]);
    save();
  }
}

async function prepareController() {
  const metadata = await command("helm", ["show", "chart", config.chart.path], "chart-metadata");
  const chart = (await documents(metadata.output, "chart-metadata-json"))[0];
  invariant(chart.name === "ingress-nginx" && chart.version === protocol.chart.version, "CHART_VERSION_MISMATCH");
  const values = (
    await documents(
      path.join(repo, "infrastructure/helm/doks-ingress/ingress-nginx-values.yaml"),
      "repository-ingress-values",
    )
  )[0];
  invariant(
    text(path.join(repo, "scripts/doks-cluster-addons.mjs")).includes('version: "4.11.3"'),
    "REPOSITORY_CHART_PIN_CHANGED",
  );
  values.controller.service.type = "NodePort";
  values.controller.service.annotations = {};
  values.controller.service.nodePorts = { http: 30080, https: 30443 };
  values.controller.hostPort.enabled = false;
  values.controller.config["error-log-path"] = "/dev/stderr";
  values.controller.config["error-log-level"] = "info";
  values.commonLabels = { "diagnostic-run": id };
  const localValues = path.join(capture, "local-ingress-values.json");
  json(localValues, values);
  const rendered = await command(
    "helm",
    ["template", "ingress-nginx", config.chart.path, "--namespace", "ingress-nginx", "-f", localValues],
    "rendered-controller",
  );
  const objects = await documents(rendered.output, "rendered-controller-json");
  const images = [...new Set(allImages(objects))];
  invariant(
    images.length >= 2 && images.every((image) => isImage(image) && config.images.prefetch.includes(image)),
    "UNPINNED_OR_UNPREFETCHED_CHART_IMAGE",
  );
  const expected = objects.find((o) => o.kind === "ConfigMap" && o.metadata.name === "ingress-nginx-controller");
  invariant(
    expected &&
      values.controller.config["ssl-redirect"] === "true" &&
      values.controller.config["custom-http-errors"] === "502,503,504",
    "CONFIGURATION_INCOMPLETE",
  );
  const retained = await command(
    "yq",
    ["eval-all", "-o=json", "-I=0", "[.]", retainedConfigMap],
    "retained-configmap-json",
  );
  compareConfigMaps(JSON.parse(retained.value), expected.data);
  state.expectedConfigMap = expected.data;
  state.chartImages = images;
  await command(
    "helm",
    [
      "install",
      "ingress-nginx",
      config.chart.path,
      "--namespace",
      "ingress-nginx",
      "--create-namespace",
      "--wait",
      "--wait-for-jobs",
      "--timeout",
      "180s",
      "-f",
      localValues,
      "--kubeconfig",
      kubeconfig,
      "--kube-context",
      context,
    ],
    "install-controller",
  );
  await command(
    "helm",
    [
      "get",
      "values",
      "ingress-nginx",
      "--namespace",
      "ingress-nginx",
      "--all",
      "--output",
      "json",
      "--kubeconfig",
      kubeconfig,
      "--kube-context",
      context,
    ],
    "effective-helm-values",
  );
}

async function container(name, image, args, mounts = [], extra = []) {
  invariant(config.images.prefetch.includes(image), "CONTAINER_IMAGE_NOT_PREFETCHED");
  const result = await docker(
    [
      "run",
      "--detach",
      "--pull",
      "never",
      "--name",
      name,
      "--label",
      `diagnostic-run=${id}`,
      "--network",
      id,
      "--read-only",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      ...mounts.flatMap(([source, target]) => ["--mount", `type=bind,src=${source},dst=${target},readonly`]),
      ...extra,
      image,
      ...args,
    ],
    `start-${name}`,
  );
  state.resources.push({ kind: "container", name, containerId: result.value.trim() });
  const inspected = await docker(["inspect", name], `inspect-${name}`);
  const object = JSON.parse(inspected.value)[0];
  const address = object.NetworkSettings.Networks[id].IPAddress;
  invariant(isIPv4(address) && address.startsWith("172.29."), "CONTAINER_ENDPOINT_NOT_LOCAL");
  save();
  return address;
}

async function waitForServer(name) {
  for (let i = 0; i < 20; i++) {
    const logs = await docker(["logs", name], `readiness-${name}-${i}`);
    if (jsonLines(logs.value).some((e) => ["server.listening", "control.listening"].includes(e.event))) return;
  }
  throw new Error("LOCAL_SYNTHETIC_SERVER_NOT_READY");
}

async function waitForApplication(row, began) {
  let poll = 0;
  while (Date.now() - began < 600000) {
    const logs = await docker(["logs", `${id}-${row.stack}`], `natural-completion-${row.id}-${poll++}`);
    const events = jsonLines(logs.value).filter((event) => event.row === row.id);
    if (events.some((e) => e.type === "http.request.completed") && events.some((e) => e.event === "response.close"))
      return;
    // Await natural completion, never close a socket or send another row while this application is active.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("PROTOCOL_CEILING_PARTIAL_UNKNOWN");
}

async function prepareRoutes() {
  const namespace = "diagnostic";
  await apply(
    [{ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels: { "diagnostic-run": id } } }],
    "namespace",
  );
  const cert = path.join(privateDir, "tls.crt");
  const key = path.join(privateDir, "tls.key");
  await command(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${protocol.host}`,
      "-addext",
      `subjectAltName=DNS:${protocol.host}`,
      "-keyout",
      key,
      "-out",
      cert,
    ],
    "self-signed-tls",
  );
  writeFileSync(path.join(runtime, "tls.crt"), readFileSync(cert));
  writeFileSync(path.join(runtime, "protocol.json"), readFileSync(path.join(here, "protocol.json")));
  await apply(
    [
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { namespace, name: "chase-sets-platform-doks-tls" },
        type: "kubernetes.io/tls",
        data: { "tls.crt": readFileSync(cert).toString("base64"), "tls.key": readFileSync(key).toString("base64") },
      },
    ],
    "self-signed-secret",
    true,
  );
  const rootAddress = await container(
    `${id}-root`,
    config.images.current,
    ["node", "/control.mjs"],
    [[path.join(here, "local-control.mjs"), "/control.mjs"]],
    ["--env", "DIAGNOSTIC_ROLE=root-route"],
  );
  for (const stack of protocol.stacks) {
    state.stacks[stack.id].address = await container(
      `${id}-${stack.id}`,
      config.images[stack.id],
      ["node", "/handler.cjs"],
      [
        [state.stacks[stack.id].bundle, "/handler.cjs"],
        [path.join(runtime, stack.id), "/diagnostic"],
      ],
      ["--env", `DIAGNOSTIC_STACK=${stack.id}`, "--env", "OBSERVABILITY_ENABLED=false"],
    );
  }
  for (const suffix of ["root", "historical", "current"]) await waitForServer(`${id}-${suffix}`);
  const ingressValues = buildDoksIngressValues({ env: { DOKS_INGRESS_TARGET: "synthetic-local-only" } });
  ingressValues.hosts = ingressValues.hosts.filter((host) => host.host === protocol.host);
  ingressValues.clusterIssuer = "";
  const platformValues = path.join(capture, "platform-route-values.json");
  json(platformValues, { doksIngress: ingressValues });
  const source = path.join(privateDir, "source-current");
  const rendered = await command(
    "helm",
    [
      "template",
      "chase-sets-platform",
      path.join(source, "infrastructure/helm/platform"),
      "--namespace",
      namespace,
      "-f",
      path.join(source, "infrastructure/helm/platform/values.yaml"),
      "-f",
      path.join(source, "infrastructure/helm/platform/values.staging.yaml"),
      "-f",
      platformValues,
      "--show-only",
      "templates/ingress.yaml",
    ],
    "rendered-platform-ingresses",
  );
  const ingresses = (await documents(rendered.output, "rendered-platform-json")).filter(
    (o) => o.kind === "Ingress" && o.spec.rules?.some((r) => r.host === protocol.host),
  );
  for (const ingress of ingresses) {
    ingress.metadata.namespace = namespace;
    ingress.metadata.labels = { ...ingress.metadata.labels, "diagnostic-run": id };
  }
  invariant(ingresses.length === 2, "ADMIN_INGRESS_SET_CHANGED");
  const paths = ingresses.flatMap((i) => i.spec.rules.flatMap((r) => r.http.paths));
  const api = paths.find((p) => p.path === "/api");
  const rootRoute = paths.find((p) => p.path === "/");
  invariant(
    api &&
      rootRoute &&
      api.backend.service.name !== rootRoute.backend.service.name &&
      api.backend.service.port.number === protocol.backendPort,
    "ROUTE_SHAPE_CHANGED",
  );
  state.apiService = api.backend.service.name;
  state.activeStack = "historical";
  const services = [...new Map(paths.map((p) => [p.backend.service.name, p.backend.service])).values()];
  await apply(
    services.map((s) => ({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: s.name, namespace },
      spec: { ports: [{ name: "http", port: s.port.number, targetPort: protocol.backendPort }] },
    })),
    "selectorless-services",
  );
  state.servicePorts = Object.fromEntries(services.map((s) => [s.name, s.port.number]));
  for (const service of services)
    await setEndpoint(
      service.name,
      service.name === state.apiService ? state.stacks.historical.address : rootAddress,
      `initial-${service.name}`,
    );
  await apply(ingresses, "stable-admin-ingresses");
  save();
}

async function setEndpoint(service, address, label) {
  await apply(
    [
      {
        apiVersion: "discovery.k8s.io/v1",
        kind: "EndpointSlice",
        metadata: {
          name: service,
          namespace: "diagnostic",
          labels: {
            "kubernetes.io/service-name": service,
            "endpointslice.kubernetes.io/managed-by": "10678-ingress-nosend",
            "diagnostic-run": id,
          },
        },
        addressType: "IPv4",
        ports: [{ name: "http", protocol: "TCP", port: protocol.backendPort }],
        endpoints: [{ addresses: [address], conditions: { ready: true } }],
      },
    ],
    label,
  );
}

async function captureCluster(label) {
  const configMap = await kubectl(
    ["-n", "ingress-nginx", "get", "configmap", "ingress-nginx-controller", "-o", "json"],
    `${label}-effective-configmap`,
  );
  invariant(
    JSON.stringify(Object.entries(JSON.parse(configMap.value).data).sort()) ===
      JSON.stringify(Object.entries(state.expectedConfigMap).sort()),
    "EFFECTIVE_CONFIGMAP_DRIFT",
  );
  const podsResult = await kubectl(["get", "pods", "--all-namespaces", "-o", "json"], `${label}-all-pods`);
  const pods = JSON.parse(podsResult.value).items;
  invariant(
    pods.every((p) => !(p.status.containerStatuses ?? []).some((s) => s.state?.waiting)),
    "POD_NOT_READY_OR_IMAGE_PULL_PENDING",
  );
  const inventory = JSON.parse(
    (
      await docker(
        ["exec", `${id}-control-plane`, "crictl", "images", "--output", "json"],
        `${label}-node-image-inventory`,
      )
    ).value,
  );
  const imageIds = inventory.images.map((image) => image.id).sort();
  if (!state.nodeImageIds) state.nodeImageIds = imageIds;
  invariant(JSON.stringify(state.nodeImageIds) === JSON.stringify(imageIds), "MEASURED_IMAGE_INVENTORY_CHANGED");
  for (const pod of pods)
    for (const status of [...(pod.status.initContainerStatuses ?? []), ...(pod.status.containerStatuses ?? [])])
      invariant(status.imageID?.includes("sha256:"), "UNBOUND_KUBERNETES_IMAGE");
  const topology = await kubectl(
    ["get", "ingress,service,endpointslice,deployment,replicaset", "--all-namespaces", "-o", "json"],
    `${label}-all-route-workload-objects`,
  );
  const objects = JSON.parse(topology.value).items;
  const service = objects.find(
    (o) =>
      o.kind === "Service" &&
      o.metadata.namespace === "ingress-nginx" &&
      o.metadata.name === "ingress-nginx-controller",
  );
  invariant(
    service?.spec.type === "NodePort" &&
      service.spec.ports.some((p) => p.nodePort === 30443) &&
      !Object.keys(service.metadata.annotations ?? {}).some((key) => key.startsWith("service.beta.kubernetes.io/do-")),
    "ACTUAL_NODEPORT_DEVIATION_MISMATCH",
  );
  const controllers = pods.filter(
    (p) =>
      p.metadata.namespace === "ingress-nginx" && p.metadata.labels["app.kubernetes.io/component"] === "controller",
  );
  invariant(
    controllers.length === 1 &&
      controllers[0].status.phase === "Running" &&
      controllers[0].status.containerStatuses.every((s) => s.ready) &&
      controllers[0].spec.containers.every((c) => (c.ports ?? []).every((p) => !p.hostPort)),
    "ACTUAL_CONTROLLER_STATE_MISMATCH",
  );
  const adminIngresses = objects.filter(
    (o) => o.kind === "Ingress" && o.spec.rules?.some((r) => r.host === protocol.host),
  );
  invariant(
    adminIngresses.length === 2 && adminIngresses.every((i) => i.metadata.namespace === "diagnostic"),
    "ACTUAL_ADMIN_TOPOLOGY_MISMATCH",
  );
  await kubectl(["get", "events", "--all-namespaces", "-o", "json"], `${label}-events`);
  for (const pod of pods.filter((p) => p.metadata.namespace === "ingress-nginx")) {
    for (const c of [...(pod.spec.initContainers ?? []), ...pod.spec.containers]) {
      await kubectl(
        ["-n", "ingress-nginx", "logs", pod.metadata.name, "-c", c.name, "--tail=-1", "--timestamps=true"],
        `${label}-${pod.metadata.name}-${c.name}-logs`,
      );
      const status = [...(pod.status.initContainerStatuses ?? []), ...(pod.status.containerStatuses ?? [])].find(
        (s) => s.name === c.name,
      );
      invariant(status?.imageID?.includes("sha256:") && status.restartCount === 0, "IMAGE_ID_OR_LIFECYCLE_UNKNOWN");
    }
    if (pod.metadata.labels["app.kubernetes.io/component"] === "controller") {
      const nginx = await kubectl(
        ["-n", "ingress-nginx", "exec", pod.metadata.name, "-c", "controller", "--", "nginx", "-T"],
        `${label}-${pod.metadata.name}-nginx-T`,
      );
      invariant(
        nginx.value.includes(protocol.host) &&
          !nginx.value.includes("listen 443 default_server ssl; # diagnostic override"),
        "NGINX_CONFIGURATION_UNKNOWN",
      );
    }
  }
  for (const stack of protocol.stacks)
    await docker(["logs", "--timestamps", `${id}-${stack.id}`], `${label}-application-${stack.id}`);
  await docker(["logs", "--timestamps", `${id}-root`], `${label}-root-route-control`);
  await docker(["network", "inspect", id], `${label}-network`);
  await firewallCapture(label);
}

async function firewallCapture(label) {
  for (const tool of ["iptables", "ip6tables"])
    await command(tool, ["-w", "5", "-L", "-n", "-v", "-x", "--line-numbers"], `${label}-${tool}`, {
      privileged: true,
    });
  await command("ip", ["-json", "route", "show", "table", "all"], `${label}-routes`);
}

async function proveBoundaryCounters() {
  const forwarded = await command(
    "iptables",
    ["-w", "5", "-L", "NS10678", "-n", "-v", "-x"],
    "proved-forward-rejections",
    { privileged: true },
  );
  const host = await command("iptables", ["-w", "5", "-L", "INPUT", "-n", "-v", "-x"], "proved-host-rejections", {
    privileged: true,
  });
  const dns = await command("iptables", ["-w", "5", "-L", "OUTPUT", "-n", "-v", "-x"], "proved-daemon-dns-rejections", {
    privileged: true,
  });
  const rejected = (value, filter) =>
    value.split(/\r?\n/).some((line) => {
      const m = line.match(/^\s*(\d+)\s+\d+\s+REJECT\s/);
      return m && Number(m[1]) > 0 && filter(line);
    });
  invariant(
    rejected(forwarded.value, (line) => line.includes(state.bridge)),
    "FORWARDED_EGRESS_NOT_PROVEN_BLOCKED",
  );
  invariant(
    rejected(host.value, (line) => line.includes(state.bridge)),
    "HOST_ESCAPE_NOT_PROVEN_BLOCKED",
  );
  invariant(
    rejected(dns.value, (line) => line.includes("dpt:53") && /UID match 0/.test(line)),
    "DAEMON_DNS_ESCAPE_NOT_PROVEN_BLOCKED",
  );
}

async function clusterControls(stack) {
  const name = `egress-${stack}`;
  const controls = {
    mode: "controls",
    address: state.nodeAddress,
    port: 30443,
    gateway: "172.29.0.1",
    expectedStack: stack,
    clusterControl: true,
  };
  await apply(
    [
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name, namespace: "diagnostic", labels: { "diagnostic-run": id } },
        data: {
          "client.mjs": text(path.join(here, "client.mjs")),
          "client.json": JSON.stringify(controls),
          "protocol.json": text(path.join(here, "protocol.json")),
          "tls.crt": text(path.join(runtime, "tls.crt")),
        },
      },
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name,
          namespace: "diagnostic",
          labels: { "diagnostic-run": id, "diagnostic-role": "egress-control" },
        },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          containers: [
            {
              name: "control",
              image: config.images.current,
              imagePullPolicy: "Never",
              command: ["node", "/diagnostic/client.mjs"],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: process.getuid(),
                runAsGroup: process.getgid(),
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              volumeMounts: [{ name: "control", mountPath: "/diagnostic", readOnly: true }],
            },
          ],
          volumes: [{ name: "control", configMap: { name } }],
        },
      },
    ],
    `pod-controls-${stack}`,
  );
  const waited = await kubectl(
    ["-n", "diagnostic", "wait", `pod/${name}`, "--for=jsonpath={.status.phase}=Succeeded", "--timeout=30s"],
    `wait-pod-controls-${stack}`,
    { allowFailure: true },
  );
  await kubectl(["-n", "diagnostic", "logs", name, "--tail=-1", "--timestamps=true"], `pod-controls-${stack}-logs`);
  invariant(waited.entry.exit === 0, "CLUSTER_EGRESS_CONTROL_FAILED");
  await proveBoundaryCounters();
}

async function installBoundary() {
  // All measured clients/backends AND kind nodes share this single, run-owned bridge.
  // INPUT covers host-gateway escape; DOCKER-USER covers forwarded/NAT escape, including node/pod traffic.
  const bridge = state.bridge;
  const daemonPid = (
    await command("systemctl", ["show", "docker", "--property", "MainPID", "--value"], "docker-daemon-pid")
  ).value.trim();
  invariant(/^\d+$/.test(daemonPid) && daemonPid !== "0", "DAEMON_IDENTITY_UNKNOWN");
  const daemonStatus = text(`/proc/${daemonPid}/status`);
  invariant(/^Uid:\s+0\s+0\s+0\s+0$/m.test(daemonStatus), "ROOTFUL_DAEMON_REQUIRED");
  json(path.join(capture, "daemon-dns-boundary-identity.json"), {
    pid: daemonPid,
    uid: 0,
    runnerUid: process.getuid(),
    reason: "Docker embedded DNS forwarding otherwise bypasses bridge FORWARD rules",
  });
  for (const tool of ["iptables", "ip6tables"]) {
    await command(
      tool,
      ["-w", "5", "-I", "INPUT", "1", "-i", bridge, "-m", "conntrack", "--ctstate", "NEW", "-j", "REJECT"],
      `${tool}-host-boundary`,
      { privileged: true },
    );
    await command(tool, ["-w", "5", "-N", "NS10678"], `${tool}-chain`, { privileged: true });
    await command(
      tool,
      ["-w", "5", "-A", "NS10678", "-i", bridge, "!", "-o", bridge, "-j", "REJECT"],
      `${tool}-deny-external`,
      { privileged: true },
    );
    await command(tool, ["-w", "5", "-A", "NS10678", "-j", "RETURN"], `${tool}-return`, { privileged: true });
    // FORWARD before Docker's own chains also covers Docker installations without IPv6 DOCKER-USER.
    await command(tool, ["-w", "5", "-I", "FORWARD", "1", "-j", "NS10678"], `${tool}-forward-boundary`, {
      privileged: true,
    });
    for (const transport of ["tcp", "udp"])
      await command(
        tool,
        [
          "-w",
          "5",
          "-I",
          "OUTPUT",
          "1",
          "-p",
          transport,
          "--dport",
          "53",
          "-m",
          "owner",
          "--uid-owner",
          "0",
          "-j",
          "REJECT",
        ],
        `${tool}-${transport}-daemon-dns-boundary`,
        { privileged: true },
      );
  }
  state.boundaryInstalled = true;
  save();
  await firewallCapture("boundary-installed");
}

async function client(mode, row, label, allowFailure = false) {
  json(path.join(runtime, "client.json"), {
    mode,
    row,
    address: state.nodeAddress,
    port: 30443,
    gateway: "172.29.0.1",
    expectedStack: state.activeStack,
  });
  const result = await docker(
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      id,
      "--label",
      `diagnostic-run=${id}`,
      "--read-only",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,src=${runtime},dst=/diagnostic,readonly`,
      "--mount",
      `type=bind,src=${path.join(here, "client.mjs")},dst=/client.mjs,readonly`,
      config.images.current,
      "node",
      "/client.mjs",
    ],
    label,
    { allowFailure },
  );
  return result;
}

async function prepare() {
  verifyFreeze();
  preserveAuthority(capture, authority, readFileSync(configPath));
  for (const [file, role] of inventoryPublicationFiles.slice(0, 6)) publicationFiles.set(file, role);
  preserveMeasurementMetadata(
    path.join(temp, "10678-authority", "bootstrap-identity"),
    "bootstrap-",
    "BOOTSTRAP_METADATA",
  );
  const actualIdentity = observeIdentity(path.join(privateDir, "preparation-identity"), config.tools);
  preserveMeasurementMetadata(
    path.join(privateDir, "preparation-identity"),
    "preparation-identity-",
    "PREPARATION_METADATA",
  );
  enforceIdentityPins(config, actualIdentity);
  mark("preparationStart");
  const head = await command("git", ["rev-parse", "HEAD"], "disk-head");
  invariant(head.value.trim() === config.head, "DISK_HEAD_MISMATCH");
  const daemon = await docker(["version", "--format", "{{json .}}"], "linux-docker-daemon");
  invariant(JSON.parse(daemon.value).Server.Os === "linux", "LINUX_DAEMON_REQUIRED");
  const versions = {
    node: ["--version"],
    git: ["--version"],
    tar: ["--version"],
    kind: ["version"],
    helm: ["version", "--short"],
    kubectl: ["version", "--client", "-o", "json"],
    pnpm: ["--version"],
    esbuild: ["--version"],
    yq: ["--version"],
    openssl: ["version", "-a"],
    sudo: ["--version"],
    iptables: ["--version"],
    ip6tables: ["--version"],
    ip: ["-Version"],
    systemctl: ["--version"],
  };
  for (const [tool, args] of Object.entries(versions)) await command(tool, args, `actual-version-${tool}`);
  json(path.join(capture, "exact-run-inputs.json"), {
    synthetic: true,
    head: config.head,
    ...event,
    run,
    attempt,
    jobIdentity,
    job: protocol.job,
    configSha256: sha256(readFileSync(configPath)),
    authority: authority.identity,
    pinSetSha256: sha256(
      JSON.stringify({
        tools: config.tools,
        bootstrapTools: config.bootstrapTools,
        daemonTools: config.daemonTools,
        expectedIdentity: config.expectedIdentity,
      }),
    ),
    actualIdentity: projectIdentity(actualIdentity),
    frozen: config,
    actualNode: process.version,
    historicalNodePatch: "UNKNOWN",
    childEnvironmentKeys: Object.keys(childEnv),
  });
  for (const image of config.images.prefetch) {
    await docker(["pull", image], `prefetch-${config.images.prefetch.indexOf(image)}`);
    await docker(["image", "inspect", image], `image-receipt-${config.images.prefetch.indexOf(image)}`);
  }
  await prepareStacks();
  const network = await docker(
    [
      "network",
      "create",
      "--driver",
      "bridge",
      "--subnet",
      "172.29.0.0/16",
      "--ipv6=false",
      "--label",
      `diagnostic-run=${id}`,
      id,
    ],
    "create-network",
  );
  state.resources.push({ kind: "network", name: id, networkId: network.value.trim() });
  state.bridge = `br-${network.value.trim().slice(0, 12)}`;
  const networkObject = JSON.parse((await docker(["network", "inspect", id], "created-network-identity")).value)[0];
  invariant(
    networkObject.Id === network.value.trim() &&
      networkObject.Driver === "bridge" &&
      networkObject.EnableIPv6 === false &&
      networkObject.Labels["diagnostic-run"] === id &&
      networkObject.IPAM.Config.some((c) => c.Subnet === "172.29.0.0/16"),
    "NETWORK_IDENTITY_MISMATCH",
  );
  await command("ip", ["-json", "link", "show", "dev", state.bridge], "created-bridge-identity");
  const kindConfig = path.join(capture, "kind-config.json");
  json(kindConfig, {
    kind: "Cluster",
    apiVersion: "kind.x-k8s.io/v1alpha4",
    networking: { apiServerAddress: "127.0.0.1", apiServerPort: 16443, ipFamily: "ipv4" },
    nodes: [{ role: "control-plane", image: config.images.kind }],
  });
  await command(
    "kind",
    [
      "create",
      "cluster",
      "--name",
      id,
      "--image",
      config.images.kind,
      "--config",
      kindConfig,
      "--kubeconfig",
      kubeconfig,
      "--wait",
      "180s",
    ],
    "create-disposable-cluster",
  );
  state.resources.push({ kind: "cluster", name: id, context, apiEndpoint: "https://127.0.0.1:16443" });
  const clusterConfig = await kubectl(["config", "view", "--minify", "-o", "json"], "local-context-identity");
  const kube = JSON.parse(clusterConfig.value);
  invariant(
    kube["current-context"] === context &&
      kube.clusters.length === 1 &&
      kube.clusters[0].cluster.server === "https://127.0.0.1:16443",
    "CLUSTER_ENDPOINT_MISMATCH",
  );
  const node = JSON.parse((await docker(["inspect", `${id}-control-plane`], "kind-node-identity")).value)[0];
  state.nodeAddress = node.NetworkSettings.Networks[id].IPAddress;
  invariant(isIPv4(state.nodeAddress) && state.nodeAddress.startsWith("172.29."), "NODE_ENDPOINT_NOT_LOCAL");
  for (const image of config.images.prefetch.filter((image) => image !== config.images.kind))
    await command(
      "kind",
      ["load", "docker-image", image, "--name", id],
      `load-image-${config.images.prefetch.indexOf(image)}`,
    );
  await prepareController();
  await prepareRoutes();
  await docker(
    [
      "run",
      "--detach",
      "--pull",
      "never",
      "--name",
      `${id}-blocked-host-sentinel`,
      "--label",
      `diagnostic-run=${id}`,
      "--network",
      "host",
      "--read-only",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--env",
      "DIAGNOSTIC_ROLE=blocked-host-sentinel",
      "--mount",
      `type=bind,src=${path.join(here, "local-control.mjs")},dst=/control.mjs,readonly`,
      config.images.current,
      "node",
      "/control.mjs",
    ],
    "start-host-negative-control",
  );
  state.resources.push({
    kind: "negative-control-container",
    name: `${id}-blocked-host-sentinel`,
    outsideMeasuredBridge: true,
  });
  await waitForServer(`${id}-blocked-host-sentinel`);
  await client("pre-boundary", undefined, "negative-target-preboundary-reachable");
  await installBoundary();
  await client("controls", undefined, "positive-route-negative-egress-controls");
  await proveBoundaryCounters();
  await clusterControls("historical");
  await captureCluster("before-matrix");
  mark("preparationComplete");
}

async function measure() {
  invariant(
    state.phases.preparationComplete && !state.phases.protocolStart && state.boundaryInstalled,
    "MEASUREMENT_NOT_ADMITTED",
  );
  verifyFreeze();
  const actualIdentity = observeIdentity(path.join(privateDir, "prepayload-identity"), config.tools);
  preserveMeasurementMetadata(
    path.join(privateDir, "prepayload-identity"),
    "prepayload-identity-",
    "PREPAYLOAD_METADATA",
  );
  enforceIdentityPins(config, actualIdentity);
  writeFileSync(path.join(capture, "prepayload-identity.json"), serializeIdentity(actualIdentity, authority.identity), {
    mode: 0o600,
  });
  publicationFiles.set("prepayload-identity.json", "MEASUREMENT_IDENTITY");
  const head = await command("git", ["rev-parse", "HEAD"], "prepayload-disk-head");
  invariant(head.value.trim() === config.head, "PREPAYLOAD_DISK_HEAD_MISMATCH");
  mark("protocolStart");
  const began = Date.now();
  for (const stack of protocol.stacks) {
    await setEndpoint(state.apiService, state.stacks[stack.id].address, `route-${stack.id}`);
    state.activeStack = stack.id;
    // Health checks do not execute generate, and cannot consume or replace a matrix row.
    const ready = await client("controls", undefined, `controls-${stack.id}`);
    invariant(ready.entry.exit === 0, "LOCAL_ROUTE_OR_EGRESS_CONTROL_FAILED");
    if (stack.id === "current") await clusterControls("current");
    await captureCluster(`start-${stack.id}`);
    json(path.join(runtime, stack.id, "armed.json"), {
      synthetic: true,
      stack: stack.id,
      run,
      attempt,
      protocolStart: state.phases.protocolStart,
    });
    for (const rung of matrix(protocol).filter((r) => r.stack === stack.id)) {
      invariant(Date.now() - began < 600000, "PROTOCOL_CEILING_PARTIAL_UNKNOWN");
      const row = { ...rung, startedAt: new Date().toISOString() };
      if (state.rows.length === 0) {
        json(path.join(capture, "command-ledger.json"), state.commands);
        measurementPublicationRehearsal(captureFiles(true), publicationFiles, (line) => console.log(line));
      }
      state.rows.push(row); // Persist BEFORE dispatch: an interrupted send is never silently repeated.
      save();
      const result = await client("row", rung.id, `client-${rung.id}`, true);
      row.completedAt = new Date().toISOString();
      row.clientCapture = result.entry.output;
      row.clientExit = result.entry.exit;
      save();
      await waitForApplication(row, began);
      await captureCluster(`after-${rung.id}`);
      invariant(row.clientExit === 0, "INCOMPLETE_CLIENT_RESPONSE_PARTIAL_UNKNOWN");
      invariant(Date.now() - began < 600000, "PROTOCOL_CEILING_PARTIAL_UNKNOWN");
    }
  }
  state.phases.protocolComplete = true;
  mark("protocolCompletion");
}

function jsonLines(value) {
  return value.split(/\r?\n/).flatMap((line) => {
    const start = line.indexOf("{");
    if (start < 0) return [];
    try {
      return [JSON.parse(line.slice(start))];
    } catch {
      return [];
    }
  });
}

function deriveRows() {
  for (const row of state.rows) {
    const commands = state.commands.filter((c) => c.completedAt);
    const appCapture = commands.find((c) => c.output.endsWith(`after-${row.id}-application-${row.stack}.stdout`));
    const appEvents = appCapture ? jsonLines(text(path.join(capture, appCapture.output))) : [];
    const app = appEvents.filter((e) => e.row === row.id && e.type === "http.request.completed");
    const result = appEvents.filter((e) => e.row === row.id && e.event === "handler.result");
    const defaults = appEvents.filter((e) => e.event === "server.defaults");
    const socket = appEvents.filter((e) => e.row === row.id && e.event === "response.close");
    const clientEvents = row.clientCapture ? jsonLines(text(path.join(capture, row.clientCapture))) : [];
    const clients = clientEvents.filter((e) => e.event === "client.result");
    const controllerLogs = commands.filter(
      (c) => c.output.includes(`after-${row.id}-`) && c.output.endsWith("-controller-logs.stdout"),
    );
    const access = controllerLogs.flatMap((c) =>
      text(path.join(capture, c.output))
        .split(/\r?\n/)
        .map((line) => parseAccess(line.replace(/^\S+ /, "")))
        .filter((entry) => entry?.userAgent === `ingress-nosend-${row.id}`)
        .map((entry) => ({ ...entry, controllerPod: c.args[c.args.indexOf("logs") + 1], rawCapture: c.output })),
    );
    row.captureComplete =
      app.length === 1 &&
      socket.length === 1 &&
      clients.length === 1 &&
      access.length === 1 &&
      result.length === 1 &&
      result[0].candidates === row.candidates &&
      result[0].bytes > 0 &&
      defaults.length === 1 &&
      defaults[0].adapter === protocol.stacks.find((s) => s.id === row.stack).adapter &&
      /^v24\./.test(defaults[0].node) &&
      access[0].endpoint.includes(`${state.stacks[row.stack].address}:${protocol.backendPort}`);
    row.app = app[0];
    row.socket = socket[0];
    row.client = clients[0];
    row.access = access[0];
    row.result = result[0];
    row.actualServerDefaults = defaults[0];
    row.correlation = {
      time: [row.startedAt, row.completedAt],
      path: protocol.path,
      backend: state.stacks[row.stack].address,
      applicationContainer: `${id}-${row.stack}`,
      controllerPod: access[0]?.controllerPod,
      nginxId: access[0]?.nginxId,
      appTrace: app[0]?.appTrace,
      sharedResponseRequestId: "NONE_NOT_INVENTED",
    };
  }
}

function captureFiles(includeGate = false) {
  // Only this exact flat diagnostic directory is inspected, never another lane or arbitrary tree.
  return readdirSync(capture)
    .filter((file) => includeGate || !["raw-manifest.json", "publication-gate.json"].includes(file))
    .sort()
    .map((file) => {
      invariant(statSync(path.join(capture, file)).isFile(), "UNEXPECTED_CAPTURE_DIRECTORY");
      const bytes = readFileSync(path.join(capture, file));
      return { file, bytes: bytes.length, sha256: sha256(bytes), text: bytes.toString("utf8") };
    });
}

async function seal() {
  verifyFreeze();
  const actualIdentity = observeIdentity(path.join(privateDir, "seal-identity"), config.tools);
  preserveMetadata(path.join(privateDir, "seal-identity"), capture, "seal-identity-");
  enforceIdentityPins(config, actualIdentity);
  const head = await command("git", ["rev-parse", "HEAD"], "seal-disk-head");
  invariant(head.value.trim() === config.head, "SEAL_DISK_HEAD_MISMATCH");
  invariant(!state.phases.sealed, "ALREADY_SEALED_NO_REPLAY");
  mark("captureStart");
  let captureComplete = true;
  if (state.phases.preparationComplete) {
    try {
      await captureCluster("final");
    } catch {
      captureComplete = false;
    }
    await docker(["logs", `${id}-blocked-host-sentinel`], "final-host-negative-control", { allowFailure: true });
  }
  deriveRows();
  mark("captureCompletion");
  json(path.join(capture, "command-ledger.json"), state.commands);
  const receipt = assembleReceipt(protocol, state.rows, state.phases);
  receipt.identity = {
    run,
    attempt,
    jobIdentity,
    head: config.head,
    ...event,
    frozenInputSha256: sha256(readFileSync(configPath)),
    authority: authority.identity,
    pinSetSha256: sha256(
      JSON.stringify({
        tools: config.tools,
        bootstrapTools: config.bootstrapTools,
        daemonTools: config.daemonTools,
        expectedIdentity: config.expectedIdentity,
      }),
    ),
  };
  receipt.failure = state.failure;
  receipt.captureComplete =
    captureComplete &&
    state.commands.every(
      (c) => c.completedAt && existsSync(path.join(capture, c.output)) && existsSync(path.join(capture, c.error)),
    );
  receipt.cleanup = {
    disposition: "RUNNER_DISPOSAL_REQUIRED_NO_WORKSTATION_OR_PROCESS_SIGNAL",
    resources: state.resources,
    teardownAuthority: "PENDING_HOST_RUNNER_COMPLETION",
    uncertainCleanup: "UNKNOWN_UNTIL_HOST_COMPLETION_RECEIPT",
  };
  json(path.join(capture, "receipt.json"), receipt);
  const files = captureFiles();
  const hits = scanExposure(files);
  json(path.join(capture, "raw-manifest.json"), {
    schema: 1,
    run,
    attempt,
    files: files.map(({ text: _text, ...file }) => file),
    receiptSha256: sha256(readFileSync(path.join(capture, "receipt.json"))),
  });
  const publish = hits.length === 0 && receipt.captureComplete && receipt.complete;
  json(path.join(capture, "publication-gate.json"), {
    publish,
    scan: hits.length ? "HITS" : "NO_HITS",
    hits,
    complete: receipt.complete,
    captureComplete: receipt.captureComplete,
    manifestSha256: sha256(readFileSync(path.join(capture, "raw-manifest.json"))),
  });
  state.phases.sealed = true;
  save();
  // Never print matched values, raw exception messages, bodies or stderr.
  console.log(JSON.stringify({ disposition: receipt.disposition, publish, hits }));
  if (!publish) process.exitCode = 1;
}

try {
  if (phase === "prepare") await prepare();
  if (phase === "measure") await measure();
  if (phase === "seal") await seal();
} catch (error) {
  state.failure = {
    phase,
    utc: new Date().toISOString(),
    reason: /^[A-Z0-9_-]+$/.test(error.message) ? error.message : "PRIVATE_CAPTURE_INSPECTION_REQUIRED",
  };
  save();
  json(path.join(capture, `failure-${phase}.json`), state.failure);
  console.log(
    JSON.stringify({
      phase,
      result: state.rows.length ? "PARTIAL_UNKNOWN" : "NOT_EXECUTED",
      reason: state.failure.reason,
    }),
  );
  process.exitCode = 1;
}
