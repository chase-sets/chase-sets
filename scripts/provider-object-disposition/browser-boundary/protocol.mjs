export const TRANSITION =
  '{"transition":"seed-joined","uidMap":"exact","gidMap":"exact","setgroups":"deny","seed":"reaped"}\n';
export const ADMISSION =
  '{"admitted":true,"nonroot":true,"network":"isolated","hostRejoin":"denied","capabilities":"dropped","nestedSandbox":true,"handles":"closed"}\n';
const diagnostics = new WeakMap();
const stages = new Set([
  "operator-installation-unavailable",
  "linux-required",
  "nonroot-required",
  "installed-boundary",
  "sandboxed-chromium",
]);

const nativeStages = new Set([
  "arguments",
  "source-identity",
  "principal",
  "attachment",
  "executable",
  "ownership",
  "file-capability",
  "path-bound",
  "identity-open",
  "identity-hash",
  "launcher-identity",
  "inventory-identity",
  "inventory",
  "inventory-shape",
  "inventory-path",
  "dependency-identity",
  "inventory-complete",
  "read",
  "read-bound",
  "process-authority",
  "core-files",
  "parent-lifetime",
  "automation-pipes",
  "automation-peer",
  "inherited-handles",
  "host-comparison",
  "namespace-seed",
  "seed-deadline",
  "seed-reap",
  "mapping-write",
  "namespace-identity",
  "user-namespace",
  "mapping-identity",
  "transition-output",
  "child-namespaces",
  "host-rejoin",
  "interfaces",
  "external-interface",
  "loopback",
  "private-mounts",
  "private-tmp",
  "private-shm",
  "private-proc",
  "private-root",
  "private-profile",
  "securebits",
  "bounding-capabilities",
  "capabilities",
  "no-new-privileges",
  "nonroot",
  "automation-pipe-create",
  "guardian-lifetime",
  "init-fork",
  "automation-child-pipes",
  "automation-nonblocking",
  "automation-poll",
  "owned-wait",
  "owned-drain",
  "nested-fork",
  "nested-network-namespace",
  "nested-sandbox",
  "namespace-attachment",
  "browser-fork",
  "closed-stdio",
  "browser-exec",
  "browser-exit",
]);

function bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  return null;
}

export function admissionProof(stdout, stderr) {
  const out = bytes(stdout);
  const err = bytes(stderr);
  return out !== null && err !== null && err.length === 0 && out.equals(Buffer.from(TRANSITION + ADMISSION));
}

export function nativeRefusal(stdout, stderr, status) {
  const out = bytes(stdout);
  const err = bytes(stderr);
  if (status !== 78 || !out || !err || out.length > 4096 || err.length > 4096) return null;
  if (out.length !== 0 && !out.equals(Buffer.from(TRANSITION))) return null;
  const match = /^provider-boundary-refused:([a-z-]+)\n(?:provider-boundary-refused:nested-sandbox\n)?$/.exec(
    err.toString("ascii"),
  );
  if (!match || !err.equals(Buffer.from(match[0])) || !nativeStages.has(match[1])) return null;
  if (match[0].split("\n").length === 3 && out.length === 0) return null;
  return match[1];
}

export function mediationFailure(stage, error, restriction = "unknown") {
  const stdout = bytes(error?.stdout);
  const stderr = bytes(error?.stderr);
  const status = Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255 ? error.code : null;
  const signal = ["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"].includes(error?.signal) ? error.signal : null;
  const truncated = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  const native = truncated || signal ? null : nativeRefusal(stdout, stderr, status);
  // Lengths describe captured bytes, never an inferred length of lost output.
  const diagnostic = {
    stage: stages.has(stage) ? stage : "unknown",
    status,
    signal,
    nativeStage: native,
    stdoutBytes: stdout ? stdout.length : null,
    stderrBytes: stderr ? stderr.length : null,
    redacted: true,
    truncated,
    complete: !truncated && stdout !== null && stderr !== null,
    userNamespaceRestriction: [0, 1].includes(restriction) ? restriction : "unknown",
  };
  const failure = new Error(`browser-mediation-unavailable: ${JSON.stringify(diagnostic)}`);
  diagnostics.set(failure, Object.freeze(diagnostic));
  return failure;
}

