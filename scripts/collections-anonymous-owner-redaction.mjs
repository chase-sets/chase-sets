#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const kinds = ["serving", "suspended", "dormant", "rollback", "job", "cronjob", "session"];
const modes = ["dry-run", "activate", "redact", "verify"];
const targets = ["staging", "production"];
const floorPath = "bounded-contexts/collections/support/runtime-support/anonymous-owner-activation.ts";
const packetKeys = [
  "schemaVersion",
  "target",
  "capturedAt",
  "floorCommit",
  "dbIdentityDigest",
  "schemaLedger",
  "inventory",
  "writers",
];
const gateKeys = [
  "defaultBranch",
  "target",
  "approval",
  "packet",
  "freshness",
  "floor",
  "writers",
  "inventory",
  "database",
  "schema",
  "fence",
  "activation",
];
const receiptKeys = [
  "format",
  "mode",
  "target",
  "dbIdentityDigest",
  "schemaVersion",
  "schemaLedger",
  "floorCommit",
  "packetSha256",
  "packetText",
  "packet",
  "deployedRevisions",
  "activation",
  "fencePresent",
  "gates",
  "before",
  "processed",
  "after",
  "mismatches",
  "legacyRemaining",
  "startedAt",
  "endedAt",
  "durationMs",
  "codes",
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const isSha = (value, size) => typeof value === "string" && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (value, expected) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  same(Object.keys(value).sort(), [...expected].sort());
const utc = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
class CutoverRefusal extends Error {}
function guard(condition, code) {
  if (!condition) throw new CutoverRefusal(code);
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  }).trim();
}

export function deriveFloor(root) {
  try {
    guard(git(root, "rev-parse", "--is-shallow-repository") === "false", "floor-ambiguous");
    git(root, "cat-file", "-e", `HEAD:${floorPath}`);
    const matches = git(root, "log", "--first-parent", "--diff-filter=A", "--format=%H", "HEAD", "--", floorPath)
      .split("\n")
      .filter(Boolean);
    guard(matches.length === 1 && isSha(matches[0], 40), "floor-ambiguous");
    return matches[0];
  } catch {
    throw new CutoverRefusal("floor-ambiguous");
  }
}

function containsFloor(root, floor, revision) {
  try {
    git(root, "merge-base", "--is-ancestor", floor, revision);
    return true;
  } catch {
    return false;
  }
}

export function databaseIdentityDigest(target, databaseUrl) {
  try {
    guard(targets.includes(target) && typeof databaseUrl === "string" && databaseUrl.length > 0, "database-authority");
    const url = new URL(databaseUrl);
    guard(
      ["postgres:", "postgresql:"].includes(url.protocol) && url.hostname && url.pathname.length > 1,
      "database-authority",
    );
    return sha(
      JSON.stringify([
        "collections-db-identity/v1",
        target,
        url.hostname.toLowerCase(),
        url.port || "5432",
        decodeURIComponent(url.pathname.slice(1)),
      ]),
    );
  } catch {
    throw new CutoverRefusal("database-authority");
  }
}

