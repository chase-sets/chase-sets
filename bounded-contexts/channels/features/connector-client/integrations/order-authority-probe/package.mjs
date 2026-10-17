import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(source, "../../../../../..");
export const AUTHORITY = "https://github.com/chase-sets/chase-sets/issues/8607#issuecomment-5983720229";
export const PROBE = "https://github.com/chase-sets/chase-sets/issues/9115";
const SUCCESSOR = `${PROBE}#issuecomment-6065311293`;
const coreFiles = ["capture.html", "helper.js", "manifest.json", "worker.js"];
const packageFiles = ["capture-config.json", ...coreFiles];
const exportFiles = ["selector-inventory.json", "selector-receipt.json"];
const chromeExecutable = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const launchCommand = (profileDirectory) =>
  `& '${chromeExecutable}' '--user-data-dir=${profileDirectory}' '--no-first-run' '--no-default-browser-check'`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const fail = (code = "export_schema_refused") => {
  throw new Error(code);
};
const check = (condition, code) => {
  if (!condition) fail(code);
};
const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function readJson(file, canonical = false) {
  try {
    check(lstatSync(file).size <= 65536, "artifact_refused");
    const text = readFileSync(file, "utf8");
    const value = JSON.parse(text);
    // Generated artifacts have one exact JSON encoding. This also rejects
    // duplicate keys whose overwritten bytes would evade parsed-value checks.
    check(!canonical || text === json(value), "artifact_refused");
    return value;
  } catch {
    fail("artifact_refused");
  }
}
function closed(value, names, code = "export_schema_refused") {
  check(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join() === [...names].sort().join(),
    code,
  );
}
function utc(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function integer(value, max) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function extensionId(key) {
  return hash(Buffer.from(key, "base64"))
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + Number.parseInt(character, 16)));
}
function assertRealDirectory(directory) {
  check(
    typeof directory === "string" && path.isAbsolute(directory) && path.resolve(directory) === directory,
    "absolute_run_directory_required",
  );
  for (let current = directory; ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail("symlink_refused");
    if (path.dirname(current) === current) break;
  }
}
function inventory(directory) {
  try {
    return Object.fromEntries(
      readdirSync(directory)
        .sort()
        .map((name) => {
          const file = path.join(directory, name);
          check(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), "inventory_mismatch");
          return [name, hash(readFileSync(file))];
        }),
    );
  } catch {
    fail("inventory_mismatch");
  }
}
function same(value, expected, code = "export_schema_refused") {
  check(json(value) === json(expected), code);
}

