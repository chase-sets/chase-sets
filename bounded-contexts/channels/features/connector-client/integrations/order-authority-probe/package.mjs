import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(source, "../../../../../..");
export const AUTHORITY = "https://github.com/chase-sets/chase-sets/issues/7791#issuecomment-5621442291";
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
  if (!Number.isSafeInteger(cadenceMs) || cadenceMs <= 0 || cadenceSource !== AUTHORITY) fail("authority_missing");
  if (typeof out !== "string" || !path.isAbsolute(out) || path.resolve(out) !== out)
    fail("absolute_run_directory_required");
  assertRealDirectory(out);
  if (existsSync(out)) fail("new_run_directory_required");
  const parent = path.resolve("D:/Users/ToddS/Source/Repos/chase-sets/.orchestrator/artifacts/8607");
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
    format: "order-authority-package/v1",
    head,
    cadenceMs,
    cadenceSource,
    extensionId: id,
    evidence: synthetic ? "synthetic" : "operator",
    files: inventory(packageDirectory),
  };
  writeFileSync(path.join(packageDirectory, "capture-config.json"), json(config), { flag: "wx" });
  const preparation = {
    format: "order-authority-preparation/v1",
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
      "receipt/8607-receipt.json",
      "receipt/8607-inventory.json",
    ],
    qualification: "PENDING_HOST_VERIFIER",
  };
  const cli = path.join(source, "package.mjs");
  const runbook = `# One isolated order authority capture for #8607

Evidence mode: ${config.evidence}. Head: ${head}. Extension: ${id}.
Cadence: ${cadenceMs} ms, host binding from ${cadenceSource}.
This value is not inferred by this package. Synthetic preparation is never live authority.
Do not relay until the host has exact-head review and attributed hermetic/browser-origin controls.
This preparation itself is PENDING_HOST_VERIFIER, not a qualification PASS.

1. Host verifies the complete emitted inventory, including manifest/worker/helper digests:
   node "${cli}" --verify --out "${out}"
   Refuse missing/tampered files, profile/origin mismatch, or missing controls. No provider requests occur in preparation or verification.
2. Host supplies this exact PowerShell command to open only the newly created profile:
   ${preparation.launchCommand}
   Never use work/Pokebash TCG or sign in/out of a shared profile. Todd signs into the approved seller session himself; no cookie/credential copying/import, HAR, trace, screenshots or raw network recording.
3. In that profile only, open chrome://extensions, enable Developer mode, Load unpacked:
   ${packageDirectory}
   Confirm extension ID ${id}. Open ${preparation.captureUrl}.
   In that helper's console invoke only: await orderAuthorityCapture.run()
   No arguments. Consent and one known order are browser-native prompts, never console/URL input.
   Consent and order input complete before begin; cancel or blank input sends nothing and creates no export.
   The worker counts and latches before dispatch. The 15-minute deadline starts at begin, after both prompts have completed.
   Installation, opening and reloading make no provider request. After begin, reopens/restarts never authorize another run.
4. Save exactly 8607-receipt.json and 8607-inventory.json under:
   ${receiptDirectory}
   Only the worker fetches: one session lookup, one first-page search, one selected-order detail. No retries, pagination or undocumented discovery.
   Stop on authority/session/custody failure, unexpected request, redirect/login, 401/403/429, deadline, canceled prompt, or repeat. Do not borrow a session or reinstall to retry.
   Operational ceilings (not provider-size authority): request 8 KiB; lookup 64 KiB; list 1 MiB at size 25; detail 512 KiB; session 8 MiB; request wall time 30 s.
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
   Retain only the inventory-listed package, preparation/runbook and two scrubbed exports. The inventory does not recursively hash itself. Live removal belongs to #8607.
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
    config.extensionId !== extensionId(manifest.key) ||
    preparation.extensionId !== config.extensionId ||
    config.head !== preparation.head ||
    !/^[a-f0-9]{40}$/.test(config.head) ||
    config.cadenceMs !== preparation.cadenceMs ||
    !Number.isSafeInteger(config.cadenceMs) ||
    config.cadenceMs <= 0 ||
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
    "order-authority-receipt/v1",
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
    "SYNTHETIC/order ?#",
    "SYNTHETIC%2Forder%20%3F%23",
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
    "listDetailEquality",
    "completeness",
    "consistency",
    "snapshot",
    "closedDateRange",
    "immutableTieBreaker",
    "terminalProof",
    "syntheticEncodingExample",
    "input",
    "encoded",
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
    "listDetailEquality",
    "completeness",
    "consistency",
    "syntheticEncodingExample",
  ]);
  closed(receipt.counts, ["lookup", "list", "detail"]);
  closed(receipt.consistency, ["snapshot", "closedDateRange", "immutableTieBreaker", "terminalProof"]);
  closed(receipt.syntheticEncodingExample, ["input", "encoded"]);
  if (
    !Array.isArray(receipt.failures) ||
    receipt.failures.some((code) => !strings.has(code)) ||
    ![null, true, false].includes(receipt.listDetailEquality) ||
    Date.parse(receipt.deadlineAt) - Date.parse(receipt.startedAt) !== 900000
  )
    fail("export_schema_refused");
  if (
    receipt.format !== "order-authority-receipt/v1" ||
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
      receipt.counts[kind] > (kind === "lookup" ? 1 : 3)
    )
      fail("export_schema_refused");
  }
}

export function verifyExport(out) {
  const preparation = verifyPackage(out);
  const directory = path.join(out, "receipt");
  const files = inventory(directory);
  if (Object.keys(files).join() !== "8607-inventory.json,8607-receipt.json") fail("inventory_mismatch");
  for (const file of Object.keys(files))
    if (lstatSync(path.join(directory, file)).size > 65536) fail("export_schema_refused");
  const receipt = readJson(path.join(directory, "8607-receipt.json"));
  assertReceipt(receipt, preparation);
  const index = readJson(path.join(directory, "8607-inventory.json"));
  const pending = { extensionAbsent: false, profileDisposed: false, confirmation: "pending-operator-removal" };
  const removed = {
    extensionAbsent: true,
    profileDisposed: true,
    confirmation: "operator-attested-extension-absence-and-profile-disposal",
  };
  if (json(index.removal) !== json(pending) && json(index.removal) !== json(removed)) fail("removal_not_confirmed");
  const expected = {
    format: "order-authority-inventory/v1",
    evidence: preparation.evidence,
    head: preparation.head,
    extensionId: preparation.extensionId,
    files: { "8607-receipt.json": files["8607-receipt.json"] },
    packageDigests: receipt.digests,
    removal: index.removal,
    retainedFiles: ["8607-receipt.json", "8607-inventory.json"],
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
  writeFileSync(path.join(out, "receipt", "8607-inventory.json"), json(index));
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
