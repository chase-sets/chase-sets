// Importing this module performs no queries. Only its closed CLI collects inventory.
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invariant, isHash, isRef, scanExposure, sha256 } from "./helpers.mjs";

export const supportPath = "scripts/test-support/10678-ingress-nosend";
export const decisionSha256 = "cd40037db2909c89980c8fdb365a2583cf5ca276122ebcdcda2e7456b30888b5";
export const retainedPath = `${supportPath}/retained-configmap.yaml`;
export const maximumEnvelopeBytes = 48000;
export const closurePaths = [
  "scripts/render-platform-helm-values.mjs",
  "scripts/lib/repo.mjs",
  "scripts/doks-cluster-addons.mjs",
  "infrastructure/helm/doks-ingress/ingress-nginx-values.yaml",
  "pnpm-lock.yaml",
  ".github/workflows/platform-pr.yml",
];
export const stockTools = [
  "node",
  "bash",
  "env",
  "curl",
  "sha256sum",
  "tar",
  "install",
  "cp",
  "chmod",
  "mkdir",
  "readlink",
  "dpkg-query",
  "apt-cache",
  "git",
  "docker",
  "openssl",
  "sudo",
  "iptables",
  "ip6tables",
  "ip",
  "systemctl",
  "containerd",
  "containerd-shim-runc-v2",
  "runc",
  "sh",
];
export const measurementTools = [...new Set([...stockTools, "kind", "helm", "kubectl", "pnpm", "esbuild", "yq"])];
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = (v) =>
  JSON.stringify(
    Array.isArray(v)
      ? v.map((x) => JSON.parse(canonical(x)))
      : record(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, JSON.parse(canonical(v[k]))]),
          )
        : v,
  );
const equal = (a, b) => canonical(a) === canonical(b);
const utf8 = (bytes) => {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  invariant(!value.startsWith("\ufeff") && Buffer.from(value).equals(bytes), "CANONICAL_UTF8_REQUIRED");
  return value;
};
const decode = (encoded, hash) => {
  invariant(
    typeof encoded === "string" && encoded.length > 0 && encoded.length <= maximumEnvelopeBytes,
    "MISSING_ENCODED_AUTHORITY",
  );
  const bytes = Buffer.from(encoded, "base64");
  invariant(bytes.toString("base64") === encoded && isHash(hash) && sha256(bytes) === hash, "AUTHORITY_BYTES_MISMATCH");
  utf8(bytes);
  return bytes;
};
const parseAuthorityJson = (bytes) => {
  try {
    return JSON.parse(utf8(bytes));
  } catch {
    throw new Error("MALFORMED_AUTHORITY_JSON");
  }
};
const exactKeys = (v, keys, code) => invariant(record(v) && equal(Object.keys(v).sort(), [...keys].sort()), code);