export function prepare({ out, cadenceMs, cadenceSource, t0, synthetic = false }) {
  check(
    Number.isSafeInteger(cadenceMs) &&
      cadenceMs > 0 &&
      cadenceMs <= 30000 &&
      (synthetic || cadenceMs === 30000) &&
      cadenceSource === AUTHORITY,
    "authority_missing",
  );
  check(utc(t0), "prelaunch_t0_required");
  assertRealDirectory(out);
  check(!existsSync(out), "new_run_directory_required");
  const parent = path.join(repo, "artifacts", "9115");
  check(
    synthetic || (process.platform === "win32" && path.dirname(out) === parent && !git("status", "--porcelain")),
    "clean_reviewed_seat_and_destination_required",
  );
  const head = git("rev-parse", "HEAD");
  check(synthetic || existsSync(chromeExecutable), "chrome_executable_missing");
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const manifest = { ...readJson(path.join(source, "manifest.json")), key };
  const id = extensionId(key);
  const packageDirectory = path.join(out, "package");
  const receiptDirectory = path.join(out, "receipt");
  const profileDirectory = path.join(out, "profile");
  for (const directory of [packageDirectory, receiptDirectory, profileDirectory])
    mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(packageDirectory, "manifest.json"), json(manifest), { flag: "wx" });
  for (const name of ["worker.js", "helper.js", "capture.html"])
    writeFileSync(path.join(packageDirectory, name), readFileSync(path.join(source, name)), { flag: "wx" });
  const config = {
    format: "order-authority-package/v4",
    head,
    probe: PROBE,
    t0,
    cadenceMs,
    cadenceSource,
    extensionId: id,
    evidence: synthetic ? "synthetic" : "operator",
    files: inventory(packageDirectory),
  };
  writeFileSync(path.join(packageDirectory, "capture-config.json"), json(config), { flag: "wx" });
  const preparation = {
    format: "order-authority-preparation/v4",
    evidence: config.evidence,
    head,
    probe: PROBE,
    extensionId: id,
    preparedAt: new Date().toISOString(),
    t0,
    cadenceMs,
    cadenceSource,
    packageDirectory,
    receiptDirectory,
    profileDirectory,
    captureUrl: `chrome-extension://${id}/capture.html`,
    launchCommand: launchCommand(profileDirectory),
    packageDigests: inventory(packageDirectory),
    retainedFiles: [
      "RUNBOOK.md",
      "preparation.json",
      "preparation-inventory.json",
      ...packageFiles.map((file) => `package/${file}`),
      "receipt/selector-receipt.json",
      "receipt/selector-inventory.json",
    ],
    qualification: "PENDING_HOST_VERIFIER",
  };
  const cli = path.join(source, "package.mjs");
  const runbook = `# One isolated HUMAN-operated selector capture for ${PROBE}

Evidence: ${config.evidence}. Head: ${head}. Extension: ${id}.
Cadence: ${cadenceMs} ms, probe-only authority ${AUTHORITY}, not production cadence.
Successor authority: ${SUCCESSOR}. #8608 FINAL r4 and #8838's terminal disposition remain unchanged.
Preparation grants NO execution. Synthetic identities are synthetic, never live qualification.
PENDING_HOST_VERIFIER: exact-head independent build review, old-profile disposal observation,
passed human-route removal/disposal rehearsal and ordinary admission are prerequisites.
No agent/model may access a provider page, DOM, screenshot, accessibility output, private console
or raw network data. The visible Chrome window and native dialogs are HUMAN-only.

1. Host verifies the complete hash-bound package and its exact Probe/head:
   node "${cli}" --verify --out "${out}"
   T0 is fixed at ${t0} BEFORE the first profile launch; never rewrite it.
   T0+900000 covers sign-in through extension removal/absence attestation.
   Pre-begin expiry consumes the ONE lifecycle. Worker caps begin+900000 by T0+900000.
2. Only after all prerequisites and admission, HUMAN opens this new profile:
   ${preparation.launchCommand}
   Never use Todd's work or Pokebash TCG profiles, copy credentials/cookies, or borrow a session.
   HUMAN signs in; no HAR, trace, raw recording or private output to agents/models.
   Set Downloads to ${receiptDirectory}; allow exactly the two selector exports.
3. HUMAN uses chrome://extensions, Developer mode, Load unpacked ${packageDirectory}.
   Confirm ID ${id}, then open ${preparation.captureUrl}.
   In ONLY the helper console invoke await orderAuthorityCapture.run(), no arguments.
   The helper contains no provider page reader. Native prompts only, no identifiers anywhere.
   One lookup, then cadence BEFORE every before-bracket (including fallback).
   Confirm Last 2 years (LastTwoYears) first. One explicit range correction at most.
   Transcribe the count's adjacent label WITHOUT first reading the count. No prefill/echo.
   Only trim/collapsed-whitespace/case variants of Ready to Ship are accepted.
   Attest settled and unchanged, then read that adjacent quick-filter count ONCE.
   Exclude all-orders, pagination and search totals. Worker total stays hidden until both brackets seal.
   After response, HUMAN loads a FRESH Orders view, restores the worker range once if reload reset it,
   confirms range, transcribes adjacent label, attests settled/unchanged, then reads the count ONCE.
   Settled means this post-response fresh load settled; unchanged permits only explicit range restoration.
   Tags/times are human-attested helper metadata, NOT machine portal observations.
   before<=request start<=response end<=after; before gap<=30 s and after gap<=120 s.
   Stale/timeout observations are unknown and terminal; never take a second observation.
   Only eligible non-200/validation failure offers Last 90 days (LastThreeMonths) once, with fresh brackets.
   Count/filter/surface/closure mismatch NEVER retries. No details, buckets, order-number input or pagination.
   Cancel, session/custody loss, 401/403/429, redirect, timeout, overflow, expiry or disclosure stops.
   await orderAuthorityCapture.abort(), no arguments, stops a pending read; page closure also aborts.
   Heartbeat is permission-free, has no provider traffic, stops on terminal paths; restart loses custody.
   Begin/reopen/restart/reinstall NEVER authorizes another run or moves T0.
4. Retain exactly selector-receipt.json and selector-inventory.json at ${receiptDirectory}.
   Bounds: 1 lookup, <=2 searches, 0 details, 30 s cadence and 30 s/request; absolute 15 min window.
   Request8192/lookup65536/list1048576/session8388608 bytes. Unknown is not qualification.
   Host verifies the closed pair before any posting:
   node "${cli}" --verify-export --out "${out}"
5. HUMAN removes extension ${id} in this exact profile's chrome://extensions, confirms absence
   and records its actual UTC observation time within T0+900000. Close this exact profile.
   HUMAN manually disposes ONLY ${profileDirectory} outside agent tools; no agent auto-delete or offline substitution.
   Host observes exact-profile directory absence, zero exact-profile Chrome processes and no unknown command lines.
   Directory disposal/host absence may finish later, but Probe AC2 remains pending until observed.
   Host records HUMAN-observed extension absence and disposal, never CDP uninstall as human-route proof:
   node "${cli}" --record-removal --extension-absent --extension-absent-at "<actual UTC time>" --out "${out}"
   This checks directory absence, not browser absence/processes. Late extension absence never satisfies the window.
   Host keeps the package and two scrubbed exports, no raw values. No historical artifact rewrite.
`;
  writeFileSync(path.join(out, "RUNBOOK.md"), runbook, { flag: "wx" });
  writeFileSync(path.join(out, "preparation.json"), json(preparation), { flag: "wx" });
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
      self: "preparation-inventory.json",
    }),
    { flag: "wx" },
  );
  return preparation;
}