function packetShape(packet, startedAt) {
  guard(keys(packet, packetKeys), "packet-keys");
  guard(packet.schemaVersion === "collections-cutover-gate/v1", "packet-schema");
  guard(targets.includes(packet.target), "target-mismatch");
  guard(
    utc(packet.capturedAt) &&
      utc(startedAt) &&
      Date.parse(packet.capturedAt) <= Date.parse(startedAt) &&
      Date.parse(startedAt) - Date.parse(packet.capturedAt) <= 30 * 60_000,
    "packet-stale",
  );
  guard(isSha(packet.floorCommit, 40), "floor-mismatch");
  guard(isSha(packet.dbIdentityDigest, 64), "db-identity");
  guard(
    Array.isArray(packet.schemaLedger) &&
      packet.schemaLedger.length > 0 &&
      packet.schemaLedger.every((id) => typeof id === "string" && /^[a-z0-9_]+$/.test(id)) &&
      same(packet.schemaLedger, [...new Set(packet.schemaLedger)].sort()) &&
      packet.schemaLedger.includes("20261016_collections_anonymous_owner_activation"),
    "schema-ledger",
  );
  guard(keys(packet.writers, kinds), "writer-keys");
  guard(keys(packet.inventory, ["collected", "authoritativeTotal"]), "inventory-incomplete");
  const ids = new Set();
  let collected = 0;
  for (const kind of kinds) {
    guard(Array.isArray(packet.writers[kind]), "writer-keys");
    for (const writer of packet.writers[kind]) {
      guard(keys(writer, ["id", "state", "revision"]), "writer-keys");
      guard(
        typeof writer.id === "string" && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(writer.id) && !ids.has(writer.id),
        "writer-keys",
      );
      ids.add(writer.id);
      collected++;
      guard(["deployed", "retired", "terminated"].includes(writer.state), "writer-unknown");
      guard(
        writer.state === "deployed"
          ? isSha(writer.revision, 40)
          : writer.revision === null || isSha(writer.revision, 40),
        "writer-floor",
      );
    }
  }
  guard(
    integer(packet.inventory.collected) &&
      integer(packet.inventory.authoritativeTotal) &&
      collected === packet.inventory.collected &&
      collected === packet.inventory.authoritativeTotal,
    "inventory-incomplete",
  );
}

export function validatePacket(options, snapshot, floor) {
  guard(
    typeof options.packetText === "string" && Buffer.byteLength(options.packetText, "utf8") <= 16 * 1024,
    "packet-size",
  );
  guard(isSha(options.packetSha256, 64) && sha(options.packetText) === options.packetSha256, "packet-digest");
  let packet;
  try {
    packet = JSON.parse(options.packetText);
  } catch {
    throw new CutoverRefusal("packet-json");
  }
  packetShape(packet, options.startedAt);
  guard(packet.target === options.target, "target-mismatch");
  guard(packet.floorCommit === floor, "floor-mismatch");
  guard(packet.dbIdentityDigest === databaseIdentityDigest(options.target, options.databaseUrl), "db-identity");
  guard(same(packet.schemaLedger, snapshot.schemaLedger), "schema-ledger");
  guard(snapshot.fencePresent === true, "fence-required");
  const revisions = new Set(
    kinds.flatMap((kind) =>
      packet.writers[kind].filter((writer) => writer.state === "deployed").map((writer) => writer.revision),
    ),
  );
  for (const revision of revisions) guard(containsFloor(options.root, floor, revision), "writer-floor");
  return packet;
}

function binding(options) {
  guard(modes.includes(options.mode) && options.mode !== "verify", "mode-invalid");
  guard(targets.includes(options.target) && options.target === options.jobEnvironment, "target-mismatch");
  guard(
    typeof options.defaultBranch === "string" &&
      /^[a-zA-Z0-9_./-]+$/.test(options.defaultBranch) &&
      options.ref === `refs/heads/${options.defaultBranch}`,
    "default-branch",
  );
  guard(
    options.mode === "dry-run" ||
      (typeof options.approvalReference === "string" && options.approvalReference.trim().length > 0),
    "approval-required",
  );
  databaseIdentityDigest(options.target, options.databaseUrl);
}