// JSON pointers project existing canonical records without changing their schema.
export function pointer(value, ref) {
  invariant(typeof ref === "string" && /^\/(?:[^~]|~[01])*$/.test(ref), "INVALID_CANONICAL_POINTER");
  for (const key of ref
    .slice(1)
    .split("/")
    .map((k) => k.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    invariant(record(value) && Object.hasOwn(value, key), "MISSING_CANONICAL_BINDING");
    value = value[key];
  }
  return value;
}

export function decodeAuthority(raw, expectedHash, { head, phase, protocol }) {
  invariant(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= maximumEnvelopeBytes, "ENVELOPE_SIZE_REFUSED");
  invariant(isHash(expectedHash) && sha256(raw) === expectedHash, "REVIEWED_FREEZE_DIGEST_REQUIRED");
  const envelope = parseAuthorityJson(raw);
  exactKeys(
    envelope,
    [
      "schema",
      "head",
      "phase",
      "verdict",
      "payloadUtf8Base64",
      "payloadSha256",
      "reviewUtf8Base64",
      "reviewSha256",
      "subjectBindingUtf8Base64",
      "subjectBindingSha256",
    ],
    "SCHEMA_2_EXTERNAL_ENVELOPE_REQUIRED",
  );
  invariant(envelope.schema === 2 && isRef(head) && envelope.head === head, "FROZEN_HEAD_MISMATCH");
  invariant(
    ["inventory", "measurement"].includes(envelope.phase) && (!phase || envelope.phase === phase),
    "AUTHORITY_PHASE_MISMATCH",
  );
  invariant(envelope.verdict === "PASS", "FRESH_REVIEW_REQUIRED");
  const payloadBytes = decode(envelope.payloadUtf8Base64, envelope.payloadSha256);
  const reviewBytes = decode(envelope.reviewUtf8Base64, envelope.reviewSha256);
  const subjectBytes = decode(envelope.subjectBindingUtf8Base64, envelope.subjectBindingSha256);
  const config = parseAuthorityJson(payloadBytes);
  invariant(
    record(config) && config.schema === 2 && config.head === head && config.phase === envelope.phase,
    "PAYLOAD_SUBJECT_MISMATCH",
  );
  for (const key of ["review", "verdict", "payloadSha256", "envelopeSha256", "receiptSha256"])
    invariant(!Object.hasOwn(config, key), "CIRCULAR_PAYLOAD_FIELD");
  invariant(
    config.briefSha256 === protocol.briefSha256 &&
      config.methodSha256 === protocol.methodSha256 &&
      config.decisionSha256 === decisionSha256,
    "AUTHORITY_BINDING_MISMATCH",
  );
  invariant(config.retainedConfigMap?.path === retainedPath, "FIXED_RETAINED_PATH_REQUIRED");
  const binding = parseAuthorityJson(subjectBytes);
  invariant(binding.schema === "10678-review-subject/v1", "CANONICAL_SUBJECT_REQUIRED");
  invariant(
    binding.head === head &&
      binding.phase === config.phase &&
      binding.payloadSha256 === envelope.payloadSha256 &&
      binding.verdict === "PASS" &&
      binding.reviewSha256 === envelope.reviewSha256,
    "STALE_OR_CONTRADICTORY_REVIEW",
  );
  const subject = `10678:${head}:${config.phase}:${envelope.payloadSha256}`;
  const dispatchBytes = decode(binding.dispatch?.utf8Base64, binding.dispatch?.sha256);
  const completionBytes = decode(binding.completion?.utf8Base64, binding.completion?.sha256);
  const dispatch = parseAuthorityJson(dispatchBytes);
  const completion = parseAuthorityJson(completionBytes);
  const d = binding.dispatch.pointers;
  const c = binding.completion.pointers;
  const dispatchIdentity = pointer(dispatch, d.identity);
  const completionIdentity = pointer(completion, c.identity);
  invariant(
    typeof dispatchIdentity === "string" &&
      dispatchIdentity.length > 0 &&
      typeof completionIdentity === "string" &&
      completionIdentity.length > 0 &&
      dispatchIdentity !== completionIdentity,
    "CANONICAL_IDENTITIES_REQUIRED",
  );
  invariant(
    pointer(dispatch, d.head) === head &&
      pointer(dispatch, d.subject) === subject &&
      pointer(completion, c.head) === head &&
      pointer(completion, c.subject) === subject &&
      pointer(completion, c.dispatchIdentity) === dispatchIdentity &&
      pointer(completion, c.verdict) === "PASS" &&
      pointer(completion, c.reviewSha256) === envelope.reviewSha256,
    "CANONICAL_REVIEW_BINDING_MISMATCH",
  );
  invariant(equal(config.sources, protocol.stacks), "SOURCE_PINS_CHANGED");
  if (config.phase === "measurement") validateMeasurementPins(config);
  return {
    config,
    envelope,
    payloadBytes,
    reviewBytes,
    subjectBytes,
    dispatchBytes,
    completionBytes,
    identity: {
      envelopeSha256: expectedHash,
      payloadSha256: envelope.payloadSha256,
      reviewSha256: envelope.reviewSha256,
      subjectBindingSha256: envelope.subjectBindingSha256,
      dispatchIdentity,
      completionIdentity,
      head,
      phase: config.phase,
    },
  };
}

export function validateCensus(files, required, read) {
  invariant(record(files) && equal(Object.keys(files).sort(), [...required].sort()), "INCOMPLETE_FILE_CENSUS");
  for (const [relative, hash] of Object.entries(files)) {
    invariant(
      !path.posix.isAbsolute(relative) &&
        path.posix.normalize(relative) === relative &&
        !relative.startsWith("../") &&
        !relative.includes("\\") &&
        isHash(hash),
      "FROZEN_PATH_ESCAPE",
    );
    invariant(sha256(read(relative)) === hash, "FILE_DIGEST_MISMATCH");
  }
}

export function validateAuthorityPath(actual, realRepo, temp) {
  invariant(!actual.startsWith(`${realRepo}${path.sep}`) && actual !== realRepo, "EXTERNAL_AUTHORITY_REQUIRED");
  invariant(actual === path.join(temp, "10678-authority", "freeze.json"), "FIXED_EXTERNAL_AUTHORITY_PATH_REQUIRED");
}

export function readAuthority(file, expectedHash, { head, phase, protocol, root = repo }) {
  const realRepo = realpathSync(root);
  const actual = realpathSync(file);
  invariant(path.isAbsolute(file), "EXTERNAL_AUTHORITY_REQUIRED");
  const temp = realpathSync(process.env.RUNNER_TEMP);
  validateAuthorityPath(actual, realRepo, temp);
  const result = decodeAuthority(readFileSync(actual), expectedHash, { head, phase, protocol });
  const template = JSON.parse(readFileSync(path.join(root, supportPath, "inputs.template.json"), "utf8"));
  invariant(equal(result.config.publicInputs, template), "PUBLIC_INPUT_CONSTANTS_CHANGED");
  if (result.config.phase === "measurement") {
    invariant(
      equal(result.config.chart, template.chart) && equal(result.config.images, template.images),
      "CHART_OR_IMAGE_PINS_CHANGED",
    );
    for (const [name, pin] of Object.entries(template.publicExecutables))
      invariant(
        result.config.tools[name]?.path === pin.path && result.config.tools[name]?.sha256 === pin.sha256,
        "PUBLIC_EXECUTABLE_PIN_CHANGED",
      );
  }
  const names = readdirSync(path.join(root, supportPath));
  const required = [...names.map((name) => `${supportPath}/${name}`), ...closurePaths];
  validateCensus(result.config.files, required, (relative) => {
    const target = path.join(root, relative);
    invariant(
      lstatSync(target).isFile() &&
        !lstatSync(target).isSymbolicLink() &&
        realpathSync(target).startsWith(`${realRepo}${path.sep}`),
      "FROZEN_PATH_ESCAPE",
    );
    return readFileSync(target);
  });
  invariant(
    sha256(readFileSync(path.join(root, retainedPath))) === protocol.retainedConfigMapSha256,
    "RETAINED_RAW_HASH_MISMATCH",
  );
  return result;
}

function distribution(pin) {
  invariant(
    record(pin) &&
      typeof pin.version === "string" &&
      pin.version.length > 0 &&
      typeof pin.architecture === "string" &&
      pin.architecture.length > 0 &&
      /^https:\/\/[^\s?]+$/.test(pin.publicReference) &&
      isHash(pin.archiveSha256),
    "REVIEWED_DISTRIBUTION_REQUIRED",
  );
}

export function validateMeasurementPins(config) {
  for (const field of ["bootstrapIdentity", "expectedIdentity", "inventoryAuthority", "bootstrapTools", "daemonTools"])
    invariant(record(config[field]), "MEASUREMENT_PINS_REQUIRED");
  for (const identity of [config.bootstrapIdentity, config.expectedIdentity]) {
    invariant(
      typeof identity.imageVersion === "string" &&
        /^\d{8}\.\d+\.\d+$/.test(identity.imageVersion) &&
        identity.imageOS === "ubuntu24" &&
        identity.architecture === "x64" &&
        typeof identity.kernel === "string" &&
        identity.kernel.length > 0 &&
        identity.kernel !== "UNKNOWN",
      "RUNNER_OS_PINS_REQUIRED",
    );
    invariant(
      ["identitySha256", "osReleaseSha256", "toolsSha256", "versionsSha256", "daemonSha256"].every((k) =>
        isHash(identity[k]),
      ),
      "OS_DAEMON_TOOL_FINGERPRINTS_REQUIRED",
    );
  }
  exactKeys(config.bootstrapTools, ["node"], "BOOTSTRAP_NODE_OVERRIDE_REQUIRED");
  for (const name of stockTools) validateToolPin(bootstrapTools(config)[name]);
  for (const name of ["docker", "containerd"]) validateToolPin(config.daemonTools[name]);
  for (const name of measurementTools) validateToolPin(config.tools?.[name]);
  const a = config.inventoryAuthority;
  invariant(
    ["run", "attempt", "job", "artifactId"].every((k) => /^\d+$/.test(a[k])) &&
      ["artifactSha256", "receiptSha256", "envelopeSha256"].every((k) => isHash(a[k])) &&
      isRef(a.head),
    "INVENTORY_CUSTODY_REQUIRED",
  );
}

export function validateToolPin(pin) {
  invariant(
    record(pin) &&
      typeof pin.path === "string" &&
      path.posix.isAbsolute(pin.path) &&
      path.posix.isAbsolute(pin.realTarget ?? "") &&
      isHash(pin.sha256),
    "REAL_TOOL_PIN_REQUIRED",
  );
  distribution(pin.distribution);
  invariant(["native", "script"].includes(pin.format), "EXECUTABLE_FORMAT_REQUIRED");
  if (pin.path !== pin.realTarget)
    invariant(
      pin.format === "native" && pin.invocation === path.posix.basename(pin.path) && pin.multicall === true,
      "AUTHENTICATED_INVOCATION_REQUIRED",
    );
  if (pin.format === "script")
    invariant(
      pin.interpreter?.tool === "node" &&
        pin.interpreter.shebang === "#!/usr/bin/env node" &&
        record(pin.closure) &&
        Object.keys(pin.closure).length > 1 &&
        Object.values(pin.closure).every(isHash) &&
        path.posix.isAbsolute(pin.distributionRoot ?? ""),
      "SCRIPT_INTERPRETER_CLOSURE_REQUIRED",
    );
}

export function validateToolObservation(pin, actual) {
  validateToolPin(pin);
  invariant(
    actual.path === pin.path &&
      actual.realTarget === pin.realTarget &&
      actual.sha256 === pin.sha256 &&
      actual.format === pin.format,
    "EXECUTABLE_DRIFT_OR_SHIM",
  );
  invariant(equal(actual.package, pin.package), "TOOL_PACKAGE_DRIFT");
  if (pin.format === "script")
    invariant(
      actual.shebang === pin.interpreter.shebang && equal(actual.closure, pin.closure),
      "INTERPRETER_OR_DISTRIBUTION_DRIFT",
    );
}

export function compareIdentity(expected, actual) {
  invariant(equal(expected, identityFingerprint(actual)), "RUNNER_OS_DAEMON_OR_TOOL_DRIFT");
}

export const bootstrapTools = (config) => ({ ...config.tools, ...config.bootstrapTools });

export function identityFingerprint(actual) {
  return {
    imageVersion: actual.imageVersion,
    imageOS: actual.imageOS,
    architecture: actual.architecture,
    kernel: actual.kernel,
    osReleaseSha256: sha256(canonical(actual.osRelease)),
    toolsSha256: sha256(canonical(actual.tools)),
    versionsSha256: sha256(canonical(actual.versions)),
    daemonSha256: sha256(canonical(actual.daemon)),
    identitySha256: sha256(canonical(actual)),
  };
}

export function compareConfigMaps(documents, local) {
  invariant(Array.isArray(documents) && documents.length === 1, "ONE_RETAINED_DOCUMENT_REQUIRED");
  const retained = documents[0];
  invariant(
    retained?.apiVersion === "v1" &&
      retained.kind === "ConfigMap" &&
      retained.metadata?.name === "ingress-nginx-controller" &&
      retained.metadata?.namespace === "ingress-nginx" &&
      record(retained.data) &&
      Object.values(retained.data).every((v) => typeof v === "string"),
    "EXACT_RETAINED_CONFIGMAP_REQUIRED",
  );
  invariant(
    record(local) && local["error-log-path"] === "/dev/stderr" && local["error-log-level"] === "info",
    "APPROVED_LOCAL_LOGGING_REQUIRED",
  );
  const normalized = { ...local, "error-log-path": "/dev/null" };
  delete normalized["error-log-level"];
  invariant(equal(normalized, retained.data), "RETAINED_CONFIGMAP_MISMATCH");
}

export function validateInventoryPublication(receipt, gate) {
  invariant(
    receipt?.schema === "10678-inventory-receipt/v1" &&
      receipt.phase === "inventory" &&
      receipt.measurementDisposition === "NOT_EXECUTED" &&
      receipt.rowCount === 0 &&
      Array.isArray(receipt.rows) &&
      receipt.rows.length === 0 &&
      receipt.complete === true &&
      !Object.hasOwn(receipt, "protocolStart") &&
      !Object.hasOwn(receipt, "armed") &&
      equal(receipt.phases, ["inventoryStart", "inventoryComplete"]),
    "ZERO_ROW_INVENTORY_REQUIRED",
  );
  invariant(
    gate?.schema === "10678-inventory-publication/v1" &&
      gate.phase === "inventory" &&
      gate.publish === true &&
      gate.complete === true &&
      gate.scan === "NO_HITS" &&
      equal(gate.hits, []),
    "PRIVATE_INVENTORY_PUBLICATION_REFUSED",
  );
}

const writeJson = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const cleanEnvironment = (home) => ({
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: home,
  DOCKER_CONFIG: path.join(home, "docker"),
  LANG: "C.UTF-8",
  TZ: "UTC",
});
const resolveTool = (name) => {
  const candidates = cleanEnvironment("")
    .PATH.split(":")
    .map((dir) => path.join(dir, name));
  const found = candidates.find((file) => {
    try {
      return lstatSync(file).isFile() || lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  });
  invariant(found, "STOCK_TOOL_UNAVAILABLE");
  return found;
};

// All subprocess queries below are fixed read-only local metadata queries, never arbitrary caller argv.
export function observeIdentity(directory, pins) {
  mkdirSync(directory, { mode: 0o700 });
  const home = path.join(directory, "empty-home");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(path.join(home, "docker"), { mode: 0o700 });
  let sequence = 0;
  const commands = [];
  const query = (tool, args, allowFailure = false) => {
    const executable = pins?.[tool]?.path ?? resolveTool(tool);
    const startedAt = new Date().toISOString();
    const result = spawnSync(executable, args, {
      env: cleanEnvironment(home),
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    });
    const name = `${String(++sequence).padStart(4, "0")}-${tool}`;
    writeFileSync(path.join(directory, `${name}.stdout`), result.stdout ?? Buffer.alloc(0), {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(path.join(directory, `${name}.stderr`), result.stderr ?? Buffer.alloc(0), {
      flag: "wx",
      mode: 0o600,
    });
    commands.push({
      tool,
      executable,
      args,
      startedAt,
      completedAt: new Date().toISOString(),
      status: result.status,
      signal: result.signal,
      output: `${name}.stdout`,
      error: `${name}.stderr`,
    });
    writeFileSync(path.join(directory, "metadata-command-ledger.json"), `${JSON.stringify(commands, null, 2)}\n`, {
      mode: 0o600,
    });
    invariant(!result.error && !result.signal && Number.isInteger(result.status), "INVENTORY_METADATA_INCOMPLETE");
    invariant(allowFailure || result.status === 0, "INVENTORY_METADATA_QUERY_FAILED");
    return result.status === 0 ? utf8(result.stdout).trimEnd() : null;
  };
  const owningPackage = (file) => {
    const owner = query("dpkg-query", ["-S", file], true);
    if (!owner) return { disposition: "UNOWNED_PUBLIC_DISTRIBUTION_RECONCILIATION_REQUIRED" };
    const owners = owner.split("\n").filter((line) => line.endsWith(`: ${file}`));
    if (owners.length !== 1) return { disposition: "AMBIGUOUS_PACKAGE_OWNER" };
    const name = owners[0].slice(0, -(file.length + 2));
    const version = query("dpkg-query", ["-W", "-f=${Package}\t${Version}\t${Architecture}\n", name]);
    const fields = version.trim().split("\t");
    invariant(fields.length === 3 && fields.every(Boolean), "PACKAGE_IDENTITY_UNAVAILABLE");
    const metadata = query("apt-cache", ["show", `${name}=${fields[1]}`], true);
    const policy = query("apt-cache", ["policy", name], true);
    return {
      name: fields[0],
      version: fields[1],
      architecture: fields[2],
      metadataSha256: metadata === null ? null : sha256(metadata),
      policySha256: policy === null ? null : sha256(policy),
    };
  };
  const executable = (logical, rootProcess = false) => {
    const target = rootProcess ? query("sudo", ["-n", resolveTool("readlink"), "-f", logical]) : realpathSync(logical);
    invariant(target && path.isAbsolute(target), "REAL_TARGET_UNAVAILABLE");
    const hash = rootProcess
      ? query("sudo", ["-n", resolveTool("sha256sum"), target]).split(/\s+/)[0]
      : sha256(readFileSync(target));
    const bytes = readFileSync(target);
    const script = bytes.subarray(0, 2).toString() === "#!";
    return {
      path: rootProcess ? target : logical,
      realTarget: target,
      sha256: hash,
      format: script ? "script" : "native",
      ...(script ? { shebang: bytes.toString("utf8").split("\n")[0] } : {}),
      package: owningPackage(target),
    };
  };
  const tools = Object.fromEntries(
    stockTools.map((name) => [
      name,
      executable(pins?.[name]?.path ?? (name === "node" ? process.execPath : resolveTool(name))),
    ]),
  );
  const versions = {};
  for (const name of stockTools) {
    if (name === "sh") {
      versions.sh = "NO_VERSION_SWITCH_PACKAGE_VERSION_CAPTURED";
      continue;
    }
    const args =
      name === "openssl"
        ? ["version", "-a"]
        : name === "ip"
          ? ["-Version"]
          : name === "containerd-shim-runc-v2"
            ? ["-v"]
            : ["--version"];
    versions[name] = query(name, args);
  }
  const pid = query("systemctl", ["show", "docker", "--property", "MainPID", "--value"]);
  const containerdPid = query("systemctl", ["show", "containerd", "--property", "MainPID", "--value"]);
  invariant(/^[1-9]\d*$/.test(pid) && /^[1-9]\d*$/.test(containerdPid), "ACTIVE_DAEMON_IDENTITY_REQUIRED");
  const unit = query("systemctl", ["show", "docker", "--property=Id,LoadState,FragmentPath,UnitFileState"]);
  const containerdUnit = query("systemctl", [
    "show",
    "containerd",
    "--property=Id,LoadState,FragmentPath,UnitFileState",
  ]);
  const unitFiles = (service) => {
    const fragment = query("systemctl", ["show", service, "--property", "FragmentPath", "--value"]);
    const dropIns = query("systemctl", ["show", service, "--property", "DropInPaths", "--value"]);
    return [fragment, ...dropIns.split(/\s+/).filter(Boolean)].map((file) => {
      invariant(path.isAbsolute(file) && lstatSync(realpathSync(file)).isFile(), "SERVICE_FILE_IDENTITY_UNAVAILABLE");
      return { path: file, realTarget: realpathSync(file), sha256: sha256(readFileSync(file)) };
    });
  };
  const server = JSON.parse(query("docker", ["version", "--format", "{{json .Server}}"]));
  const runtimes = JSON.parse(query("docker", ["info", "--format", "{{json .Runtimes}}"]));
  const defaultRuntime = query("docker", ["info", "--format", "{{.DefaultRuntime}}"]);
  invariant(record(runtimes) && record(runtimes[defaultRuntime]), "ACTIVE_RUNTIME_METADATA_REQUIRED");
  const runtimePath = runtimes[defaultRuntime].path;
  const activeRuntime =
    typeof runtimePath === "string" && runtimePath.length > 0
      ? executable(path.isAbsolute(runtimePath) ? runtimePath : resolveTool(runtimePath))
      : null;
  const daemon = {
    unit,
    containerdUnit,
    server,
    runtimes,
    defaultRuntime,
    activeRuntime,
    unitFiles: unitFiles("docker"),
    containerdUnitFiles: unitFiles("containerd"),
    executable: executable(`/proc/${pid}/exe`, true),
    containerdExecutable: executable(`/proc/${containerdPid}/exe`, true),
    containerdVersion: query("containerd", ["--version"]),
    runcVersion: query("runc", ["--version"]),
  };
  writeJson(path.join(directory, "observed-process-identities.json"), {
    dockerMainPID: pid,
    containerdMainPID: containerdPid,
  });
  const identity = {
    imageVersion: process.env.ImageVersion ?? "UNKNOWN",
    imageOS: process.env.ImageOS ?? "UNKNOWN",
    architecture: os.arch(),
    kernel: os.release(),
    osRelease: readFileSync("/etc/os-release", "utf8"),
    tools,
    versions,
    daemon,
  };
  writeJson(path.join(directory, "observed-identity.json"), identity);
  return identity;
}

function distributionFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(root, entry.name);
      invariant(!entry.isSymbolicLink(), "SCRIPT_DISTRIBUTION_SYMLINK_REFUSED");
      return entry.isDirectory() ? distributionFiles(file) : [file];
    });
}

export function enforceExecutables(tools, names = measurementTools, verifyPathNode = true) {
  for (const name of names) {
    const pin = tools?.[name];
    validateToolPin(pin);
    if (stockTools.includes(name) && name !== "node")
      invariant(resolveTool(name) === pin.path, "STOCK_INVOCATION_PATH_DRIFT");
    const target = realpathSync(pin.path);
    const bytes = readFileSync(target);
    const script = bytes.subarray(0, 2).toString() === "#!";
    invariant(
      script || bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
      "NATIVE_EXECUTABLE_OR_REVIEWED_SCRIPT_REQUIRED",
    );
    const actual = {
      path: pin.path,
      realTarget: target,
      sha256: sha256(bytes),
      format: script ? "script" : "native",
      package: pin.package,
    };
    if (script) {
      actual.shebang = bytes.toString("utf8").split("\n")[0];
      const root = realpathSync(pin.distributionRoot);
      invariant(target.startsWith(`${root}/`), "SCRIPT_DISTRIBUTION_ESCAPE");
      actual.closure = Object.fromEntries(
        distributionFiles(root).map((file) => [path.relative(root, file), sha256(readFileSync(file))]),
      );
    }
    validateToolObservation(pin, actual);
  }
  const pathNode = ["/usr/local/bin/node", "/usr/bin/node", "/bin/node"].find((file) => {
    try {
      realpathSync(file);
      return true;
    } catch {
      return false;
    }
  });
  invariant(
    realpathSync(process.execPath) === tools.node.realTarget &&
      (!verifyPathNode || realpathSync(pathNode) === tools.node.realTarget),
    "TOOL_INTERPRETER_MISMATCH",
  );
}

export function enforceIdentityPins(config, actual, bootstrap = false) {
  compareIdentity(bootstrap ? config.bootstrapIdentity : config.expectedIdentity, actual);
  const tools = bootstrap ? bootstrapTools(config) : config.tools;
  for (const name of stockTools) validateToolObservation(tools[name], actual.tools[name]);
  validateToolObservation(config.daemonTools.docker, actual.daemon.executable);
  validateToolObservation(config.daemonTools.containerd, actual.daemon.containerdExecutable);
  invariant(actual.daemon.defaultRuntime === "runc" && actual.daemon.activeRuntime, "ACTIVE_RUNC_IDENTITY_REQUIRED");
  validateToolObservation(tools.runc, actual.daemon.activeRuntime);
}

export function invocation(tools, name, args) {
  const pin = tools[name];
  validateToolPin(pin);
  return pin.format === "script"
    ? { executable: tools.node.path, args: [pin.path, ...args] }
    : { executable: pin.path, args };
}

export function preserveAuthority(directory, authority, raw) {
  for (const [file, bytes] of [
    ["authority-envelope.json", raw],
    ["authority-payload.json", authority.payloadBytes],
    ["authority-review.txt", authority.reviewBytes],
    ["authority-subject.json", authority.subjectBytes],
    ["authority-dispatch.json", authority.dispatchBytes],
    ["authority-completion.json", authority.completionBytes],
  ])
    writeFileSync(path.join(directory, file), bytes, { flag: "wx", mode: 0o600 });
}

export function preserveMetadata(directory, capture, prefix = "") {
  invariant(/^[a-z-]*$/.test(prefix), "INVALID_METADATA_PREFIX");
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    invariant(!lstatSync(file).isSymbolicLink(), "METADATA_SYMLINK_REFUSED");
    if (lstatSync(file).isFile())
      writeFileSync(path.join(capture, `${prefix}${name}`), readFileSync(file), { flag: "wx", mode: 0o600 });
  }
}

