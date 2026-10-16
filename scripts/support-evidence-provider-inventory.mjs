import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const PREFIX = "support-evidence/";
const HASH = /^[a-f0-9]{64}$/;
const KEY = /^support-evidence\/([a-zA-Z0-9_-]+)\/(sea_[a-zA-Z0-9]+)\/([a-f0-9]{64})\.(jpg|png|webp)$/;
const CLASSES = ["legacy-referenced", "operation-owned", "candidate-orphan", "non-conforming"];
const MODES = ["dry-run", "delete", "synthetic-probe"];
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
export const manifestDigest = (manifest) => createHash("sha256").update(canonical(manifest)).digest("hex");
const fail = () => { throw new Error("support-evidence-inventory-refused"); };
const closed = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const opaqueReceipt = (value) => value === null || (typeof value === "string" && HASH.test(value));

export function inventoryOptions(env = process.env) {
  const get = (name) => env[`SUPPORT_EVIDENCE_INVENTORY_${name}`];
  const options = {
    environment: get("ENVIRONMENT"), implementationSha: get("IMPLEMENTATION_SHA"), imageDigest: get("IMAGE_DIGEST"),
    boundaryReceiptId: get("BOUNDARY_RECEIPT_ID") || null, snapshotReceiptId: get("SNAPSHOT_RECEIPT_ID") || null,
    horizon: get("HORIZON") || null, requestCap: Number(get("REQUEST_CAP")),
    requestCostUpperBoundUsd: Number(get("REQUEST_COST_UPPER_BOUND_USD")),
  };
  if (!["development", "test", "staging", "production"].includes(options.environment) ||
    !/^[a-f0-9]{40}$/.test(options.implementationSha ?? "") || !/^sha256:[a-f0-9]{64}$/.test(options.imageDigest ?? "") ||
    !opaqueReceipt(options.boundaryReceiptId) || !opaqueReceipt(options.snapshotReceiptId) ||
    (options.horizon !== null && !/^(0|[1-9]\d*)$/.test(options.horizon)) ||
    !integer(options.requestCap, 1) || !Number.isFinite(options.requestCostUpperBoundUsd) || options.requestCostUpperBoundUsd <= 0 ||
    options.requestCap * options.requestCostUpperBoundUsd > 15) fail();
  return options;
}

function validBinding(value) {
  return ["development", "test", "staging", "production"].includes(value.environment) &&
    typeof value.implementationSha === "string" && /^[a-f0-9]{40}$/.test(value.implementationSha) &&
    typeof value.imageDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.imageDigest) &&
    typeof value.horizon === "string" && /^(0|[1-9]\d*)$/.test(value.horizon) && opaqueReceipt(value.boundaryReceiptId) && opaqueReceipt(value.snapshotReceiptId);
}

export function validManifest(value) {
  return closed(value, ["schema", "environment", "implementationSha", "imageDigest", "horizon", "boundaryReceiptId", "snapshotReceiptId",
    "referenceDigest", "requestCap", "requestCostUpperBoundUsd", "pages", "completeness", "objects"]) &&
    value.schema === "support-evidence-inventory/v1" && validBinding(value) && HASH.test(value.referenceDigest) &&
    integer(value.requestCap, 1) && Number.isFinite(value.requestCostUpperBoundUsd) && value.requestCostUpperBoundUsd > 0 &&
    value.requestCap * value.requestCostUpperBoundUsd <= 15 && integer(value.pages) && value.pages <= value.requestCap &&
    ["complete", "incomplete"].includes(value.completeness) && Array.isArray(value.objects) &&
    value.objects.every((object) => closed(object, ["key", "byteSize", "classification"]) &&
      typeof object.key === "string" && object.key.startsWith(PREFIX) && integer(object.byteSize) && CLASSES.includes(object.classification)) &&
    new Set(value.objects.map((object) => object.key)).size === value.objects.length;
}

export function validReceipt(value) {
  return closed(value, ["schema", "mode", "environment", "implementationSha", "imageDigest", "horizon", "boundaryReceiptId", "snapshotReceiptId",
    "pages", "objects", "candidates", "completeness", "manifestDigest", "result", "deleted", "failed", "requestCap", "requestCostUpperBoundUsd"]) &&
    value.schema === "support-evidence-receipt/v1" && MODES.includes(value.mode) && validBinding(value) &&
    [value.pages, value.objects, value.candidates, value.deleted, value.failed].every((number) => integer(number)) &&
    ["complete", "incomplete"].includes(value.completeness) && HASH.test(value.manifestDigest) &&
    ["retention", "approval-required", "deleted", "probe-passed"].includes(value.result) &&
    integer(value.requestCap, 1) && Number.isFinite(value.requestCostUpperBoundUsd) && value.requestCostUpperBoundUsd > 0 && value.requestCap * value.requestCostUpperBoundUsd <= 15;
}