export async function runRedaction(options, dependencies) {
  binding(options);
  const floor = deriveFloor(options.root);
  let packet;
  let dryRunRefusal;
  let result = await dependencies.redact(dependencies.pool, {
    dryRun: options.mode !== "redact",
    authorize: (snapshot) => {
      try {
        packet = validatePacket(options, snapshot, floor);
        guard(
          snapshot.activation.activated_at === null || snapshot.activation.floor_commit === floor,
          "activation-floor",
        );
        guard(options.mode !== "redact" || Boolean(snapshot.activation.activated_at), "activation-required");
      } catch (error) {
        if (options.mode !== "dry-run" || !(error instanceof CutoverRefusal)) throw error;
        packet = undefined;
        dryRunRefusal = error.message;
      }
    },
  });
  guard(packet !== undefined || dryRunRefusal !== undefined, "authorization-not-executed");
  if (options.mode === "activate") {
    await dependencies.activate(dependencies.pool, { gatePacketSha256: options.packetSha256, floorCommit: floor });
    result = await dependencies.redact(dependencies.pool, { dryRun: true });
  }
  const endedAt = new Date().toISOString();
  return {
    format: "collections-privacy-cutover-receipt/v1",
    mode: options.mode,
    target: options.target,
    dbIdentityDigest: databaseIdentityDigest(options.target, options.databaseUrl),
    schemaVersion: sha(JSON.stringify(result.schemaLedger)),
    schemaLedger: result.schemaLedger,
    floorCommit: floor,
    packetSha256: packet ? options.packetSha256 : null,
    packet: packet ?? null,
    packetText: packet ? options.packetText : null,
    deployedRevisions: packet?.writers ?? null,
    activation: {
      ...result.activation,
      activated_at:
        result.activation.activated_at === null ? null : new Date(result.activation.activated_at).toISOString(),
    },
    fencePresent: result.fencePresent,
    gates: Object.fromEntries(
      gateKeys.map((gate) => [
        gate,
        Boolean(packet) && (gate !== "activation" || Boolean(result.activation.activated_at)),
      ]),
    ),
    before: result.before,
    processed: result.processed,
    after: result.after,
    mismatches: result.mismatches,
    legacyRemaining: result.after,
    startedAt: options.startedAt,
    endedAt,
    durationMs: result.durationMs,
    codes: dryRunRefusal ? [dryRunRefusal, ...result.codes] : result.codes,
  };
}

export function verifyReceipts(receipts) {
  try {
    guard(Array.isArray(receipts) && receipts.length === 2, "receipt-targets");
    guard(same(receipts.map((r) => r.target).sort(), [...targets].sort()), "receipt-targets");
    for (const receipt of receipts) {
      guard(
        keys(receipt, receiptKeys) &&
          receipt.format === "collections-privacy-cutover-receipt/v1" &&
          receipt.mode === "redact",
        "receipt-shape",
      );
      packetShape(receipt.packet, receipt.startedAt);
      guard(utc(receipt.endedAt) && Date.parse(receipt.endedAt) >= Date.parse(receipt.startedAt), "receipt-time");
      guard(
        receipt.target === receipt.packet.target &&
          receipt.floorCommit === receipt.packet.floorCommit &&
          receipt.dbIdentityDigest === receipt.packet.dbIdentityDigest &&
          same(receipt.schemaLedger, receipt.packet.schemaLedger) &&
          receipt.schemaVersion === sha(JSON.stringify(receipt.schemaLedger)),
        "receipt-binding",
      );
      guard(
        typeof receipt.packetText === "string" &&
          Buffer.byteLength(receipt.packetText, "utf8") <= 16 * 1024 &&
          sha(receipt.packetText) === receipt.packetSha256 &&
          same(JSON.parse(receipt.packetText), receipt.packet),
        "receipt-binding",
      );
      guard(same(receipt.deployedRevisions, receipt.packet.writers), "receipt-writers");
      guard(
        keys(receipt.gates, gateKeys) &&
          Object.values(receipt.gates).every((value) => value === true) &&
          receipt.fencePresent === true,
        "receipt-gates",
      );
      guard(
        keys(receipt.activation, ["singleton", "activated_at", "gate_packet_sha256", "floor_commit"]) &&
          receipt.activation.singleton === true &&
          utc(receipt.activation.activated_at) &&
          isSha(receipt.activation.gate_packet_sha256, 64) &&
          receipt.activation.floor_commit === receipt.floorCommit,
        "receipt-activation",
      );
      guard(
        [
          receipt.before,
          receipt.processed,
          receipt.after,
          receipt.mismatches,
          receipt.legacyRemaining,
          receipt.durationMs,
        ].every(integer) &&
          receipt.processed <= 5000 &&
          receipt.processed <= receipt.before &&
          receipt.after === 0 &&
          receipt.legacyRemaining === 0 &&
          receipt.mismatches === 0 &&
          same(receipt.codes, []),
        "receipt-not-zero",
      );
    }
    return { valid: true, code: "verified-zero" };
  } catch {
    return { valid: false, code: "receipt-incomplete" };
  }
}