export function verifyPackage(out) {
  assertRealDirectory(out);
  const preparation = readJson(path.join(out, "preparation.json"), true);
  closed(
    preparation,
    [
      "format",
      "evidence",
      "head",
      "probe",
      "extensionId",
      "preparedAt",
      "t0",
      "cadenceMs",
      "cadenceSource",
      "packageDirectory",
      "receiptDirectory",
      "profileDirectory",
      "captureUrl",
      "launchCommand",
      "packageDigests",
      "retainedFiles",
      "qualification",
    ],
    "package_mismatch",
  );
  const expectedNames = ["RUNBOOK.md", "preparation-inventory.json", "preparation.json", "package", "receipt"];
  if (existsSync(path.join(out, "profile"))) expectedNames.push("profile");
  same(readdirSync(out).sort(), expectedNames.sort(), "inventory_mismatch");
  for (const name of expectedNames) check(!lstatSync(path.join(out, name)).isSymbolicLink(), "symlink_refused");
  const directory = path.join(out, "package");
  const actual = inventory(directory);
  same(Object.keys(actual), packageFiles, "inventory_mismatch");
  same(actual, preparation.packageDigests, "digest_mismatch");
  const manifest = readJson(path.join(directory, "manifest.json"), true);
  const config = readJson(path.join(directory, "capture-config.json"), true);
  closed(
    config,
    ["format", "head", "probe", "t0", "cadenceMs", "cadenceSource", "extensionId", "evidence", "files"],
    "package_mismatch",
  );
  check(
    config.format === "order-authority-package/v4" &&
      preparation.format === "order-authority-preparation/v4" &&
      config.probe === PROBE &&
      preparation.probe === PROBE &&
      ["synthetic", "operator"].includes(config.evidence) &&
      config.evidence === preparation.evidence &&
      config.extensionId === extensionId(manifest.key) &&
      preparation.extensionId === config.extensionId &&
      config.head === preparation.head &&
      /^[a-f0-9]{40}$/.test(config.head) &&
      utc(config.t0) &&
      config.t0 === preparation.t0 &&
      utc(preparation.preparedAt) &&
      config.cadenceMs === preparation.cadenceMs &&
      Number.isSafeInteger(config.cadenceMs) &&
      config.cadenceMs > 0 &&
      config.cadenceMs <= 30000 &&
      (config.evidence === "synthetic" || config.cadenceMs === 30000) &&
      config.cadenceSource === AUTHORITY &&
      preparation.cadenceSource === AUTHORITY &&
      preparation.packageDirectory === directory &&
      preparation.receiptDirectory === path.join(out, "receipt") &&
      preparation.profileDirectory === path.join(out, "profile") &&
      preparation.captureUrl === `chrome-extension://${config.extensionId}/capture.html` &&
      preparation.launchCommand === launchCommand(preparation.profileDirectory) &&
      preparation.qualification === "PENDING_HOST_VERIFIER",
    "package_mismatch",
  );
  const core = Object.fromEntries(Object.entries(actual).filter(([name]) => name !== "capture-config.json"));
  same(core, config.files, "digest_mismatch");
  for (const file of coreFiles) {
    const relative = path.posix.join(
      "bounded-contexts/channels/features/connector-client/integrations/order-authority-probe",
      file,
    );
    const expected =
      config.evidence === "operator"
        ? execFileSync("git", ["show", `${config.head}:${relative}`], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })
        : readFileSync(path.join(source, file));
    if (file === "manifest.json")
      same(manifest, { ...JSON.parse(expected.toString()), key: manifest.key }, "package_mismatch");
    else check(hash(expected) === actual[file], "digest_mismatch");
  }
  const expected = {
    "RUNBOOK.md": hash(readFileSync(path.join(out, "RUNBOOK.md"))),
    "preparation.json": hash(readFileSync(path.join(out, "preparation.json"))),
    ...Object.fromEntries(Object.entries(actual).map(([name, digest]) => [`package/${name}`, digest])),
  };
  same(
    readJson(path.join(out, "preparation-inventory.json"), true),
    { files: expected, self: "preparation-inventory.json" },
    "digest_mismatch",
  );
  same(
    preparation.retainedFiles,
    [
      "RUNBOOK.md",
      "preparation.json",
      "preparation-inventory.json",
      ...packageFiles.map((file) => `package/${file}`),
      "receipt/selector-receipt.json",
      "receipt/selector-inventory.json",
    ],
    "package_mismatch",
  );
  return preparation;
}