export function mediationDiagnostic(error) {
  return diagnostics.get(error) ?? null;
}

export function browserCapabilityProof(record) {
  const zero = "0000000000000000";
  const sysAdmin = "0000000000200000";
  const nestedBounding = "000001ffffffffff";
  if (record.NoNewPrivs !== "1" || record.CapInh !== zero || record.CapAmb !== zero) return false;
  if (record.userNamespace === "launch") {
    return record.CapEff === zero && record.CapPrm === zero && record.CapBnd === zero;
  }
  // Chromium's namespace sandbox recreates a bounding set in its nested user
  // namespace; its zygote retains only namespace-scoped CAP_SYS_ADMIN. The
  // observer proves ancestry to this launch, not merely a non-host inode.
  return (
    record.userNamespace === "nested" &&
    record.image === "chrome" &&
    record.rootObservation === "private-proc-fdinfo" &&
    [zero, sysAdmin].includes(record.CapEff) &&
    record.CapPrm === record.CapEff &&
    [zero, nestedBounding].includes(record.CapBnd) &&
    (record.CapEff === zero || record.CapBnd === nestedBounding)
  );
}

export function liveRemovalRefusal(error) {
  const stdout = bytes(error?.stdout);
  const stderr = bytes(error?.stderr);
  return (
    error?.code === 1 &&
    !error?.signal &&
    stdout !== null &&
    stderr !== null &&
    stdout.equals(
      Buffer.from(
        "provider-boundary-cleanup-stage:remove-installation\n" +
          "provider-boundary-installer-stage:source-location\n" +
          "provider-boundary-installer-stage:remove-ownership\n",
      ),
    ) &&
    stderr.equals(
      Buffer.from(
        "provider-boundary-installer-refused:remove-live-owner\n" +
          "provider-boundary-cleanup-refused:remove-installation\n",
      ),
    )
  );
}

export function observerDiagnostic(error) {
  const stdout = bytes(error?.stdout);
  const stderr = bytes(error?.stderr);
  const allowed = [
    "arguments",
    "census",
    "descendants",
    "status",
    "status-field",
    "label",
    "namespaces",
    "user-namespace",
    "root",
  ];
  let stage =
    error?.code === 1 && !error?.signal && stdout?.length === 0 && stderr
      ? (allowed.find((name) => stderr.equals(Buffer.from(`provider-boundary-observer-refused:${name}\n`))) ??
        "unknown")
      : "unknown";
  let root = null;
  if (error?.code === 1 && !error?.signal && stdout?.length === 0 && stderr && stderr.length <= 512) {
    const match =
      /^provider-boundary-observer-refused:root\nprovider-boundary-observer-root:(0|[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,15}):(launcher|chrome|chrome_crashpad_handler):(host-helper|old-root):(EACCES|EPERM|ENOENT|ESRCH|ENOTDIR|ELOOP|EIO|other):(same|changed|zombie|unknown):(proc-fdinfo|other|unreadable):(directory|other|unreadable):(none|EACCES|EPERM|ENOENT|ESRCH|ENOTDIR|ELOOP|EIO|other)\n$/.exec(
        stderr.toString("ascii"),
      );
    if (
      match &&
      stderr.equals(Buffer.from(match[0])) &&
      match.slice(1, 6).every((v) => Number.isSafeInteger(Number(v)))
    ) {
      stage = "root";
      root = {
        pid: Number(match[1]),
        parent: Number(match[2]),
        start: Number(match[3]),
        imageDevice: Number(match[4]),
        imageInode: Number(match[5]),
        image: match[6],
        pathKind: match[7],
        errno: match[8],
        identityRecheck: match[9],
        rootLink: match[10],
        rootKind: match[11],
        rootErrno: match[12],
      };
    }
  }
  return {
    stage,
    root,
    status: Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255 ? error.code : null,
    signal: ["SIGTERM", "SIGKILL"].includes(error?.signal) ? error.signal : null,
    capturedBytes: stderr?.length ?? null,
    stdoutBytes: stdout?.length ?? null,
    redacted: true,
    truncated: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  };
}
