import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(source, "../../../../../..");
export const AUTHORITY = "https://github.com/chase-sets/chase-sets/issues/8607#issuecomment-5983720229";
const packageFiles = ["capture-config.json", "capture.html", "helper.js", "manifest.json", "worker.js"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const fail = (code) => {
  throw new Error(code);
};
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function extensionId(key) {
  return hash(Buffer.from(key, "base64"))
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + Number.parseInt(character, 16)));
}

function assertRealDirectory(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail("symlink_refused");
    if (path.dirname(current) === current) break;
  }
}

function inventory(directory) {
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => {
        const file = path.join(directory, name);
        if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) fail("inventory_mismatch");
        return [name, hash(readFileSync(file))];
      }),
  );
}

export function prepare({ out, cadenceMs, cadenceSource, synthetic = false }) {
  if (
    !Number.isSafeInteger(cadenceMs) ||
    cadenceMs <= 0 ||
    (!synthetic && cadenceMs !== 30000) ||
    cadenceSource !== AUTHORITY
  )
    fail("authority_missing");
  if (typeof out !== "string" || !path.isAbsolute(out) || path.resolve(out) !== out)
    fail("absolute_run_directory_required");
  assertRealDirectory(out);
  if (existsSync(out)) fail("new_run_directory_required");
  const parent = path.join(repo, "artifacts", "8838");
  if (!synthetic && (process.platform !== "win32" || path.dirname(out) !== parent || git("status", "--porcelain"))) {
    fail("clean_reviewed_seat_and_destination_required");
  }
  const head = git("rev-parse", "HEAD");
  const chromeExecutable = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (!synthetic && !existsSync(chromeExecutable)) fail("chrome_executable_missing");
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
  for (const name of ["worker.js", "helper.js", "capture.html"]) {
    writeFileSync(path.join(packageDirectory, name), readFileSync(path.join(source, name)), { flag: "wx" });
  }
  const config = {
    format: "order-authority-package/v2",
    head,
    cadenceMs,
    cadenceSource,
    extensionId: id,
    evidence: synthetic ? "synthetic" : "operator",
    files: inventory(packageDirectory),
  };
  writeFileSync(path.join(packageDirectory, "capture-config.json"), json(config), { flag: "wx" });
  const preparation = {
    format: "order-authority-preparation/v2",
    evidence: config.evidence,
    head,
    extensionId: id,
    preparedAt: new Date().toISOString(),
    cadenceMs,
    cadenceSource,
    packageDirectory,
    receiptDirectory,
    profileDirectory,
    captureUrl: `chrome-extension://${id}/capture.html`,
    launchCommand: `& '${chromeExecutable}' '--user-data-dir=${profileDirectory}' '--no-first-run' '--no-default-browser-check'`,
    packageDigests: inventory(packageDirectory),
    retainedFiles: [
      "RUNBOOK.md",
      "preparation.json",
      "preparation-inventory.json",
      ...packageFiles.map((file) => `package/${file}`),
      "receipt/8838-receipt.json",
      "receipt/8838-inventory.json",
    ],
    qualification: "PENDING_HOST_VERIFIER",
  };
  const cli = path.join(source, "package.mjs");
  const runbook = `# One isolated selector/status capture for #8838

Evidence mode: ${config.evidence}. Head: ${head}. Extension: ${id}.
Cadence: ${cadenceMs} ms, probe-only authority from ${cadenceSource}, not a production cadence ruling.
Synthetic preparation is never live authority. No provider call or session is authorized before independent host review.
Do not relay until the host has exact-head review and attributed hermetic/browser-origin controls.
This preparation itself is PENDING_HOST_VERIFIER, not a qualification PASS.

1. Host verifies the complete emitted inventory, including manifest/worker/helper digests:
   node "${cli}" --verify --out "${out}"
   Refuse missing/tampered files, profile/origin mismatch, or missing controls. No provider requests occur in preparation or verification.
2. Host supplies this exact PowerShell command to open only the newly created profile:
   ${preparation.launchCommand}
   Never use work/Pokebash TCG or sign in/out of a shared profile. Todd signs into the approved seller session himself; no cookie/credential copying/import, HAR, trace, screenshots or raw network recording.
   Set this profile's Downloads directory to ${receiptDirectory} and allow the two fixed-name exports there.
3. In that profile only, open chrome://extensions, enable Developer mode, Load unpacked:
   ${packageDirectory}
   Confirm extension ID ${id}. Open ${preparation.captureUrl}.
   In that helper's console invoke only: await orderAuthorityCapture.run()
   No arguments. Use native prompts only; never enter identifiers in console/URL/logs.
   Keep the complete operator session, including sign-in, prompts and removal, within 15 minutes; use an operator timer.
   Helper elapsed time starts at invocation. The durable worker deadline starts at begin and is never extended.
   A permission-free worker heartbeat keeps the active run resident during native dialogs, without provider traffic or persistence.
   It stops on every terminal path and at the unchanged deadline. Browser/profile closure or worker termination still loses transient custody and refuses restart; never reinstall to retry.
   After one lookup and the cadence wait, record the visible Ready to Ship count and date filter immediately before search.
   Record the same count/date filter immediately after search, then confirm unchanged seller/session.
   LastTwoYears is first; only eligible non-200/validation failure offers one LastThreeMonths fallback with fresh brackets.
   Set the portal date filter to Last 2 years (LastTwoYears) first, or Last 90 days (LastThreeMonths) only on fallback.
   Both recorded filters must equal the current worker search range; equal counts under another range remain unknown.
   Count/filter/closure mismatch is unknown, not fallback authority. No repeat to force agreement.
   To stop a pending read, invoke only await orderAuthorityCapture.abort(), with no arguments. Closing the capture page aborts.
   For each available Shipped - In Transit, Shipped - Delivered, Completed - Paid and Canceled bucket, privately choose
   and enter one order number. No means absent/unqualified; Cancel/blank stops. Inputs are never echoed or exported.
   Installation, opening and reloading make no provider request. After begin, reopens/restarts never authorize another run.
4. Retain exactly 8838-receipt.json and 8838-inventory.json under:
   ${receiptDirectory}
   Only the worker fetches: one session lookup, at most two searches and four details, serial. No pagination or other retry.
   Stop on authority/session/custody failure, unexpected request, redirect/login, 401/403/429, deadline, canceled prompt, or repeat. Do not borrow a session or reinstall to retry.
   Operational ceilings (not provider-size authority): request 8 KiB; lookup 64 KiB; list 1 MiB at size 500; detail 512 KiB; session 8 MiB; request wall time 30 s.
   Overflow/endless body/timeout has no partial projection. Unknown/negative is legitimate and never census/completeness proof.
   Host validates the two exports and scans before posting:
   node "${cli}" --verify-export --out "${out}"
5. Remove extension ${id} at chrome://extensions in this profile and confirm it is absent.
   Verify that extension ${id} is absent at chrome://extensions before recording removal.
   Qualification's CDP Extensions.loadUnpacked is session-scoped; manual Load-unpacked persistence was not exercised.
   Closing the inspector is not removal. Close this profile. Host disposes only its verified, host-created directory ${profileDirectory}; never unrelated TEMP or other profiles.
   After observing extension absence and profile disposal, host records the attestation:
   node "${cli}" --record-removal --extension-absent --out "${out}"
   This checks profile absence and records operator-attested extension absence, not an automated browser proof.
   Retain only the inventory-listed package, preparation/runbook and two scrubbed exports. The inventory does not recursively hash itself.
   Host preserves this implementation seat, or re-homes and re-verifies the complete package and paths before relay.
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
  const preparation = readJson(path.join(out, "preparation.json"));
  const expectedNames = ["RUNBOOK.md", "preparation-inventory.json", "preparation.json", "package", "receipt"];
  if (existsSync(path.join(out, "profile"))) expectedNames.push("profile");
  if (readdirSync(out).sort().join() !== expectedNames.sort().join()) fail("inventory_mismatch");
  for (const name of expectedNames) if (lstatSync(path.join(out, name)).isSymbolicLink()) fail("symlink_refused");
  const directory = path.join(out, "package");
  const actual = inventory(directory);
  if (Object.keys(actual).join() !== packageFiles.join() || json(actual) !== json(preparation.packageDigests))
    fail("digest_mismatch");
  const manifest = readJson(path.join(directory, "manifest.json"));
  const config = readJson(path.join(directory, "capture-config.json"));
  if (
    config.format !== "order-authority-package/v2" ||
    preparation.format !== "order-authority-preparation/v2" ||
    !["synthetic", "operator"].includes(config.evidence) ||
    config.evidence !== preparation.evidence ||
    config.extensionId !== extensionId(manifest.key) ||
    preparation.extensionId !== config.extensionId ||
    config.head !== preparation.head ||
    !/^[a-f0-9]{40}$/.test(config.head) ||
    config.cadenceMs !== preparation.cadenceMs ||
    !Number.isSafeInteger(config.cadenceMs) ||
    config.cadenceMs <= 0 ||
    (config.evidence === "operator" && config.cadenceMs !== 30000) ||
    config.cadenceSource !== AUTHORITY ||
    preparation.cadenceSource !== AUTHORITY ||
    preparation.packageDirectory !== directory ||
    preparation.receiptDirectory !== path.join(out, "receipt") ||
    preparation.profileDirectory !== path.join(out, "profile")
  )
    fail("package_mismatch");
  const core = Object.fromEntries(Object.entries(actual).filter(([name]) => name !== "capture-config.json"));
  if (json(core) !== json(config.files)) fail("digest_mismatch");
  const expected = {
    "RUNBOOK.md": hash(readFileSync(path.join(out, "RUNBOOK.md"))),
    "preparation.json": hash(readFileSync(path.join(out, "preparation.json"))),
    ...Object.fromEntries(Object.entries(actual).map(([name, digest]) => [`package/${name}`, digest])),
  };
  const index = readJson(path.join(out, "preparation-inventory.json"));
  if (json(index) !== json({ files: expected, self: "preparation-inventory.json" })) fail("digest_mismatch");
  return preparation;
}

// Validate the export language, not just a sentinel or a hash supplied by the
// same export. No arbitrary string, field name, exception or input is admitted.
function assertReceipt(receipt, preparation) {
  const strings = new Set([
    "order-authority-receipt/v2",
    preparation.evidence,
    "extension-service-worker",
    preparation.extensionId,
    preparation.head,
    AUTHORITY,
    "unknown",
    "not-observed-on-captured-surface",
    "lookup",
    "list",
    "detail",
    "GET",
    "POST",
    "sp-api.tcgplayer.com",
    "order-management-api.tcgplayer.com",
    "1.0",
    "2.0",
    "/account/auth-detail",
    "/orders/search",
    "/orders/{encodedOrderNumber}",
    "include",
    "none",
    "blocked",
    "opaque-destination-unknown",
    "application/json",
    "text/html",
    "other",
    "string",
    "number",
    "boolean",
    "object",
    "array",
    "null",
    "tcgplayer-ready-to-ship-selector/v1",
    "search-filter",
    "list-display",
    "order-detail",
    "ReadyToShip",
    "LastTwoYears",
    "LastThreeMonths",
    "empty",
    "0-90-days",
    "91-730-days",
    "over-730-days",
    "qualified",
    "captured",
    "unqualified",
    "absent",
    "selected",
    "not-selected",
    "counts_pending",
    "length_mismatch",
    "page_not_closed",
    "duplicate_order",
    "filter_not_honored",
    "count_mismatch",
    "date_filter_mismatch",
    "identity_mismatch",
    "selector_unknown",
    "aborted",
    "completeness_unproven",
    "page_ceiling_exceeded",
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
    ...Object.values(preparation.packageDigests),
  ]);
  const fields = new Set([
    "seller",
    "seller.sellerKey",
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
    "createdAt",
    "status",
    "orderChannel",
    "orderFulfillment",
    "orderNumber",
    "sellerName",
    "buyerName",
    "paymentType",
    "pickupStatus",
    "shippingType",
    "estimatedDeliveryDate",
    "refundStatus",
    "refunds",
    "trackingNumbers",
    "allowedActions",
    "transaction",
    ...["productAmount", "shippingAmount", "grossAmount", "feeAmount", "netAmount", "directFeeAmount", "taxes"].map(
      (name) => `transaction.${name}`,
    ),
    "transaction.taxes[].code",
    "transaction.taxes[].amount",
    "shippingAddress",
    ...["recipientName", "addressOne", "addressTwo", "city", "territory", "country", "postalCode"].map(
      (name) => `shippingAddress.${name}`,
    ),
    "products",
    ...["name", "unitPrice", "extendedPrice", "quantity", "url", "productId", "skuId"].map(
      (name) => `products[].${name}`,
    ),
  ]);
  const keys = new Set([
    "format",
    "evidence",
    "origin",
    "extensionId",
    "head",
    "digests",
    "cadenceMs",
    "cadenceSource",
    "startedAt",
    "finishedAt",
    "deadlineAt",
    "counts",
    "lookup",
    "list",
    "detail",
    "totalBytes",
    "requests",
    "failures",
    "selector",
    "identity",
    "searches",
    "searchRange",
    "filter",
    "surface",
    "key",
    "sortBy",
    "from",
    "pageSize",
    "before",
    "after",
    "count",
    "dateFilter",
    "sameSession",
    "topLevelKeys",
    "totalOrders",
    "rowCount",
    "distinctCount",
    "listStatuses",
    "oldestRowAgeBucket",
    "qualification",
    "reason",
    "vocabulary",
    "listStatus",
    "detailStatus",
    "refundStatus",
    "present",
    "type",
    "identityEquality",
    "requestIndex",
    "availability",
    "completeness",
    "consistency",
    "snapshot",
    "closedDateRange",
    "immutableTieBreaker",
    "terminalProof",
    "kind",
    "method",
    "host",
    "version",
    "pathTemplate",
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
    "fields",
    "field",
    "types",
    "omittedFields",
    ...packageFiles,
  ]);
  function visit(value, key = "", depth = 0) {
    if (depth > 12) fail("export_schema_refused");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return;
    if (typeof value === "string") {
      if (
        ["startedAt", "finishedAt", "deadlineAt"].includes(key) &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value))
      )
        return;
      if (key === "key" && value.length <= 64 && /^[A-Za-z]+(?:[ -]+[A-Za-z]+)*$/.test(value)) return;
      if (key === "topLevelKeys" && ["totalOrders", "orders"].includes(value)) return;
      if (key === "field" ? fields.has(value) : strings.has(value)) return;
      fail("export_schema_refused");
    }
    if (Array.isArray(value)) {
      if (value.length > 128) fail("export_schema_refused");
      value.forEach((item) => visit(item, key, depth + 1));
      return;
    }
    if (typeof value !== "object") fail("export_schema_refused");
    for (const [name, item] of Object.entries(value)) {
      if (!keys.has(name)) fail("export_schema_refused");
      visit(item, name, depth + 1);
    }
  }
  visit(receipt);
  function closed(value, names) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join() !== names.sort().join()
    )
      fail("export_schema_refused");
  }
  closed(receipt, [
    "format",
    "evidence",
    "origin",
    "extensionId",
    "head",
    "digests",
    "cadenceMs",
    "cadenceSource",
    "startedAt",
    "finishedAt",
    "deadlineAt",
    "counts",
    "totalBytes",
    "requests",
    "failures",
    "selector",
    "vocabulary",
    "completeness",
    "consistency",
  ]);
  closed(receipt.counts, ["lookup", "list", "detail"]);
  closed(receipt.consistency, ["snapshot", "closedDateRange", "immutableTieBreaker", "terminalProof"]);
  closed(receipt.selector, ["identity", "searches"]);
  if (
    receipt.selector.identity !== "tcgplayer-ready-to-ship-selector/v1" ||
    !Array.isArray(receipt.selector.searches) ||
    receipt.selector.searches.length > 2 ||
    !Array.isArray(receipt.vocabulary) ||
    receipt.vocabulary.length !== 4
  )
    fail("export_schema_refused");
  const buckets = ["Shipped - In Transit", "Shipped - Delivered", "Completed - Paid", "Canceled"];
  const status = (value, surface) => {
    closed(value, ["surface", "key"]);
    if (
      value.surface !== surface ||
      typeof value.key !== "string" ||
      value.key.length > 64 ||
      !/^[A-Za-z]+(?:[ -]+[A-Za-z]+)*$/.test(value.key)
    )
      fail("export_schema_refused");
  };
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
    status(search.filter, "search-filter");
    if (
      search.searchRange !== (index === 0 ? "LastTwoYears" : "LastThreeMonths") ||
      search.filter.key !== "ReadyToShip" ||
      !Array.isArray(search.sortBy) ||
      search.sortBy.length ||
      search.from !== 0 ||
      search.pageSize !== 500 ||
      typeof search.sameSession !== "boolean" ||
      !Array.isArray(search.topLevelKeys) ||
      search.topLevelKeys.some((key) => !["totalOrders", "orders"].includes(key)) ||
      !Array.isArray(search.listStatuses) ||
      !["qualified", "unknown"].includes(search.qualification)
    )
      fail("export_schema_refused");
    for (const bracket of [search.before, search.after]) {
      if (bracket === null && bracket === search.after) continue;
      closed(bracket, ["count", "dateFilter"]);
      if (
        !Number.isSafeInteger(bracket.count) ||
        bracket.count < 0 ||
        !["LastTwoYears", "LastThreeMonths"].includes(bracket.dateFilter)
      )
        fail("export_schema_refused");
    }
    for (const item of search.listStatuses) {
      closed(item, ["surface", "key", "count"]);
      status({ surface: item.surface, key: item.key }, "list-display");
      if (!Number.isSafeInteger(item.count) || item.count < 1 || item.count > 500) fail("export_schema_refused");
    }
    const request = receipt.requests.filter((item) => item.kind === "list")[index];
    if (
      search.qualification === "qualified" &&
      (request?.status !== 200 ||
        !request.responseComplete ||
        request.failure !== null ||
        search.topLevelKeys.slice().sort().join() !== "orders,totalOrders" ||
        search.reason !== "qualified" ||
        !search.sameSession ||
        search.totalOrders !== search.rowCount ||
        search.distinctCount !== search.rowCount ||
        search.totalOrders >= 500 ||
        search.before.count !== search.totalOrders ||
        search.after?.count !== search.totalOrders ||
        search.before.dateFilter !== search.after.dateFilter ||
        search.before.dateFilter !== search.searchRange ||
        search.listStatuses.some((item) => item.key !== "Ready to Ship") ||
        search.listStatuses.reduce((sum, item) => sum + item.count, 0) !== search.rowCount)
    )
      fail("export_schema_refused");
  }
  for (const [index, bucket] of receipt.vocabulary.entries()) {
    closed(bucket, [
      "listStatus",
      "detailStatus",
      "refundStatus",
      "identityEquality",
      "requestIndex",
      "availability",
      "qualification",
    ]);
    status(bucket.listStatus, "list-display");
    if (
      bucket.listStatus.key !== buckets[index] ||
      !["selected", "absent", "not-selected"].includes(bucket.availability) ||
      !["captured", "unqualified"].includes(bucket.qualification) ||
      ![null, true, false].includes(bucket.identityEquality)
    )
      fail("export_schema_refused");
    if (bucket.detailStatus !== null) status(bucket.detailStatus, "order-detail");
    if (bucket.refundStatus !== null) {
      closed(bucket.refundStatus, ["present", "type"]);
      if (
        typeof bucket.refundStatus.present !== "boolean" ||
        !["absent", "null", "array", "object", "string", "number", "boolean"].includes(bucket.refundStatus.type)
      )
        fail("export_schema_refused");
    }
    if (
      bucket.qualification === "captured" &&
      (bucket.availability !== "selected" ||
        bucket.identityEquality !== true ||
        bucket.detailStatus === null ||
        bucket.refundStatus === null ||
        !Number.isSafeInteger(bucket.requestIndex) ||
        receipt.requests[bucket.requestIndex]?.kind !== "detail" ||
        receipt.requests[bucket.requestIndex]?.status !== 200 ||
        !receipt.requests[bucket.requestIndex]?.responseComplete ||
        receipt.requests[bucket.requestIndex]?.failure !== null)
    )
      fail("export_schema_refused");
    if (
      bucket.availability !== "selected" &&
      (bucket.qualification !== "unqualified" ||
        bucket.detailStatus !== null ||
        bucket.identityEquality !== null ||
        bucket.refundStatus !== null ||
        bucket.requestIndex !== null)
    )
      fail("export_schema_refused");
  }
  if (
    !Array.isArray(receipt.failures) ||
    receipt.failures.some((code) => !strings.has(code)) ||
    Date.parse(receipt.deadlineAt) - Date.parse(receipt.startedAt) !== 900000
  )
    fail("export_schema_refused");
  if (
    receipt.format !== "order-authority-receipt/v2" ||
    receipt.head !== preparation.head ||
    receipt.extensionId !== preparation.extensionId ||
    receipt.evidence !== preparation.evidence ||
    receipt.origin !== "extension-service-worker" ||
    receipt.completeness !== "unknown" ||
    receipt.cadenceMs !== preparation.cadenceMs ||
    receipt.cadenceSource !== AUTHORITY ||
    !Array.isArray(receipt.requests) ||
    receipt.requests.length > 7 ||
    json(receipt.digests) !==
      json(
        Object.fromEntries(
          Object.entries(preparation.packageDigests).filter(([name]) => name !== "capture-config.json"),
        ),
      )
  ) {
    fail("export_schema_refused");
  }
  const counts = { lookup: 0, list: 0, detail: 0 };
  for (const request of receipt.requests) {
    closed(request, [
      "kind",
      "method",
      "host",
      "version",
      "pathTemplate",
      "startedAt",
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
    if (!Object.hasOwn(counts, request.kind)) fail("export_schema_refused");
    counts[request.kind] += 1;
    const lookup = request.kind === "lookup";
    const list = request.kind === "list";
    if (
      request.method !== (list ? "POST" : "GET") ||
      request.host !== (lookup ? "sp-api.tcgplayer.com" : "order-management-api.tcgplayer.com") ||
      request.version !== (lookup ? "1.0" : "2.0") ||
      request.pathTemplate !==
        (lookup ? "/account/auth-detail" : list ? "/orders/search" : "/orders/{encodedOrderNumber}") ||
      request.credentials !== "include" ||
      request.authorizationPresent !== false ||
      request.ceilingBytes !== (lookup ? 65536 : list ? 1048576 : 524288) ||
      typeof request.responseComplete !== "boolean" ||
      typeof request.nearCeiling !== "boolean" ||
      !Number.isSafeInteger(request.requestBytes) ||
      request.requestBytes > 8192 ||
      (request.status !== null && (!Number.isSafeInteger(request.status) || request.status > 599))
    )
      fail("export_schema_refused");
    if (request.shape !== null) {
      closed(request.shape, ["fields", "omittedFields"]);
      if (!request.responseComplete || !Array.isArray(request.shape.fields)) fail("export_schema_refused");
      for (const field of request.shape.fields) {
        closed(field, ["field", "types"]);
        if (
          !fields.has(field.field) ||
          !Array.isArray(field.types) ||
          field.types.some((type) => !["string", "number", "boolean", "object", "array", "null"].includes(type))
        )
          fail("export_schema_refused");
      }
    }
  }
  for (const kind of Object.keys(counts)) {
    if (
      !Number.isSafeInteger(receipt.counts[kind]) ||
      receipt.counts[kind] < counts[kind] ||
      receipt.counts[kind] > { lookup: 1, list: 2, detail: 4 }[kind]
    )
      fail("export_schema_refused");
  }
}

export function verifyExport(out) {
  const preparation = verifyPackage(out);
  const directory = path.join(out, "receipt");
  const files = inventory(directory);
  if (Object.keys(files).join() !== "8838-inventory.json,8838-receipt.json") fail("inventory_mismatch");
  for (const file of Object.keys(files))
    if (lstatSync(path.join(directory, file)).size > 65536) fail("export_schema_refused");
  const receipt = readJson(path.join(directory, "8838-receipt.json"));
  assertReceipt(receipt, preparation);
  const index = readJson(path.join(directory, "8838-inventory.json"));
  const pending = { extensionAbsent: false, profileDisposed: false, confirmation: "pending-operator-removal" };
  const removed = {
    extensionAbsent: true,
    profileDisposed: true,
    confirmation: "operator-attested-extension-absence-and-profile-disposal",
  };
  if (json(index.removal) !== json(pending) && json(index.removal) !== json(removed)) fail("removal_not_confirmed");
  const expected = {
    format: "order-authority-inventory/v2",
    evidence: preparation.evidence,
    head: preparation.head,
    extensionId: preparation.extensionId,
    files: { "8838-receipt.json": files["8838-receipt.json"] },
    packageDigests: receipt.digests,
    removal: index.removal,
    retainedFiles: ["8838-receipt.json", "8838-inventory.json"],
  };
  if (json(index) !== json(expected)) fail("export_schema_refused");
  return index;
}

export function recordRemoval(out, extensionAbsent) {
  const index = verifyExport(out);
  if (extensionAbsent !== true || existsSync(path.join(out, "profile"))) fail("removal_not_confirmed");
  index.removal = {
    extensionAbsent: true,
    profileDisposed: true,
    confirmation: "operator-attested-extension-absence-and-profile-disposal",
  };
  writeFileSync(path.join(out, "receipt", "8838-inventory.json"), json(index));
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const flags = new Map();
    for (let index = 0; index < args.length; index += 1) {
      const key = args[index];
      if (
        flags.has(key) ||
        ![
          "--out",
          "--cadence-ms",
          "--cadence-source",
          "--verify",
          "--verify-export",
          "--record-removal",
          "--extension-absent",
        ].includes(key)
      )
        fail("invalid_arguments");
      flags.set(key, ["--out", "--cadence-ms", "--cadence-source"].includes(key) ? args[++index] : true);
    }
    const out = flags.get("--out");
    if (flags.has("--record-removal")) recordRemoval(out, flags.get("--extension-absent"));
    else if (flags.has("--verify-export")) verifyExport(out);
    else if (flags.has("--verify")) verifyPackage(out);
    else prepare({ out, cadenceMs: Number(flags.get("--cadence-ms")), cadenceSource: flags.get("--cadence-source") });
    console.log("order-authority: completed; qualification remains host-owned");
  } catch {
    console.error("order-authority: refused; check authority, inventory, destination and removal requirements");
    process.exitCode = 1;
  }
}