const failures = new Set([
  "package_mismatch",
  "authority_missing",
  "repeat_invocation",
  "invalid_message",
  "wrong_origin",
  "canceled",
  "deadline",
  "request_budget",
  "request_ceiling_exceeded",
  "response_ceiling_exceeded",
  "response_timeout",
  "redirect",
  "session_missing",
  "http_status",
  "invalid_json",
  "invalid_shape",
  "transport_failure",
  "custody_failure",
  "date_filter_mismatch",
  "count_surface_mismatch",
  "display_unsettled",
  "bracket_changed",
  "count_input_invalid",
  "bracket_timing",
  "aborted",
  "completeness_unproven",
  "page_ceiling_exceeded",
]);
const reasons = new Set([
  ...failures,
  "qualified",
  "counts_pending",
  "length_mismatch",
  "page_not_closed",
  "duplicate_order",
  "filter_not_honored",
  "count_mismatch",
]);
const fields = {
  lookup: ["seller", "seller.sellerKey"],
  list: [
    "totalOrders",
    "orders",
    ...[
      "orderNumber",
      "orderDate",
      "orderChannel",
      "orderStatus",
      "buyerName",
      "shippingType",
      "productAmount",
      "shippingAmount",
      "totalAmount",
      "buyerPaid",
      "orderFulfillment",
    ].map((name) => `orders[].${name}`),
  ],
};
function assertReceipt(receipt, preparation) {
  closed(receipt, [
    "format",
    "evidence",
    "probe",
    "origin",
    "extensionId",
    "head",
    "digests",
    "cadenceMs",
    "cadenceSource",
    "t0",
    "startedAt",
    "finishedAt",
    "deadlineAt",
    "counts",
    "totalBytes",
    "requests",
    "failures",
    "selector",
    "completeness",
  ]);
  const start = Date.parse(receipt.startedAt);
  const finish = Date.parse(receipt.finishedAt);
  const deadline = Date.parse(receipt.deadlineAt);
  check(
    receipt.format === "order-authority-receipt/v4" &&
      receipt.evidence === preparation.evidence &&
      receipt.probe === PROBE &&
      receipt.origin === "extension-service-worker" &&
      receipt.extensionId === preparation.extensionId &&
      receipt.head === preparation.head &&
      receipt.cadenceMs === preparation.cadenceMs &&
      receipt.cadenceSource === AUTHORITY &&
      receipt.t0 === preparation.t0 &&
      [receipt.startedAt, receipt.finishedAt, receipt.deadlineAt].every(utc) &&
      finish >= start &&
      deadline === Math.min(start + 900000, Date.parse(preparation.t0) + 900000) &&
      receipt.completeness === "unknown",
  );
  same(
    receipt.digests,
    Object.fromEntries(Object.entries(preparation.packageDigests).filter(([name]) => name !== "capture-config.json")),
  );
  closed(receipt.counts, ["lookup", "list", "detail"]);
  check(
    integer(receipt.counts.lookup, 1) &&
      integer(receipt.counts.list, 2) &&
      receipt.counts.detail === 0 &&
      integer(receipt.totalBytes, 8388608 + 1048576),
  );
  check(
    Array.isArray(receipt.failures) &&
      receipt.failures.length <= 3 &&
      receipt.failures.every((code) => failures.has(code)),
  );
  check(Array.isArray(receipt.requests) && receipt.requests.length <= 3);
  const counts = { lookup: 0, list: 0 };
  let previousStart = null;
  let bytes = 0;
  for (const request of receipt.requests) {
    closed(request, [
      "kind",
      "method",
      "host",
      "version",
      "pathTemplate",
      "startedAt",
      "endedAt",
      "elapsedMs",
      "status",
      "redirect",
      "contentType",
      "credentials",
      "authorizationPresent",
      "requestBytes",
      "responseBytes",
      "responseComplete",
      "ceilingBytes",
      "nearCeiling",
      "shape",
      "failure",
    ]);
    check(Object.hasOwn(counts, request.kind));
    counts[request.kind] += 1;
    const lookup = request.kind === "lookup";
    const from = Date.parse(request.startedAt);
    const to = Date.parse(request.endedAt);
    check(
      request.method === (lookup ? "GET" : "POST") &&
        request.host === (lookup ? "sp-api.tcgplayer.com" : "order-management-api.tcgplayer.com") &&
        request.version === (lookup ? "1.0" : "2.0") &&
        request.pathTemplate === (lookup ? "/account/auth-detail" : "/orders/search") &&
        request.credentials === "include" &&
        request.authorizationPresent === false &&
        request.ceilingBytes === (lookup ? 65536 : 1048576) &&
        utc(request.startedAt) &&
        utc(request.endedAt) &&
        from >= start &&
        from < deadline &&
        to >= from &&
        to <= finish &&
        request.elapsedMs === to - from &&
        (previousStart === null || from - previousStart >= receipt.cadenceMs) &&
        (lookup ? previousStart === null : counts.lookup === 1) &&
        integer(request.requestBytes, 8192) &&
        integer(request.responseBytes, request.ceilingBytes + 1048576) &&
        (request.status === null || integer(request.status, 599)) &&
        typeof request.responseComplete === "boolean" &&
        typeof request.nearCeiling === "boolean" &&
        ["unknown", "none", "blocked", "opaque-destination-unknown"].includes(request.redirect) &&
        ["unknown", "application/json", "text/html", "other"].includes(request.contentType) &&
        (request.failure === null || failures.has(request.failure)),
    );
    if (request.failure === null)
      check(
        request.status === 200 &&
          request.responseComplete &&
          request.redirect === "none" &&
          request.contentType === "application/json" &&
          request.responseBytes <= request.ceilingBytes &&
          to <= deadline &&
          request.elapsedMs <= 30000,
      );
    if (request.shape !== null) {
      closed(request.shape, ["fields", "omittedFields"]);
      check(
        request.responseComplete &&
          integer(request.shape.omittedFields, 1048576) &&
          Array.isArray(request.shape.fields) &&
          request.shape.fields.length <= fields[request.kind].length,
      );
      const seen = new Set();
      for (const field of request.shape.fields) {
        closed(field, ["field", "types"]);
        check(
          fields[request.kind].includes(field.field) &&
            !seen.has(field.field) &&
            Array.isArray(field.types) &&
            field.types.length > 0 &&
            field.types.length <= 6 &&
            new Set(field.types).size === field.types.length &&
            field.types.every((type) => ["string", "number", "boolean", "object", "array", "null"].includes(type)),
        );
        seen.add(field.field);
      }
    }
    previousStart = from;
    bytes += request.requestBytes + request.responseBytes;
  }
  check(receipt.totalBytes === bytes && receipt.counts.lookup >= counts.lookup && receipt.counts.list >= counts.list);
  closed(receipt.selector, ["identity", "searches"]);
  check(
    receipt.selector.identity === "tcgplayer-ready-to-ship-selector/v1" &&
      Array.isArray(receipt.selector.searches) &&
      receipt.selector.searches.length === counts.list,
  );
  for (const [index, search] of receipt.selector.searches.entries()) {
    closed(search, [
      "searchRange",
      "filter",
      "sortBy",
      "from",
      "pageSize",
      "before",
      "after",
      "sameSession",
      "topLevelKeys",
      "totalOrders",
      "rowCount",
      "distinctCount",
      "listStatuses",
      "oldestRowAgeBucket",
      "qualification",
      "reason",
    ]);
    same(search.filter, { surface: "search-filter", key: "ReadyToShip" });
    same(search.sortBy, []);
    check(
      search.searchRange === (index === 0 ? "LastTwoYears" : "LastThreeMonths") &&
        search.from === 0 &&
        search.pageSize === 500 &&
        typeof search.sameSession === "boolean" &&
        ["unknown", "qualified"].includes(search.qualification) &&
        reasons.has(search.reason) &&
        ["unknown", "empty", "0-90-days", "91-730-days", "over-730-days"].includes(search.oldestRowAgeBucket),
    );
    const request = receipt.requests.filter((item) => item.kind === "list")[index];
    for (const bracket of [search.before, search.after]) {
      if (bracket === null && bracket === search.after) continue;
      closed(bracket, ["count", "dateFilter", "reprompted", "countSurface", "observedAt", "settled", "unchanged"]);
      check(
        integer(bracket.count, 999999999) &&
          bracket.dateFilter === search.searchRange &&
          typeof bracket.reprompted === "boolean" &&
          bracket.countSurface === "ready-to-ship-quick-filter" &&
          utc(bracket.observedAt) &&
          bracket.settled === true &&
          bracket.unchanged === true,
      );
    }
    const before = Date.parse(search.before.observedAt);
    check(
      before >= start && before <= Date.parse(request.startedAt) && Date.parse(request.startedAt) - before <= 30000,
    );
    if (search.after !== null) {
      const after = Date.parse(search.after.observedAt);
      check(
        search.sameSession &&
          after >= Date.parse(request.endedAt) &&
          after <= finish &&
          after - Date.parse(request.endedAt) <= 120000,
      );
    } else
      check(
        !search.sameSession &&
          search.qualification === "unknown" &&
          search.totalOrders === null &&
          search.rowCount === null &&
          search.distinctCount === null &&
          search.listStatuses.length === 0 &&
          search.topLevelKeys.length === 0,
      );
    check(
      Array.isArray(search.topLevelKeys) &&
        (search.topLevelKeys.length === 0 || search.topLevelKeys.slice().sort().join() === "orders,totalOrders") &&
        Array.isArray(search.listStatuses) &&
        search.listStatuses.length <= 1 &&
        (search.totalOrders === null || integer(search.totalOrders, Number.MAX_SAFE_INTEGER)) &&
        (search.rowCount === null || integer(search.rowCount, 500)) &&
        (search.distinctCount === null || integer(search.distinctCount, search.rowCount)),
    );
    for (const status of search.listStatuses) {
      closed(status, ["surface", "key", "count"]);
      check(
        status.surface === "list-display" &&
          status.key === "Ready to Ship" &&
          integer(status.count, search.rowCount) &&
          status.count > 0,
      );
    }
    if (search.qualification === "qualified")
      check(
        receipt.failures.length === 0 &&
          request.status === 200 &&
          request.failure === null &&
          request.responseComplete &&
          search.reason === "qualified" &&
          search.after !== null &&
          search.topLevelKeys.length === 2 &&
          search.sameSession &&
          search.totalOrders === search.rowCount &&
          search.distinctCount === search.rowCount &&
          search.totalOrders < 500 &&
          search.before.count === search.totalOrders &&
          search.after.count === search.totalOrders &&
          search.listStatuses.reduce((sum, item) => sum + item.count, 0) === search.rowCount,
      );
    else check(search.reason !== "qualified");
    if (index === 1) {
      const first = receipt.selector.searches[0];
      check(
        first.after !== null &&
          first.sameSession &&
          first.before.count === first.after.count &&
          first.qualification === "unknown" &&
          ["http_status", "invalid_json", "invalid_shape"].includes(first.reason) &&
          receipt.requests.filter((item) => item.kind === "list")[0].failure === first.reason,
      );
    }
  }
  if (start < Date.parse(preparation.t0) || finish >= deadline)
    check(receipt.failures.includes("deadline") || receipt.failures.includes("response_timeout"));
}