async function main() {
  const mode = process.env.REDACTION_MODE;
  const out = process.env.REDACTION_OUT;
  guard(typeof out === "string" && out.length > 0, "output-required");
  if (mode === "verify") {
    const input = process.env.REDACTION_RECEIPTS || "[]";
    guard(Buffer.byteLength(input, "utf8") <= 128 * 1024, "receipt-size");
    const artifacts = JSON.parse(input);
    guard(Array.isArray(artifacts) && artifacts.length === 2, "receipt-targets");
    const receipts = await Promise.all(
      artifacts.map(async (p) => {
        if (typeof p !== "string") return p;
        guard((await stat(p)).size <= 128 * 1024, "receipt-size");
        return JSON.parse(await readFile(p, "utf8"));
      }),
    );
    const verdict = verifyReceipts(receipts);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(verdict) + "\n");
    guard(verdict.valid, "receipt-incomplete");
    return;
  }
  const options = {
    mode,
    target: process.env.REDACTION_TARGET,
    jobEnvironment: process.env.REDACTION_JOB_ENVIRONMENT,
    approvalReference: process.env.REDACTION_APPROVAL_REFERENCE,
    ref: process.env.GITHUB_REF,
    defaultBranch: process.env.REDACTION_DEFAULT_BRANCH,
    root: process.cwd(),
    databaseUrl: process.env.DATABASE_URL_COLLECTIONS,
    packetText: process.env.REDACTION_GATE_PACKET,
    packetSha256: process.env.REDACTION_GATE_PACKET_SHA256,
    startedAt: new Date().toISOString(),
  };
  binding(options);
  const { register } = await import("tsx/esm/api");
  const unregister = register();
  let pool;
  try {
    const { default: pg } = await import("pg");
    const { normalizePgPoolConnectionString, resolvePgPoolSslConfig } =
      await import("../infrastructure/event-core-postgres/index.ts");
    const { redactLegacyAnonymousOwners } =
      await import("../bounded-contexts/collections/features/saved-lists/api/anonymous-owner-redaction.ts");
    const { activateAnonymousOwnerCutover } =
      await import("../bounded-contexts/collections/support/runtime-support/anonymous-owner-activation.ts");
    const connectionString = normalizePgPoolConnectionString(options.databaseUrl);
    pool = new pg.Pool({
      connectionString,
      ssl: resolvePgPoolSslConfig(connectionString),
      max: 1,
      connectionTimeoutMillis: 15_000,
      statement_timeout: 30_000,
    });
    pool.on("error", () => {});
    const receipt = await runRedaction(options, {
      pool,
      redact: redactLegacyAnonymousOwners,
      activate: activateAnonymousOwnerCutover,
    });
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(receipt, null, 2) + "\n");
    if (receipt.codes.length !== 0) {
      console.error(JSON.stringify({ code: "redaction-incomplete" }));
      process.exitCode = 1;
    }
  } finally {
    if (pool) await pool.end();
    unregister();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const startedAt = new Date().toISOString();
  main().catch(async (error) => {
    const code = error instanceof CutoverRefusal ? error.message : "cutover-failed";
    const receipt = {
      format: "collections-privacy-cutover-receipt/v1",
      codes: [code],
      target: targets.includes(process.env.REDACTION_TARGET) ? process.env.REDACTION_TARGET : null,
      startedAt,
      endedAt: new Date().toISOString(),
    };
    if (process.env.REDACTION_OUT) {
      try {
        await mkdir(dirname(process.env.REDACTION_OUT), { recursive: true });
        await writeFile(process.env.REDACTION_OUT, JSON.stringify(receipt) + "\n");
      } catch {
        /* Closed stderr remains available. */
      }
    }
    console.error(JSON.stringify({ code }));
    process.exitCode = 1;
  });
}