function receipt(mode, manifest, result, counts = {}) {
  const value = {
    schema: "support-evidence-receipt/v1", mode, environment: manifest.environment, implementationSha: manifest.implementationSha,
    imageDigest: manifest.imageDigest, horizon: manifest.horizon, boundaryReceiptId: manifest.boundaryReceiptId,
    snapshotReceiptId: manifest.snapshotReceiptId, pages: manifest.pages, objects: manifest.objects.length,
    candidates: manifest.objects.filter((object) => object.classification === "candidate-orphan").length,
    completeness: manifest.completeness, manifestDigest: manifestDigest(manifest), result,
    deleted: counts.deleted ?? 0, failed: counts.failed ?? 0, requestCap: manifest.requestCap,
    requestCostUpperBoundUsd: manifest.requestCostUpperBoundUsd,
  };
  if (!validReceipt(value)) fail();
  return value;
}

function budget(options) {
  let requests = 0;
  return async (action) => {
    if (requests >= options.requestCap) fail();
    requests++;
    return action();
  };
}

async function listAll(storage, request, prefix = PREFIX, maxKeys = 1000) {
  const entries = [];
  const tokens = new Set();
  const keys = new Set();
  let token;
  let pages = 0;
  try {
    for (;;) {
      const page = await request(() => storage.listPrivate({ prefix, continuationToken: token, maxKeys }));
      pages++;
      if (page.status !== "page" || !Array.isArray(page.entries) || page.entries.length > maxKeys) fail();
      for (const entry of page.entries) {
        if (typeof entry.key !== "string" || !entry.key.startsWith(prefix) || !integer(entry.byteSize) || keys.has(entry.key)) fail();
        keys.add(entry.key);
        entries.push({ key: entry.key, byteSize: entry.byteSize });
      }
      if (page.nextContinuationToken === null) break;
      if (typeof page.nextContinuationToken !== "string" || !page.nextContinuationToken || tokens.has(page.nextContinuationToken)) fail();
      tokens.add(page.nextContinuationToken);
      token = page.nextContinuationToken;
    }
    return { complete: true, pages, entries: entries.sort((a, b) => a.key.localeCompare(b.key, "en")) };
  } catch { return { complete: false, pages, entries }; }
}

function classify(entry, authority) {
  const match = KEY.exec(entry.key);
  const classification = authority.operationKeys.includes(entry.key) ? "operation-owned"
    : authority.references.includes(entry.key) ? "legacy-referenced"
      : match && match[2].length === 30 ? "candidate-orphan" : "non-conforming";
  return { ...entry, classification };
}

export async function dryRun({ storage, legacy, options }) {
  const request = budget(options);
  const authority = await legacy.reconstruct(options.horizon ? { horizon: options.horizon } : {});
  const first = await listAll(storage, request);
  const second = await listAll(storage, request);
  const current = await legacy.reconstruct();
  // Two identical traversals detect drift, but only the separately supplied snapshot receipt is authority.
  const complete = authority.status === "complete" && current.status === "complete" && authority.digest === current.digest &&
    first.complete && second.complete && canonical(first.entries) === canonical(second.entries) &&
    options.boundaryReceiptId !== null && options.snapshotReceiptId !== null;
  const manifest = {
    schema: "support-evidence-inventory/v1", ...options, horizon: authority.horizon,
    referenceDigest: authority.digest, pages: first.pages + second.pages, completeness: complete ? "complete" : "incomplete",
    objects: first.entries.map((entry) => classify(entry, authority)),
  };
  if (!validManifest(manifest)) fail();
  return { manifest, receipt: receipt("dry-run", manifest, complete ? "approval-required" : "retention") };
}

function normalizeOutcomes(keys, outcomes) {
  return keys.map((key) => {
    const matches = Array.isArray(outcomes) ? outcomes.filter((outcome) => outcome.key === key) : [];
    return { key, status: matches.length === 1 && ["deleted", "absent"].includes(matches[0].status) ? matches[0].status : "failed" };
  });
}

