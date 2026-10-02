import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const suite = "tcgplayer_operator_extension";
const extensionId = "ghemdloifdkoadnapmigabiekchlholm";
const cookieMarker = Buffer.from(["SYNTHETIC", "OPERATOR", "COOKIE", "CHROMIUM"].join("_"));
const grantMarker = Buffer.from("A".repeat(43));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const closed = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const requireSafe = (condition) => {
  if (!condition) throw new Error("Operator evidence refused");
};

export function operatorEvidenceIdentity(root, env = process.env) {
  const checkoutHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const identity = {
    sourceHead: env.OPERATOR_EVIDENCE_SOURCE_HEAD || checkoutHead,
    checkoutHead,
    runId: env.GITHUB_RUN_ID || "local",
    runAttempt: env.GITHUB_RUN_ATTEMPT || "1",
    job: env.GITHUB_JOB || "local",
    jobIndex: env.OPERATOR_EVIDENCE_JOB_INDEX || "0",
    suite,
  };
  validateIdentity(identity);
  requireSafe(!env.CI || (identity.runId !== "local" && !!env.OPERATOR_EVIDENCE_SOURCE_HEAD));
  return identity;
}

function validateIdentity(value) {
  requireSafe(closed(value, ["sourceHead", "checkoutHead", "runId", "runAttempt", "job", "jobIndex", "suite"]));
  requireSafe([value.sourceHead, value.checkoutHead].every((head) => /^[a-f0-9]{40}$/.test(head)));
  requireSafe(/^(local|[1-9][0-9]*)$/.test(value.runId) && /^[1-9][0-9]*$/.test(value.runAttempt));
  requireSafe(/^[a-z][a-z0-9_-]{0,79}$/.test(value.job) && /^(0|[1-9][0-9]*)$/.test(value.jobIndex));
  requireSafe(value.suite === suite);
}

export function scanOperatorPayload(bytes) {
  return { cookieMarkers: bytes.includes(cookieMarker) ? 1 : 0, grantMarkers: bytes.includes(grantMarker) ? 1 : 0 };
}

export function operatorFileInventory(directory) {
  const files = {};
  function visit(folder, prefix = "") {
    for (const name of readdirSync(folder).sort()) {
      requireSafe(/^[a-zA-Z0-9_.-]+$/.test(name));
      const path = join(folder, name);
      const stat = lstatSync(path);
      requireSafe(!stat.isSymbolicLink());
      if (stat.isDirectory()) visit(path, prefix + name + "/");
      else {
        requireSafe(stat.isFile() && stat.size <= 10_000_000);
        files[prefix + name] = hash(readFileSync(path));
      }
    }
  }
  visit(directory);
  return files;
}

function validateFiles(files) {
  requireSafe(files && typeof files === "object" && !Array.isArray(files));
  const entries = Object.entries(files);
  requireSafe(entries.length >= 4 && entries.length <= 100);
  for (const [path, digest] of entries) {
    requireSafe(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.[a-zA-Z0-9.-]+$/.test(path));
    requireSafe(!path.includes("..") && /\.(js|css|html|json|woff|woff2)$/.test(path));
    requireSafe(typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest));
  }
  for (const path of ["manifest.json", "background.js", "popup.html", "sandbox.html"]) requireSafe(path in files);
}

function validateProducer(value, identity) {
  requireSafe(closed(value, ["schemaVersion", "identity", "status", "tests"]));
  requireSafe(value.schemaVersion === 1 && same(value.identity, identity));
  requireSafe(["passed", "failed", "timedout", "interrupted"].includes(value.status));
  requireSafe(Array.isArray(value.tests) && value.tests.length >= 1 && value.tests.length <= 8);
  const seen = new Set();
  for (const item of value.tests) {
    requireSafe(closed(item, ["id", "retry", "status", "durationMs"]));
    requireSafe(["build", "chromium"].includes(item.id));
    requireSafe(Number.isSafeInteger(item.retry) && item.retry >= 0 && item.retry <= 3);
    requireSafe(["passed", "failed", "timedOut", "skipped", "interrupted"].includes(item.status));
    requireSafe(Number.isSafeInteger(item.durationMs) && item.durationMs >= 0);
    const key = `${item.id}:${item.retry}`;
    requireSafe(!seen.has(key));
    seen.add(key);
  }
}

