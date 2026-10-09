import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(source, "../../../../../..");
const core = ["capture.html", "helper.js", "manifest.json", "worker.js"];
const packageFiles = ["capture-config.json", ...core].sort();
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
function readCanonical(file) {
  const text = readFileSync(file, "utf8");
  const value = JSON.parse(text);
  if (json(value) !== text) fail("closed_schema");
  return value;
}
const fail = (code) => {
  throw new Error(code);
};
const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (value, names) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...names].sort().join()
  )
    fail("closed_schema");
};
const number = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) fail("closed_schema");
};
const boolean = (value) => {
  if (typeof value !== "boolean") fail("closed_schema");
};
const oneOf = (value, values) => {
  if (!values.includes(value)) fail("closed_schema");
};
const id = (key) =>
  hash(Buffer.from(key, "base64"))
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + Number.parseInt(c, 16)));
function real(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || path.resolve(directory) !== directory)
    fail("absolute_directory");
  for (let current = directory; ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail("symlink");
    if (current === path.dirname(current)) break;
  }
}
function inventory(directory) {
  real(directory);
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => {
        const file = path.join(directory, name);
        if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) fail("inventory");
        return [name, hash(readFileSync(file))];
      }),
  );
}

export function prepare({ out, synthetic = false, t0 = Date.now() }) {
  real(out);
  number(t0);
  if (existsSync(out)) fail("new_directory_required");
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (
    !synthetic &&
    (process.platform !== "win32" ||
      path.dirname(out) !== path.join(repo, "artifacts", "9142") ||
      git("status", "--porcelain") ||
      !existsSync(chrome) ||
      Math.abs(Date.now() - t0) > 1000)
  )
    fail("reviewed_seat_required");
  const head = git("rev-parse", "HEAD");
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const manifest = {
    ...read(path.join(source, "manifest.json")),
    key: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
  for (const name of ["package", "receipt", "profile"]) mkdirSync(path.join(out, name), { recursive: true });
  const directory = path.join(out, "package");
  for (const name of core)
    writeFileSync(
      path.join(directory, name),
      name === "manifest.json" ? json(manifest) : readFileSync(path.join(source, name)),
      { flag: "wx" },
    );
  const config = {
    format: "detection-pagination-package/v1",
    head,
    extensionId: id(manifest.key),
    evidence: synthetic ? "synthetic" : "operator",
    t0,
    files: inventory(directory),
  };
  writeFileSync(path.join(directory, "capture-config.json"), json(config), { flag: "wx" });
  const preparation = {
    format: "detection-pagination-preparation/v1",
    ...config,
    packageDigests: inventory(directory),
    packageDirectory: directory,
    receiptDirectory: path.join(out, "receipt"),
    profileDirectory: path.join(out, "profile"),
    captureUrl: `chrome-extension://${config.extensionId}/capture.html`,
    launchCommand: `& '${chrome}' '--user-data-dir=${path.join(out, "profile")}' '--no-first-run' '--no-default-browser-check'`,
  };
  writeFileSync(path.join(out, "preparation.json"), json(preparation), { flag: "wx" });
  const cli = path.join(source, "package.mjs");
  const runbook = `# Private #9142 window, not #9115 authorization

Evidence: ${config.evidence}; landed head: ${head}; extension: ${config.extensionId}.
T0: ${new Date(t0).toISOString()}; fixed deadline: ${new Date(t0 + 900000).toISOString()}.
Prepared -> begun -> collecting -> qualified/unknown/canceled/expired -> removed/disposed.
Synthetic controls prove software only. Live provider authority and independent acceptance are host-owned.
Prepare/install/open/reload dispatch zero provider calls. One durable begin, no renewals, retries, fallback or second session.
This helper does not discover undocumented protocols: current native evidence supports lookup plus the observed first-page shape only.
Live detection/all-eligible range/stable next/hard caps remain discovery_unknown; no cursor/enum/endpoint is invented or relayed.
LastTwoYears is an observed restriction, NOT all-eligible authority. Size 8 is a byte-safe requested chunk, NOT a population cap.
Total <=8 cannot qualify first/next. A full page requires continuation; an unread tail is unknown.
No production engine, product authority, #9115 extension, permission expansion or provider writes are delivered.

Before T0 the host independently reviews exact landed SHA/digests and controls, rehearses unauthenticated removal,
and observes #9115/#8838 profiles absent; never overlap those lifecycles. Do not relay before landing/review.
Host prepares immediately before launch with no credentials/IDs/cursors in commands; T0 is fixed by preparation before first profile launch.
Host verifies: node "${cli}" --verify --out "${out}"
Launch only this fresh isolated profile: ${preparation.launchCommand}
Human signs in privately. No automated login/shared profile/cookie import, agent provider-page DOM/accessibility/screenshots,
clipboard retention, raw console/network recording, HAR, credential export or manufactured status changes.
The +15 minutes includes sign-in, native confirms, reads and HUMAN Chrome UI removal/absence; leave time for removal.
Directory disposal/zero-process evidence may finish later but custody remains pending until all are observed.
Set Downloads to ${preparation.receiptDirectory}; allow only the two fixed-name exports.
At chrome://extensions load unpacked ${directory}; confirm exact extension ID ${config.extensionId}.
Open ${preparation.captureUrl}; invoke only await detectionPaginationCapture.run() without arguments.
Native confirms contain no identifiers. Decline on session/disclosure/custody loss. Stop via await detectionPaginationCapture.abort().
Pagehide aborts; reload/worker restart refuses. Day-after: zero calls and repeat refusal. Never reinstall to retry.
Bounds: <=1 lookup, <=8 detection/page reads, zero details/writes, serial >=30 s gap, timeout 30 s through complete body;
request 8192, lookup 65536, page 1048576, session 8388608, each export 65536 bytes.
Every read separately records <=10000 ms FINAL-call classification; a slower probe read is not qualified for production envelope.
Keep exactly 9142-receipt.json and 9142-inventory.json in ${preparation.receiptDirectory}.
Validate: node "${cli}" --verify-export --out "${out}"
No partial/truncated success. Missing opportunity/native frontier/older entry/churn/range/caps remains unknown; never retry for agreement.
At chrome://extensions remove ${config.extensionId} and observe absence before the deadline. Closing the inspector is NOT removal.
Close only this profile; host disposes only the checked absolute ${preparation.profileDirectory} after observing zero exact-profile processes.
Host attests observed extension absence, profile disposal and zero exact-profile processes:
Record the observed UI absence timestamp privately as UTC epoch milliseconds (not the later disposal time).
node "${cli}" --record-removal --extension-absent --processes-absent --removed-at <observed-UTC-epoch-ms> --out "${out}"
Host posts only independently reviewed scrubbed per-fact verdict/chronology/digests/cleanup, never raw payloads.
Helper landing/ready/receipt presence never closes #9142 or releases #8612/#9144.
Unknown/incompatible: keep #9142 open until an independent decision issue natively blocks BOTH #8612 and #9144.
Full enumeration, if proposed, is labelled with read/byte/time costs and returns to an independent decision, never a cheap negative claim.
`;
  writeFileSync(path.join(out, "RUNBOOK.md"), runbook, { flag: "wx" });
  writeFileSync(
    path.join(out, "preparation-inventory.json"),
    json({
      files: {
        "RUNBOOK.md": hash(runbook),
        "preparation.json": hash(json(preparation)),
        ...Object.fromEntries(
          Object.entries(preparation.packageDigests).map(([name, digest]) => [`package/${name}`, digest]),
        ),
      },
    }),
    { flag: "wx" },
  );
  return preparation;
}

export function verifyPackage(out) {
  real(out);
  const expected = ["RUNBOOK.md", "package", "preparation-inventory.json", "preparation.json", "receipt"];
  if (existsSync(path.join(out, "profile"))) expected.push("profile");
  if (readdirSync(out).sort().join() !== expected.sort().join()) fail("inventory");
  for (const name of expected) if (lstatSync(path.join(out, name)).isSymbolicLink()) fail("symlink");
  const preparation = read(path.join(out, "preparation.json"));
  const actual = inventory(path.join(out, "package"));
  if (Object.keys(actual).join() !== packageFiles.join() || !same(actual, preparation.packageDigests)) fail("digests");
  const config = read(path.join(out, "package", "capture-config.json"));
  keys(config, ["format", "head", "extensionId", "evidence", "t0", "files"]);
  if (config.format !== "detection-pagination-package/v1" || !/^[a-f0-9]{40}$/.test(config.head)) fail("closed_schema");
  number(config.t0);
  oneOf(config.evidence, ["synthetic", "operator"]);
  keys(config.files, core);
  const manifest = read(path.join(out, "package", "manifest.json"));
  if (
    id(manifest.key) !== config.extensionId ||
    !same(config.files, Object.fromEntries(Object.entries(actual).filter(([name]) => name !== "capture-config.json")))
  )
    fail("digests");
  const { key, ...baseManifest } = manifest;
  if (!same(baseManifest, read(path.join(source, "manifest.json")))) fail("manifest");
  const expectedPreparation = {
    format: "detection-pagination-preparation/v1",
    ...config,
    packageDigests: actual,
    packageDirectory: path.join(out, "package"),
    receiptDirectory: path.join(out, "receipt"),
    profileDirectory: path.join(out, "profile"),
    captureUrl: `chrome-extension://${config.extensionId}/capture.html`,
    launchCommand: `& 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' '--user-data-dir=${path.join(out, "profile")}' '--no-first-run' '--no-default-browser-check'`,
  };
  if (!same(preparation, expectedPreparation)) fail("closed_schema");
  const files = {
    "RUNBOOK.md": hash(readFileSync(path.join(out, "RUNBOOK.md"))),
    "preparation.json": hash(readFileSync(path.join(out, "preparation.json"))),
    ...Object.fromEntries(Object.entries(actual).map(([name, digest]) => [`package/${name}`, digest])),
  };
  if (!same(read(path.join(out, "preparation-inventory.json")), { files })) fail("digests");
  if (
    config.evidence === "operator" &&
    (git("rev-parse", "HEAD") !== config.head ||
      git("status", "--porcelain") ||
      core.some(
        (name) => name !== "manifest.json" && hash(readFileSync(path.join(source, name))) !== config.files[name],
      ))
  )
    fail("reviewed_seat_required");
  return preparation;
}

const reasons = [
  "canceled",
  "aborted",
  "expired",
  "custody_loss",
  "session_loss",
  "request_cap",
  "request_bytes",
  "response_bytes",
  "session_bytes",
  "timeout",
  "redirect",
  "http_status",
  "invalid_body",
  "transport",
  "size_mismatch",
  "discovery_unknown",
  "offset_unknown",
  "range_unknown",
  "frontier_unknown",
  "frontier_expired",
  "frontier_replaced",
  "total_missing",
  "count_mismatch",
  "duplicate",
  "tail_missing",
  "unsafe_next",
  "cap_hit",
  "qualified",
  "invalid_message",
];
function assertReceipt(value, p) {
  keys(value, [
    "format",
    "evidence",
    "head",
    "extensionId",
    "digests",
    "t0",
    "deadline",
    "finishedAt",
    "state",
    "reason",
    "requestedSize",
    "counts",
    "totalBytes",
    "requests",
    "pages",
    "facts",
    "distinctCount",
    "total",
    "custody",
  ]);
  if (
    value.format !== "detection-pagination-receipt/v1" ||
    value.evidence !== p.evidence ||
    value.head !== p.head ||
    value.extensionId !== p.extensionId ||
    !same(value.digests, p.files) ||
    value.t0 !== p.t0 ||
    value.deadline !== p.t0 + 900000 ||
    value.requestedSize !== 8 ||
    value.custody !== "pending-removal"
  )
    fail("closed_schema");
  for (const field of ["finishedAt", "totalBytes", "distinctCount"]) number(value[field]);
  if (
    value.finishedAt < p.t0 ||
    (value.finishedAt > value.deadline && value.state !== "expired") ||
    value.totalBytes > 8388608 + 1048576
  )
    fail("chronology");
  if (value.total !== null) number(value.total);
  oneOf(value.state, ["qualified", "unknown", "canceled", "expired"]);
  oneOf(value.reason, reasons);
  if (
    value.state !==
    (value.reason === "expired"
      ? "expired"
      : ["canceled", "aborted"].includes(value.reason)
        ? "canceled"
        : value.reason === "qualified"
          ? "qualified"
          : "unknown")
  )
    fail("verdict");
  keys(value.counts, ["lookup", "page", "detail", "write"]);
  for (const field of Object.keys(value.counts)) number(value.counts[field]);
  if (value.counts.lookup > 1 || value.counts.page > 8 || value.counts.detail || value.counts.write) fail("bounds");
  if (
    !Array.isArray(value.requests) ||
    value.requests.length > 9 ||
    !Array.isArray(value.pages) ||
    value.pages.length > 8
  )
    fail("bounds");
  let bytes = 0;
  const counts = { lookup: 0, page: 0 };
  let previous;
  for (const [index, request] of value.requests.entries()) {
    keys(request, [
      "kind",
      "ordinal",
      "startedAt",
      "elapsedMs",
      "withinFinalCall",
      "requestBytes",
      "responseBytes",
      "responseComplete",
      "status",
      "failure",
    ]);
    oneOf(request.kind, ["lookup", "page"]);
    for (const field of ["ordinal", "startedAt", "elapsedMs", "requestBytes", "responseBytes"]) number(request[field]);
    boolean(request.withinFinalCall);
    boolean(request.responseComplete);
    if (request.status !== null) {
      number(request.status);
      if (request.status > 599) fail("closed_schema");
    }
    if (request.failure !== null) oneOf(request.failure, reasons);
    if (
      request.ordinal !== index ||
      request.requestBytes > 8192 ||
      request.withinFinalCall !== request.elapsedMs <= 10000 ||
      request.startedAt < value.t0 ||
      request.startedAt + request.elapsedMs > value.finishedAt ||
      (previous !== undefined && request.startedAt - previous < 30000) ||
      (request.kind === "lookup" && index !== 0) ||
      (request.failure === null && request.elapsedMs > 30000)
    )
      fail("chronology");
    if (
      request.failure === null &&
      (!request.responseComplete ||
        request.status !== 200 ||
        request.responseBytes > (request.kind === "lookup" ? 65536 : 1048576))
    )
      fail("bounds");
    previous = request.startedAt;
    counts[request.kind] += 1;
    bytes += request.requestBytes + request.responseBytes;
  }
  if (bytes !== value.totalBytes || counts.lookup !== value.counts.lookup || counts.page !== value.counts.page)
    fail("bounds");
  let rows = 0;
  for (const [index, page] of value.pages.entries()) {
    keys(page, [
      "ordinal",
      "requestedSize",
      "effectiveSize",
      "rowCount",
      "distinctCount",
      "total",
      "snapshotCount",
      "snapshotPresent",
      "snapshotEqual",
      "cursorPresent",
      "cursorAdvance",
      "sameSession",
      "allEligible",
      "hardResultCap",
      "hardPageCap",
      "stable",
      "negativeCovered",
      "terminal",
    ]);
    for (const field of ["ordinal", "requestedSize", "rowCount", "distinctCount"]) number(page[field]);
    for (const field of ["effectiveSize", "total", "snapshotCount", "hardResultCap", "hardPageCap"])
      if (page[field] !== null) number(page[field]);
    for (const field of [
      "snapshotPresent",
      "snapshotEqual",
      "cursorPresent",
      "cursorAdvance",
      "sameSession",
      "allEligible",
      "stable",
      "negativeCovered",
      "terminal",
    ])
      boolean(page[field]);
    if (page.ordinal !== index || page.requestedSize !== 8 || page.distinctCount > page.rowCount) fail("closed_schema");
    const request = value.requests.filter((read) => read.kind === "page")[index];
    if (!request || !request.responseComplete || request.failure !== null) fail("verdict");
    rows += page.rowCount;
  }
  keys(value.facts, ["detection", "range", "pagination", "caps", "envelope"]);
  for (const fact of Object.values(value.facts)) oneOf(fact, ["qualified", "unknown"]);
  const qualified = value.state === "qualified";
  const expectedFacts = {
    detection:
      qualified && value.pages.length === 1 && value.pages[0].rowCount === 0 && value.pages[0].negativeCovered
        ? "qualified"
        : "unknown",
    range: qualified ? "qualified" : "unknown",
    pagination: qualified && value.pages.length > 1 && value.total > 8 ? "qualified" : "unknown",
    caps: qualified ? "qualified" : "unknown",
    envelope: qualified && value.requests.every((read) => read.withinFinalCall) ? "qualified" : "unknown",
  };
  if (!same(value.facts, expectedFacts)) fail("verdict");
  if (
    qualified &&
    (p.evidence !== "synthetic" ||
      !value.pages.length ||
      value.totalBytes > 8388608 ||
      value.distinctCount !== rows ||
      rows !== value.total ||
      value.pages.some(
        (page, index) =>
          page.effectiveSize !== 8 ||
          page.rowCount > 8 ||
          !page.sameSession ||
          !page.allEligible ||
          !page.stable ||
          !page.snapshotPresent ||
          !page.snapshotEqual ||
          page.total !== value.total ||
          page.snapshotCount !== value.total ||
          page.distinctCount !== page.rowCount ||
          page.hardResultCap === null ||
          value.total >= page.hardResultCap ||
          page.hardPageCap === null ||
          index + 1 >= page.hardPageCap ||
          (index < value.pages.length - 1
            ? !page.cursorPresent || !page.cursorAdvance || page.terminal
            : !page.terminal || page.cursorPresent || page.rowCount === 8) ||
          (index === 0 && page.rowCount === 0 && !page.negativeCovered),
      ))
  )
    fail("verdict");
}

export function verifyExport(out) {
  const preparation = verifyPackage(out);
  const directory = path.join(out, "receipt");
  const files = inventory(directory);
  if (Object.keys(files).join() !== "9142-inventory.json,9142-receipt.json") fail("inventory");
  for (const name of Object.keys(files)) if (lstatSync(path.join(directory, name)).size > 65536) fail("export_cap");
  const value = readCanonical(path.join(directory, "9142-receipt.json"));
  assertReceipt(value, preparation);
  const index = readCanonical(path.join(directory, "9142-inventory.json"));
  keys(index.removal, ["extensionAbsent", "profileDisposed", "processesAbsent", "extensionAbsentAt"]);
  const flags = [index.removal.extensionAbsent, index.removal.profileDisposed, index.removal.processesAbsent];
  for (const flag of flags) boolean(flag);
  if (new Set(flags).size !== 1) fail("custody");
  if (index.removal.extensionAbsent) {
    number(index.removal.extensionAbsentAt);
    if (index.removal.extensionAbsentAt < value.finishedAt || index.removal.extensionAbsentAt > value.deadline)
      fail("custody");
  } else if (index.removal.extensionAbsentAt !== null) fail("custody");
  const expected = {
    format: "detection-pagination-inventory/v1",
    evidence: preparation.evidence,
    head: preparation.head,
    extensionId: preparation.extensionId,
    packageDigests: preparation.files,
    files: { "9142-receipt.json": files["9142-receipt.json"] },
    removal: index.removal,
    retainedFiles: ["9142-inventory.json", "9142-receipt.json"],
  };
  if (!same(index, expected)) fail("closed_schema");
  if (index.removal.profileDisposed && existsSync(preparation.profileDirectory)) fail("custody");
  return index;
}
export function recordRemoval(out, extensionAbsent, processesAbsent, removedAt) {
  const index = verifyExport(out);
  if (extensionAbsent !== true || processesAbsent !== true || existsSync(path.join(out, "profile"))) fail("custody");
  const receipt = readCanonical(path.join(out, "receipt", "9142-receipt.json"));
  number(removedAt);
  if (removedAt < receipt.finishedAt || removedAt > receipt.deadline) fail("custody");
  index.removal = { extensionAbsent: true, profileDisposed: true, processesAbsent: true, extensionAbsentAt: removedAt };
  writeFileSync(path.join(out, "receipt", "9142-inventory.json"), json(index));
  return index;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flags = new Map();
    const args = process.argv.slice(2);
    for (let n = 0; n < args.length; n += 1) {
      const key = args[n];
      if (
        flags.has(key) ||
        ![
          "--out",
          "--prepare",
          "--verify",
          "--verify-export",
          "--record-removal",
          "--extension-absent",
          "--processes-absent",
          "--removed-at",
        ].includes(key)
      )
        fail("arguments");
      flags.set(key, ["--out", "--removed-at"].includes(key) ? args[++n] : true);
    }
    const modes = ["--prepare", "--verify", "--verify-export", "--record-removal"].filter((mode) => flags.has(mode));
    if (
      modes.length !== 1 ||
      !flags.has("--out") ||
      (modes[0] !== "--record-removal" &&
        (flags.has("--extension-absent") || flags.has("--processes-absent") || flags.has("--removed-at")))
    )
      fail("arguments");
    const out = flags.get("--out");
    if (modes[0] === "--prepare") prepare({ out });
    else if (modes[0] === "--verify") verifyPackage(out);
    else if (modes[0] === "--verify-export") verifyExport(out);
    else
      recordRemoval(
        out,
        flags.get("--extension-absent"),
        flags.get("--processes-absent"),
        Number(flags.get("--removed-at")),
      );
    console.log("detection-pagination: validated; provider qualification remains host-owned");
  } catch {
    console.error("detection-pagination: refused; no provider authority granted");
    process.exitCode = 1;
  }
}
