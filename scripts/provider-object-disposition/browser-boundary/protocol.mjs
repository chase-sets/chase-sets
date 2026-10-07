export const TRANSITION =
  '{"transition":"seed-joined","uidMap":"exact","gidMap":"exact","setgroups":"deny","seed":"reaped"}\n';
export const ADMISSION =
  '{"admitted":true,"nonroot":true,"network":"isolated","hostRejoin":"denied","capabilities":"dropped","nestedSandbox":true,"handles":"closed"}\n';

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
    stage,
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
  return new Error(`browser-mediation-unavailable: ${JSON.stringify(diagnostic)}`);
}