export async function deleteApproved({ storage, legacy, options, manifest, approvedDigest, persistOutcomes }) {
  if (!validManifest(manifest)) fail();
  const digest = manifestDigest(manifest);
  const outcomes = [];
  const retained = () => ({ outcomes, receipt: receipt("delete", manifest, "retention", {
    deleted: outcomes.filter((outcome) => outcome.status !== "failed").length, failed: outcomes.filter((outcome) => outcome.status === "failed").length,
  }) });
  if (approvedDigest !== digest) return retained();
  if (["environment", "implementationSha", "imageDigest", "horizon", "boundaryReceiptId", "snapshotReceiptId"].some((field) => options[field] !== manifest[field])) return retained();
  if (manifest.completeness !== "complete" || !options.boundaryReceiptId || !options.snapshotReceiptId) return retained();
  const original = await legacy.reconstruct({ horizon: manifest.horizon });
  if (original.status !== "complete" || original.digest !== manifest.referenceDigest) return retained();
  // Reclassification prevents a forged or stale class from becoming deletion authority.
  if (manifest.objects.some((object) => classify({ key: object.key, byteSize: object.byteSize }, original).classification !== object.classification)) return retained();
  const candidates = manifest.objects.filter((object) => object.classification === "candidate-orphan");
  const request = budget(options);
  for (let offset = 0; offset < candidates.length; offset += 100) {
    if (manifestDigest(manifest) !== digest) return retained();
    const current = await legacy.reconstruct();
    if (current.status !== "complete" || current.digest !== manifest.referenceDigest) return retained();
    const listing = await listAll(storage, request);
    const deleted = new Set(outcomes.filter((outcome) => outcome.status !== "failed").map((outcome) => outcome.key));
    const expected = manifest.objects.filter((object) => !deleted.has(object.key)).map(({ key, byteSize }) => ({ key, byteSize }));
    if (!listing.complete || canonical(listing.entries) !== canonical(expected)) return retained();
    const keys = candidates.slice(offset, offset + 100).map((object) => object.key);
    if (!await legacy.claim({ manifestDigest: digest, horizon: manifest.horizon, keys, referenceDigest: manifest.referenceDigest })) return retained();
    let batch;
    try { batch = normalizeOutcomes(keys, await request(() => storage.deleteKeys(keys))); }
    catch { batch = normalizeOutcomes(keys, null); }
    outcomes.push(...batch);
    // Journal and durable event must both settle before another batch can be admitted.
    try {
      await persistOutcomes(batch);
      await legacy.recordOutcomes({ manifestDigest: digest, outcomes: batch });
    } catch { return retained(); }
    if (batch.some((outcome) => outcome.status === "failed")) return retained();
  }
  return { outcomes, receipt: receipt("delete", manifest, "deleted", { deleted: outcomes.length }) };
}

export async function syntheticProbe({ storage, options, runId, prefix = `support-evidence/synthetic-probe-${runId}/`, anonymousGet, objectUrl }) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(runId) || prefix !== `support-evidence/synthetic-probe-${runId}/`) fail();
  const request = budget(options);
  const body = Buffer.from("support-evidence-synthetic-probe/v1");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const contentType = "image/png";
  const keys = [0, 1, 2].map((index) => `${prefix}${index}.png`);
  let passed = false;
  let pages = 0;
  let outcomes = [];
  try {
    for (const key of keys) {
      const input = { key, body, contentType, deadlineMs: 30_000 };
      if ((await request(() => storage.putPrivate(input))).status !== "completed") fail();
      const read = await request(() => storage.readPrivate(key, { maxBytes: body.length, deadlineMs: 30_000 }));
      if (read.status !== "found" || read.byteSize !== body.length || read.body.byteLength !== body.length ||
        read.providerContentType !== contentType || createHash("sha256").update(read.body).digest("hex") !== sha256) fail();
      if ((await request(() => storage.putPrivate(input))).status !== "completed") fail();
      const retry = await request(() => storage.readPrivate(key, { maxBytes: body.length, deadlineMs: 30_000 }));
      if (retry.status !== "found" || retry.byteSize !== body.length || retry.providerContentType !== contentType ||
        createHash("sha256").update(retry.body).digest("hex") !== sha256) fail();
      const response = await request(() => anonymousGet(objectUrl(key)));
      if (![401, 403].includes(response.status)) fail();
    }
    const listing = await listAll(storage, request, prefix, 1);
    pages = listing.pages;
    if (!listing.complete || pages < 2 || canonical(listing.entries.map((entry) => entry.key).sort()) !== canonical([...keys].sort())) fail();
    passed = true;
  } catch { passed = false; }
  finally {
    try { outcomes = normalizeOutcomes(keys, await request(() => storage.deleteKeys(keys))); }
    catch { outcomes = normalizeOutcomes(keys, null); }
  }
  passed &&= outcomes.every((outcome) => outcome.status !== "failed");
  const manifest = { schema: "support-evidence-inventory/v1", ...options, horizon: options.horizon ?? "0", referenceDigest: manifestDigest([]),
    pages, completeness: passed ? "complete" : "incomplete", objects: keys.map((key) => ({ key, byteSize: body.length, classification: "non-conforming" })) };
  return { outcomes, receipt: receipt("synthetic-probe", manifest, passed ? "probe-passed" : "retention", {
    deleted: outcomes.filter((outcome) => outcome.status !== "failed").length, failed: outcomes.filter((outcome) => outcome.status === "failed").length,
  }) };
}

