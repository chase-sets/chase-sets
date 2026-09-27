import { createHash } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { WriteStream } from "node:tty";
import { captureEvidenceWindow, refusedCapture } from "./capture-evidence-window.mjs";
import {
  assertReviewedWorktree,
  claimAuthorization,
  readLaunchManifest,
  readSecureConsole,
  validatePrivatePaths,
  validateLaunchManifest,
} from "./test-window-admission.mjs";
import { closedObject } from "./test-window-policy.mjs";
import { openConfinedBrowser } from "./test-window-browser.mjs";
import { isStripePublishableKeyForMode, isUnrestrictedStripeSecretKeyForMode } from "../stripe-key-mode.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const refuse = () => {
  throw new Error("authority-unavailable");
};

async function assertOperatorParent(args) {
  if (process.stdout.isTTY || process.platform !== "linux") refuse();
  const executable = await realpath(`/proc/${process.ppid}/exe`);
  if (basename(executable) !== "pwsh") refuse();
  const bytes = await readFile(`/proc/${process.ppid}/cmdline`);
  if (bytes.byteLength > 32768) refuse();
  const command = bytes.toString("utf8").split("\0").filter(Boolean);
  const entry = await realpath(fileURLToPath(new URL("./invoke-test-window.ps1", import.meta.url)));
  const expected = [
    "-NoProfile",
    "-File",
    entry,
    "-CandidateHead",
    args[1],
    "-ManifestPath",
    args[3],
    "-ManifestSha256",
    args[5],
    "-AuthorizeOneTestWindow",
  ];
  if (JSON.stringify(command.slice(1)) !== JSON.stringify(expected)) refuse();
}