export function verifyExport(out) {
  const preparation = verifyPackage(out);
  const directory = path.join(out, "receipt");
  const files = inventory(directory);
  same(Object.keys(files), exportFiles, "inventory_mismatch");
  const receipt = readJson(path.join(directory, "selector-receipt.json"), true);
  assertReceipt(receipt, preparation);
  const index = readJson(path.join(directory, "selector-inventory.json"), true);
  const pending = {
    extensionAbsent: false,
    extensionAbsentAt: null,
    profileDisposed: false,
    confirmation: "pending-operator-removal",
  };
  if (json(index.removal) !== json(pending)) {
    closed(index.removal, ["extensionAbsent", "extensionAbsentAt", "profileDisposed", "confirmation"]);
    check(
      index.removal.extensionAbsent === true &&
        index.removal.profileDisposed === true &&
        index.removal.confirmation === "operator-attested-extension-absence-and-profile-disposal" &&
        utc(index.removal.extensionAbsentAt) &&
        Date.parse(index.removal.extensionAbsentAt) >= Date.parse(receipt.finishedAt) &&
        Date.parse(index.removal.extensionAbsentAt) <= Date.parse(receipt.deadlineAt) &&
        !existsSync(preparation.profileDirectory),
      "removal_not_confirmed",
    );
  }
  same(index, {
    format: "order-authority-inventory/v4",
    evidence: preparation.evidence,
    probe: PROBE,
    head: preparation.head,
    extensionId: preparation.extensionId,
    files: { "selector-receipt.json": files["selector-receipt.json"] },
    packageDigests: receipt.digests,
    removal: index.removal,
    retainedFiles: ["selector-receipt.json", "selector-inventory.json"],
  });
  return index;
}
export function recordRemoval(out, extensionAbsent, extensionAbsentAt) {
  const index = verifyExport(out);
  const receipt = readJson(path.join(out, "receipt", "selector-receipt.json"));
  check(
    extensionAbsent === true &&
      !existsSync(path.join(out, "profile")) &&
      utc(extensionAbsentAt) &&
      Date.parse(extensionAbsentAt) >= Date.parse(receipt.finishedAt) &&
      Date.parse(extensionAbsentAt) <= Date.parse(receipt.deadlineAt),
    "removal_not_confirmed",
  );
  index.removal = {
    extensionAbsent: true,
    extensionAbsentAt,
    profileDisposed: true,
    confirmation: "operator-attested-extension-absence-and-profile-disposal",
  };
  writeFileSync(path.join(out, "receipt", "selector-inventory.json"), json(index));
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const flags = new Map();
    const values = ["--out", "--cadence-ms", "--cadence-source", "--t0", "--extension-absent-at"];
    for (let index = 0; index < args.length; index += 1) {
      const key = args[index];
      check(
        !flags.has(key) &&
          [...values, "--verify", "--verify-export", "--record-removal", "--extension-absent"].includes(key),
        "invalid_arguments",
      );
      flags.set(key, values.includes(key) ? args[++index] : true);
    }
    const out = flags.get("--out");
    check(
      ["--verify", "--verify-export", "--record-removal"].filter((key) => flags.has(key)).length <= 1,
      "invalid_arguments",
    );
    if (flags.has("--record-removal"))
      recordRemoval(out, flags.get("--extension-absent"), flags.get("--extension-absent-at"));
    else if (flags.has("--verify-export")) verifyExport(out);
    else if (flags.has("--verify")) verifyPackage(out);
    else
      prepare({
        out,
        cadenceMs: Number(flags.get("--cadence-ms")),
        cadenceSource: flags.get("--cadence-source"),
        t0: flags.get("--t0"),
      });
    console.log("order-authority: completed; qualification remains host-owned");
  } catch {
    console.error("order-authority: refused; check authority, T0, inventory, destination and removal requirements");
    process.exitCode = 1;
  }
}