async function writePrivate(file, value) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(`${canonical(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

export async function runInventoryCli(env = process.env, compose = composeInventory) {
  const options = inventoryOptions(env);
  const get = (name) => env[`SUPPORT_EVIDENCE_INVENTORY_${name}`];
  const mode = get("MODE");
  if (!MODES.includes(mode) || !get("RECEIPT_PATH") || !get("MANIFEST_PATH") || get("RECEIPT_PATH") === get("MANIFEST_PATH")) fail();
  const deps = await compose(env, mode);
  try {
    let result;
    if (mode === "dry-run") {
      result = await dryRun({ ...deps, options });
      await writePrivate(get("MANIFEST_PATH"), result.manifest);
    } else if (mode === "delete") {
      const manifest = JSON.parse(await readFile(get("MANIFEST_PATH"), "utf8"));
      const journal = await open(get("OUTCOMES_PATH"), "wx", 0o600);
      try {
        result = await deleteApproved({ ...deps, options, manifest, approvedDigest: env.SUPPORT_EVIDENCE_APPROVED_MANIFEST_SHA256,
          persistOutcomes: async (batch) => { await journal.writeFile(`${canonical(batch)}\n`); await journal.sync(); } });
      } finally { await journal.close(); }
    } else {
      result = await syntheticProbe({ ...deps, options, runId: get("RUN_ID"), ...(get("PREFIX") ? { prefix: get("PREFIX") } : {}) });
      await writePrivate(get("MANIFEST_PATH"), result.outcomes);
    }
    await writePrivate(get("RECEIPT_PATH"), result.receipt);
    return result.receipt;
  } finally { await deps.close(); }
}

async function composeInventory(env, mode) {
  const get = (name) => env[`SUPPORT_EVIDENCE_INVENTORY_${name}`];
  // Explicit credentials only: never fall through to an inherited SDK or libpq credential chain.
  for (const name of ["BUCKET", "REGION", "ENDPOINT", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"]) if (!get(name)) fail();
  const endpoint = new URL(get("ENDPOINT"));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) fail();
  const { tsImport } = await import("tsx/esm/api");
  const { createS3PrivateObjectStore } = await tsImport("../infrastructure/object-storage/private-object-store.ts", import.meta.url);
  const requireStorage = createRequire(new URL("../infrastructure/object-storage/index.ts", import.meta.url));
  const { S3Client } = requireStorage("@aws-sdk/client-s3");
  const client = new S3Client({ endpoint: endpoint.href, region: get("REGION"), forcePathStyle: true,
    credentials: { accessKeyId: get("ACCESS_KEY_ID"), secretAccessKey: get("SECRET_ACCESS_KEY") }, maxAttempts: 1 });
  const storage = createS3PrivateObjectStore({ bucket: get("BUCKET"), client });
  let pool;
  try {
    let legacy;
    if (mode !== "synthetic-probe") {
      if (!get("DATABASE_URL")) fail();
      const { default: pg } = await import("pg");
      pool = new pg.Pool({ connectionString: get("DATABASE_URL"), max: 1 });
      const { createPlatformOperationsServices } = await tsImport("../bounded-contexts/platform-operations/support/runtime-support/services.ts", import.meta.url);
      legacy = createPlatformOperationsServices(pool).supportEvidenceLegacy;
    }
    return { storage, legacy,
      objectUrl: (key) => `${endpoint.origin}/${encodeURIComponent(get("BUCKET"))}/${key.split("/").map(encodeURIComponent).join("/")}`,
      anonymousGet: async (url) => {
        const response = await fetch(url, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(30_000) });
        await response.body?.cancel();
        return { status: response.status };
      },
      close: async () => { client.destroy(); await pool?.end(); },
    };
  } catch { client.destroy(); await pool?.end(); fail(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInventoryCli().then((value) => { process.exitCode = value.result === "retention" ? 2 : 0; })
    .catch(() => { process.stderr.write("Support evidence inventory refused; retain indefinitely.\n"); process.exitCode = 2; });
}