export function hostedContext(protocol) {
  invariant(
    process.platform === "linux" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.env.GITHUB_JOB === protocol.job &&
      process.env.GITHUB_EVENT_NAME === "pull_request" &&
      process.getuid() !== 0,
    "HOSTED_INVENTORY_ONLY",
  );
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  invariant(
    event.repository?.full_name === "chase-sets/chase-sets" &&
      event.pull_request?.draft === true &&
      event.pull_request.head.repo.full_name === "chase-sets/chase-sets" &&
      event.pull_request.head.ref === protocol.branch &&
      isRef(event.pull_request.head.sha) &&
      isRef(event.pull_request.base.sha),
    "EVENT_NOT_ADMITTED",
  );
  invariant(
    /^\d+$/.test(process.env.GITHUB_RUN_ID) && /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT),
    "INVALID_RUN_IDENTITY",
  );
  return event;
}

async function collect() {
  invariant(process.argv.length === 3, "CLOSED_INVENTORY_ARGV_REQUIRED");
  const protocol = JSON.parse(readFileSync(path.join(here, "protocol.json"), "utf8"));
  const event = hostedContext(protocol);
  const authority = readAuthority(process.argv[2], process.env.DIAGNOSTIC_FREEZE_SHA256, {
    head: event.pull_request.head.sha,
    phase: "inventory",
    protocol,
  });
  const run = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  const root = path.join(realpathSync(process.env.RUNNER_TEMP), "10678-inventory", `${run}-${attempt}`);
  mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
  mkdirSync(root, { mode: 0o700 });
  const capture = path.join(root, "inventory");
  mkdirSync(capture, { mode: 0o700 });
  const startedAt = new Date().toISOString();
  const disk = spawnSync(resolveTool("git"), ["rev-parse", "HEAD"], {
    env: cleanEnvironment(path.join(root, "private", "empty-home")),
    encoding: "utf8",
    shell: false,
  });
  invariant(disk.status === 0 && disk.stdout.trim() === authority.config.head, "DISK_HEAD_MISMATCH");
  const identity = observeIdentity(path.join(root, "private"));
  // Raw metadata stays flat in this exact upload directory; empty credential homes never do.
  preserveMetadata(path.join(root, "private"), capture);
  preserveAuthority(capture, authority, readFileSync(process.argv[2]));
  const receipt = {
    schema: "10678-inventory-receipt/v1",
    phase: "inventory",
    measurementDisposition: "NOT_EXECUTED",
    rowCount: 0,
    rows: [],
    complete: true,
    phases: ["inventoryStart", "inventoryComplete"],
    startedAt,
    completedAt: new Date().toISOString(),
    run,
    attempt,
    jobIdentity: {
      key: protocol.job,
      numericId: "PENDING_HOST_ATTEMPT_SPECIFIC_JOB_AUTHORITY",
      steps: "PENDING_HOST_COMPLETE_JOB_STEP_AND_SETUP_IMAGE_LOG_CUSTODY",
    },
    head: authority.config.head,
    base: event.pull_request.base.sha,
    merge: process.env.GITHUB_SHA,
    authority: authority.identity,
    identitySha256: sha256(Buffer.from(canonical(identity))),
    setupJob: {
      imageVersion: identity.imageVersion,
      release: `https://github.com/actions/runner-images/releases/tag/ubuntu24%2F${identity.imageVersion}`,
      authority: "PENDING_HOST_SETUP_JOB_LOG_RECONCILIATION",
    },
    disposal: "PENDING_HOST_RUNNER_COMPLETION",
  };
  writeJson(path.join(capture, "preparation-receipt.json"), receipt);
  const files = readdirSync(capture)
    .sort()
    .map((file) => {
      const bytes = readFileSync(path.join(capture, file));
      return { file, bytes: bytes.length, sha256: sha256(bytes), text: utf8(bytes) };
    });
  const hits = scanExposure(files);
  writeJson(path.join(capture, "inventory-manifest.json"), {
    schema: "10678-inventory-manifest/v1",
    phase: "inventory",
    run,
    attempt,
    files: files.map(({ text: _text, ...entry }) => entry),
    receiptSha256: sha256(readFileSync(path.join(capture, "preparation-receipt.json"))),
  });
  const gate = {
    schema: "10678-inventory-publication/v1",
    phase: "inventory",
    complete: true,
    publish: hits.length === 0,
    scan: hits.length ? "HITS" : "NO_HITS",
    hits,
    manifestSha256: sha256(readFileSync(path.join(capture, "inventory-manifest.json"))),
  };
  writeJson(path.join(capture, "inventory-publication-gate.json"), gate);
  validateInventoryPublication(receipt, gate);
  console.log("INVENTORY_CAPTURE_COMPLETE_MEASUREMENT_NOT_EXECUTED");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await collect();
  } catch {
    console.log("INVENTORY_REFUSED_MEASUREMENT_NOT_EXECUTED");
    process.exitCode = 1;
  }
}