export function parsePrivateFixtures(bytes, manifest) {
  if (typeof bytes !== "string" || Buffer.byteLength(bytes) > 16384 || hash(bytes) !== manifest.fixturesDigest)
    refuse();
  const fixtures = JSON.parse(bytes);
  if (
    !closedObject(fixtures, [
      "buyerA",
      "buyerB",
      "seller",
      "customerB",
      "connectedAccount",
      "paymentMethod",
      "publishableKey",
      "paymentId",
      "setupReferenceId",
      "instrumentId",
      "orderIds",
      "amount",
      "consentId",
      "consentText",
    ])
  )
    refuse();
  for (const key of ["buyerA", "buyerB", "seller", "paymentId", "setupReferenceId", "instrumentId", "consentId"])
    if (typeof fixtures[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(fixtures[key])) refuse();
  if (
    fixtures.buyerA === fixtures.buyerB ||
    !/^cus_[A-Za-z0-9_]+$/.test(fixtures.customerB) ||
    !/^acct_[A-Za-z0-9_]+$/.test(fixtures.connectedAccount) ||
    !/^pm_[A-Za-z0-9_]+$/.test(fixtures.paymentMethod) ||
    !isStripePublishableKeyForMode(fixtures.publishableKey, "test") ||
    !/^[a-z]+_[a-z]+_[A-Za-z0-9_]+$/.test(fixtures.publishableKey) ||
    !/^\d{1,4}\.\d{2}$/.test(fixtures.amount) ||
    Number(fixtures.amount) <= 0 ||
    !Array.isArray(fixtures.orderIds) ||
    fixtures.orderIds.length < 1 ||
    fixtures.orderIds.length > 16 ||
    fixtures.orderIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
    typeof fixtures.consentText !== "string" ||
    Buffer.byteLength(fixtures.consentText) < 1 ||
    Buffer.byteLength(fixtures.consentText) > 500
  )
    refuse();
  for (const flow of manifest.schedule) {
    const members = flow.mappers.map((mapper) => ({
      writerKind: mapper,
      logicalOperationId:
        mapper === "customer"
          ? fixtures.buyerA
          : mapper === "setup-embedded"
            ? fixtures.setupReferenceId
            : mapper === "payment-saved"
              ? fixtures.paymentId
              : fixtures.seller,
      ownerAccountId:
        mapper === "customer" ? fixtures.buyerA : mapper.startsWith("connect-") ? fixtures.seller : fixtures.buyerB,
    }));
    if (hash(JSON.stringify(members)) !== flow.identityDigest) refuse();
  }
  return fixtures;
}

export async function runTestWindow(args = process.argv.slice(2)) {
  if (
    args.length !== 7 ||
    args[0] !== "--candidate-head" ||
    args[2] !== "--manifest-path" ||
    args[4] !== "--manifest-sha256" ||
    args[6] !== "--authorize-one-test-window"
  )
    return refusedCapture("authority-unavailable");
  let browser;
  let pool;
  let terminal;
  let terminalFd;
  let claimed = false;
  const expiry = new AbortController();
  let timer;
  try {
    // A pipeline/agent flag is not authority. Refuse before reading fixtures or
    // starting any provider-capable child when no real controlling terminal exists.
    if (!process.stdin.isTTY || process.platform !== "linux") refuse();
    await assertOperatorParent(args);
    const limits = await readFile("/proc/self/limits", "utf8");
    if (!/^Max core file size\s+0\s/m.test(limits)) refuse();
    const candidateHead = args[1];
    const manifest = await readLaunchManifest(args[3], args[5], candidateHead);
    timer = setTimeout(
      () => {
        expiry.abort();
        void browser?.close().catch(() => {});
      },
      Math.max(0, Date.parse(manifest.timing.expiresAt) - Date.now()),
    );
    const { STRIPE_API_VERSION } = await import("../../infrastructure/stripe-config/index.ts");
    if (manifest.configuration.apiVersion !== STRIPE_API_VERSION) refuse();
    assertReviewedWorktree(candidateHead);
    await validatePrivatePaths(manifest);
    terminalFd = openSync("/dev/tty", "w");
    terminal = new WriteStream(terminalFd);
    terminal.write(
      `One TEST window. Head: ${candidateHead}\nManifest SHA256: ${args[5]}\nFour flows; at most six logical creates; 320 total HTTP attempts; no retry.\n`,
    );
    const confirmation = await readSecureConsole(
      "Confirm the exact head, a space, and manifest digest (not echoed): ",
      process.stdin,
      terminal,
      expiry.signal,
    );
    if (confirmation !== `${candidateHead} ${args[5]}`) refuse();
    validateLaunchManifest(manifest, candidateHead);
    assertReviewedWorktree(candidateHead);
    await claimAuthorization(manifest, args[5]);
    claimed = true;
    const fixtureBytes = await readSecureConsole(
      "Private replacement-bound TEST fixture JSON (not echoed): ",
      process.stdin,
      terminal,
      expiry.signal,
    );
    const fixtures = parsePrivateFixtures(fixtureBytes, manifest);
    validateLaunchManifest(manifest, candidateHead);
    // unshare is the kernel-enforced child fence. An unsupported host/namespace
    // fails here, before the TEST credential prompt or any external request.
    browser = await openConfinedBrowser();
    const { default: pg } = await import("pg");
    pool = new pg.Pool({
      host: manifest.journal.host,
      port: manifest.journal.port,
      database: manifest.journal.database,
      user: manifest.journal.user,
      password: () => {
        throw new Error("local-journal-password-refused");
      },
      ssl: false,
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    pool.on("error", () => {});
    const local = await pool.query(
      "SELECT current_database() AS database, current_user AS username, inet_server_addr()::text AS address, (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS sessions, (SELECT count(*)::int FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')) AS tables",
    );
    if (
      local.rows.length !== 1 ||
      local.rows[0].database !== manifest.journal.database ||
      local.rows[0].username !== manifest.journal.user ||
      (local.rows[0].address !== "127.0.0.1/32" && local.rows[0].address !== "127.0.0.1") ||
      local.rows[0].sessions !== 1 ||
      local.rows[0].tables !== 0
    )
      refuse();
    validateLaunchManifest(manifest, candidateHead);
    const secretKey = await readSecureConsole(
      "Stripe TEST secret key (not echoed): ",
      process.stdin,
      terminal,
      expiry.signal,
    );
    if (!isUnrestrictedStripeSecretKeyForMode(secretKey, "test") || !/^[a-z]+_[a-z]+_[A-Za-z0-9_]+$/.test(secretKey))
      refuse();
    validateLaunchManifest(manifest, candidateHead);
    assertReviewedWorktree(candidateHead);
    const { bootstrapContextDatabase } = await import("../../infrastructure/bounded-context-runtime/index.ts");
    const { module: paymentsModule } = await import("../../bounded-contexts/payments/index.ts");
    const { platformControlPlaneSchemaSql } = await import("../../infrastructure/platform-runtime/control-plane.ts");
    await pool.query(platformControlPlaneSchemaSql);
    await bootstrapContextDatabase(paymentsModule, pool);
    const { createTestWindowDriver } = await import("./test-window-driver.mjs");
    expiry.signal.throwIfAborted();
    const packet = await captureEvidenceWindow({
      admit: async () => manifest,
      open: async () =>
        createTestWindowDriver(manifest, { pool, secretKey, fixtures, browser, authoritySignal: expiry.signal }),
    });
    return { ...packet, manifestDigest: args[5] };
  } catch {
    return {
      ...refusedCapture(claimed ? "cleanup-obligation-retained" : "authority-unavailable"),
      classification: claimed ? "invalid" : "refused",
      ...(claimed ? { manifestDigest: args[5] } : {}),
    };
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    await pool?.end().catch(() => {});
    if (terminalFd !== undefined) closeSync(terminalFd);
  }
}