const stages = [
  "launch",
  "launched",
  "worker",
  "setup-connected",
  "cookies-proved",
  "popup-open",
  "paired",
  "isolated",
  "compatible-reloaded",
  "unknown-reloaded",
  "reload-proved",
];

export function prepareOperatorEvidence({ input, output, dist, identity, producerOutcome }) {
  validateIdentity(identity);
  requireSafe(["success", "failure", "cancelled"].includes(producerOutcome));
  requireSafe(!existsSync(output));
  const allowed = new Set(["producer.json", "handoff.json", "chromium-stages.json", "sandbox-status.png"]);
  const retained = operatorFileInventory(input);
  requireSafe(Object.keys(retained).every((path) => allowed.has(path)) && "producer.json" in retained);
  const scans = Object.entries(retained).map(([path, sha256]) => {
    const result = scanOperatorPayload(readFileSync(join(input, path)));
    requireSafe(result.cookieMarkers === 0 && result.grantMarkers === 0);
    return { path, sha256, ...result };
  });
  const producer = JSON.parse(readFileSync(join(input, "producer.json"), "utf8"));
  validateProducer(producer, identity);
  let handoff = null;
  if ("handoff.json" in retained) {
    handoff = JSON.parse(readFileSync(join(input, "handoff.json"), "utf8"));
    requireSafe(
      closed(handoff, ["schemaVersion", "identity", "extensionId", "version", "twoBuildsIdentical", "files"]),
    );
    requireSafe(handoff.schemaVersion === 1 && same(handoff.identity, identity));
    requireSafe(
      handoff.extensionId === extensionId && handoff.version === "0.1.0" && handoff.twoBuildsIdentical === true,
    );
    validateFiles(handoff.files);
    requireSafe(same(handoff.files, operatorFileInventory(dist)));
  }
  let progress = [];
  if ("chromium-stages.json" in retained) {
    const capture = JSON.parse(readFileSync(join(input, "chromium-stages.json"), "utf8"));
    requireSafe(closed(capture, ["identity", "stages"]) && same(capture.identity, identity));
    requireSafe(Array.isArray(capture.stages) && capture.stages.length <= stages.length);
    requireSafe(capture.stages.every((stage, index) => stage === stages[index]));
    progress = capture.stages;
  }
  requireSafe(producerOutcome !== "success" || producer.status === "passed");
  const successful = producerOutcome === "success";
  if (successful) {
    requireSafe(handoff && same(progress, stages));
    requireSafe(
      producer.tests.length === 2 && producer.tests.every((test) => test.status === "passed" && test.retry === 0),
    );
    requireSafe(new Set(producer.tests.map((test) => test.id)).size === 2);
  }
  const summary = {
    schemaVersion: 1,
    identity,
    syntheticOnly: true,
    producerOutcome,
    testStatus: producer.status,
    tests: producer.tests,
    stages: progress,
    reloadProved: same(progress, stages),
    candidateVerified: successful,
    installationAuthority: false,
    retained: scans,
    handoff,
  };
  const bytes = encode(summary);
  const summaryScan = scanOperatorPayload(bytes);
  requireSafe(summaryScan.cookieMarkers === 0 && summaryScan.grantMarkers === 0);
  const scan = encode({
    schemaVersion: 1,
    identity,
    clean: true,
    files: [{ path: "summary.json", sha256: hash(bytes), ...summaryScan }],
  });
  requireSafe(Object.values(scanOperatorPayload(scan)).every((count) => count === 0));
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "summary.json"), bytes);
  writeFileSync(join(output, "scan.json"), scan);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(import.meta.dirname, "..");
    const batch = process.argv[2];
    requireSafe(typeof batch === "string" && batch.split(",").includes(suite));
    prepareOperatorEvidence({
      input: join(root, "artifacts/operator-extension"),
      output: join(root, "artifacts/hosted-operator-extension"),
      dist: join(root, "deployables/tcgplayer-operator-extension/dist"),
      identity: operatorEvidenceIdentity(root),
      producerOutcome: process.env.OPERATOR_EVIDENCE_PRODUCER_OUTCOME,
    });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "publish=true\n");
    console.log("Operator evidence validated; all selected payload marker counts: 0.");
  } catch {
    console.error("Operator evidence refused; no upload authority.");
    process.exitCode = 1;
  }
}
