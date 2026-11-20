import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  GOVERNED_RETURN_ORIGIN,
  providerWriteIdempotencyKey,
} from "../contracts/evidence-window-provider-write/index.ts";
import { providerWriteDigest, providerWriterShape } from "../contracts/evidence-window-provider-write/material.ts";
import { STRIPE_API_VERSION } from "../infrastructure/stripe-config/index.ts";
import { createStripePaymentProcessorGateway } from "../infrastructure/stripe-payments/index.ts";
import { isStripeTestServerKey } from "./stripe-key-mode.mjs";

const origin = "https://api.stripe.com";
const root = new URL("../", import.meta.url);
const artifact = new URL("artifacts/stripe-payment-create-uncertain-outcome.json", root);
const branches = ["checkout-session", "saved-instrument-payment-intent"];
const buckets = [
  ["immediate", 0],
  ["short-delay", 30_000],
  ["15-minute", 900_000],
];
const endpoints = ["/v1/checkout/sessions", "/v1/payment_intents"];
const piStates = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "requires_capture",
  "canceled",
  "succeeded",
];
const sessionStates = ["open", "complete", "expired"];
const paymentStates = ["unpaid", "paid", "no_payment_required"];
const dispositions = ["canceled", "detached", "retained-test", "unknown", "not-observed", "not-attempted"];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const nonce = () => randomUUID().replaceAll("-", "");
const isRef = (value, prefix) =>
  typeof value === "string" && value.startsWith(prefix) && /^[A-Za-z0-9_]{1,256}$/.test(value);
const safeState = (value, allowed) => (allowed.includes(value) ? value : "unknown");
const refusal = () => new Error("probe-boundary-refused");

// Use the deployed J executor with a private, single-process journal port. Only
// the two payment create rows are admitted; this does not exercise SQL durability.
function probeJournal(window) {
  const rows = new Map();
  const update = (key, version, change) => {
    const row = rows.get(key.objectClass);
    if (!row || providerWriteIdempotencyKey(row.key) !== providerWriteIdempotencyKey(key) || row.version !== version) {
      return { kind: "stale-write-rejected" };
    }
    const patch = change(row);
    if (!patch) return { kind: "refused", code: "write-unresolved" };
    const next = { ...row, ...patch, version: version + 1, updatedAt: new Date().toISOString() };
    rows.set(key.objectClass, next);
    return { kind: "existing", row: next };
  };
  return {
    async reserveOrResolve({ windowId, binding, envelope }) {
      const { objectClass } = providerWriterShape(binding);
      if (windowId !== window.windowId || ![2, 4].includes(objectClass) || Date.now() >= Date.parse(window.expiresAt)) {
        return { kind: "refused", code: "window-ineligible" };
      }
      const hash = await providerWriteDigest(envelope);
      const existing = rows.get(objectClass);
      if (existing) {
        return existing.digest === hash &&
          existing.binding.logicalOperationId === binding.logicalOperationId &&
          existing.binding.ownerAccountId === binding.ownerAccountId &&
          existing.binding.writerKind === binding.writerKind
          ? { kind: "existing", row: existing }
          : { kind: "refused", code: "binding-drift" };
      }
      const createdAt = new Date().toISOString();
      const row = {
        key: { windowId, objectClass, creationOrdinal: 1, operation: "create" },
        binding,
        envelope,
        digest: hash,
        state: "pending",
        version: 1,
        observedClass: null,
        reusedExisting: false,
        replayAttempts: 0,
        logicalSlot: null,
        providerReference: null,
        responseExpiresAt: null,
        createdAt,
        updatedAt: createdAt,
        replayDeadline: window.expiresAt,
      };
      rows.set(objectClass, row);
      return { kind: "reserved", row };
    },
    async claimReplay(key, version, now) {
      return update(key, version, (r) =>
        r.state === "pending" && r.replayAttempts === 0 && now < r.replayDeadline ? { replayAttempts: 1 } : null,
      );
    },
    async complete(key, version, result) {
      return update(key, version, (r) => (r.state === "pending" ? result : null));
    },
    async observeCapture(key, version) {
      return update(key, version, (r) =>
        r.state === "succeeded" && key.objectClass === 2 ? { observedClass: 1 } : null,
      );
    },
  };
}

function privateObject(raw, branch, paymentId) {
  const checkout = branch === branches[0];
  if (
    raw?.livemode !== false ||
    raw.object !== (checkout ? "checkout.session" : "payment_intent") ||
    !isRef(raw.id, checkout ? "cs_test_" : "pi_") ||
    raw.metadata?.payment_id !== paymentId
  )
    return null;
  return {
    reference: raw.id,
    state: safeState(raw.status, checkout ? sessionStates : piStates),
    paymentStatus: checkout ? safeState(raw.payment_status, paymentStates) : null,
  };
}

function observation(result, object = null) {
  return { result, providerState: object?.state ?? null, paymentStatus: object?.paymentStatus ?? null };
}

function conclude(row) {
  // Known-reference GET is forensic authority only. A PI hit cannot identify a Session.
  if (
    row.branch === branches[1] &&
    row.observations.at(-1).runtimePaymentIdSearch.result === "found" &&
    !row.observations.some((entry) => entry.knownObjectGet.result === "not-found") &&
    row.exactReplay.sameObject &&
    row.exactReplay.requestDigestEqual &&
    row.exactReplay.keyDigestEqual
  ) {
    return { result: "provider-object-found", authority: "correlated-runtime-payment-intent-search" };
  }
  return { result: "unresolved-unknown", authority: "no-conclusive-runtime-object-correlation" };
}

export async function captureProbe({
  secretKey,
  source,
  armed,
  providerFetch = globalThis.fetch,
  wait = delay,
  clock = performance,
  onPhase = () => {},
}) {
  if (
    !armed ||
    !isStripeTestServerKey(secretKey, { allowRestricted: true }) ||
    !/^[sr]k_test_[A-Za-z0-9_]+$/.test(secretKey)
  )
    throw refusal();
  const startedAt = new Date().toISOString();
  const window = {
    windowId: nonce(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const journal = probeJournal(window);
  const context = new AsyncLocalStorage();
  const gateway = createStripePaymentProcessorGateway({
    secretKey,
    publishableKey: "",
    webhookSecret: "",
    evidenceWindowProviderWrite: journal,
  });
  const authorization = `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
  const originalFetch = globalThis.fetch;
  const fixture = {
    customer: null,
    method: null,
    customerDisposition: "not-attempted",
    methodDisposition: "not-attempted",
  };
  let calls = 0;
  const wire = async (url, init) => {
    const headers = new Headers(init.headers);
    if (
      new URL(url).origin !== origin ||
      headers.get("authorization") !== authorization ||
      headers.get("stripe-version") !== STRIPE_API_VERSION ||
      ++calls > 36
    )
      throw refusal();
    return providerFetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  };
  const paymentRuns = branches.map((branch, index) => ({
    branch,
    index,
    paymentId: `pay_probe_${nonce()}`,
    charges: new Set(),
    writes: [],
    original: null,
    start: null,
    lossAt: null,
    confirmedAt: null,
    observations: [],
    failure: "none",
    attempted: false,
    responseKind: "not-observed",
    relatedPaymentIntent: false,
  }));

  function recordCharges(run, paymentIntent) {
    for (const ref of [paymentIntent?.latest_charge, paymentIntent?.last_payment_error?.charge]) {
      const id = typeof ref === "string" ? ref : ref?.id;
      if (isRef(id, "ch_")) run.charges.add(id);
    }
  }

  globalThis.fetch = async (url, init) => {
    const active = context.getStore();
    const path = new URL(url).pathname;
    if (!active) throw refusal();
    const { run, phase } = active;
    const method = init.method;
    if (phase === "create" || phase === "replay") {
      if (method !== "POST" || path !== endpoints[run.index] || typeof init.body !== "string") throw refusal();
      const key = new Headers(init.headers).get("idempotency-key");
      const bytes = Buffer.from(init.body, "utf8");
      const first = run.writes[0];
      if (
        !key ||
        (phase === "create"
          ? first
          : !first || run.writes.length !== 1 || !bytes.equals(first.bytes) || key !== first.key)
      )
        throw refusal();
      run.writes.push({ bytes, key, confirmed: null });
      const write = run.writes.at(-1);
      const response = await wire(url, init);
      const raw = await response
        .clone()
        .json()
        .catch(() => null);
      const payment = response.ok ? raw : response.status === 402 ? raw?.error?.payment_intent : null;
      write.confirmed = privateObject(payment, run.branch, run.paymentId);
      if (write.confirmed && run.index === 1) recordCharges(run, payment);
      if (write.confirmed && run.index === 0 && isRef(payment.payment_intent, "pi_")) run.relatedPaymentIntent = true;
      if (phase === "create")
        run.responseKind = write.confirmed
          ? response.ok
            ? "accepted"
            : "confirmation-error-with-object"
          : "unconfirmed";
      if (phase === "create" && write.confirmed) {
        run.original = write.confirmed;
        write.privateResponse = raw;
        run.confirmedAt = new Date().toISOString();
        run.start = clock.now();
        run.lossAt = new Date().toISOString();
        // J sees a transport loss, not the accepted provider response (including a 402 with a PI).
        throw refusal();
      }
      return response;
    }

    const objectPath = run?.original ? `${endpoints[run.index]}/${run.original.reference}` : null;
    const branchRead = phase === "known" && path === objectPath;
    const search = phase === "search" && path === "/v1/payment_intents/search";
    const incidentalRead =
      ["known", "search"].includes(phase) && /^\/v1\/(charges\/ch_|payment_intents\/pi_)[A-Za-z0-9_]+$/.test(path);
    const cancel = phase === "cancel" && path === `${objectPath}/cancel` && method === "POST";
    const fixtureCall =
      (phase === "customer" && path === "/v1/customers" && method === "POST") ||
      (phase === "detach" && path === `/v1/payment_methods/${fixture.method}/detach` && method === "POST");
    if (!(method === "GET" && (branchRead || search || incidentalRead)) && !cancel && !fixtureCall) throw refusal();
    const response = await wire(url, init);
    const raw = await response
      .clone()
      .json()
      .catch(() => null);
    if (branchRead || search || cancel || fixtureCall)
      active.response = { ok: response.ok, status: response.status, raw };
    if (branchRead && raw?.livemode === false) {
      if (run.index === 1) recordCharges(run, raw);
      if (run.index === 0 && isRef(raw.payment_intent, "pi_")) run.relatedPaymentIntent = true;
    }
    return response;
  };

  const scoped = async (phase, run, call) => {
    const active = { phase, run, response: null };
    let value = null;
    let succeeded = false;
    try {
      value = await context.run(active, call);
      succeeded = true;
    } catch {
      /* Provider errors stay private. */
    }
    return { value, succeeded, response: active.response };
  };

  async function provisionFixture() {
    fixture.customerDisposition = "unknown";
    const customer = await scoped("customer", null, () =>
      gateway.createCustomer({ accountId: `acc_probe_${nonce()}` }),
    );
    const customerRef = customer.value?.providerCustomerReference;
    if (
      !customer.response?.ok ||
      customer.response.raw?.livemode !== false ||
      customer.response.raw?.object !== "customer" ||
      customer.response.raw?.id !== customerRef ||
      !isRef(customerRef, "cus_")
    )
      return;
    fixture.customer = customerRef;
    fixture.customerDisposition = "retained-test";
    fixture.methodDisposition = "unknown";
    try {
      // Stripe's predefined TEST fixture is attached only to this synthetic customer.
      const attach = await wire(`${origin}/v1/payment_methods/pm_card_threeDSecure2Required/attach`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Stripe-Version": STRIPE_API_VERSION,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": `probe-fixture:${randomUUID()}`,
        },
        body: new URLSearchParams({ customer: fixture.customer }),
      });
      const method = await attach.json().catch(() => null);
      if (
        attach.ok &&
        method?.livemode === false &&
        method.object === "payment_method" &&
        method.customer === fixture.customer &&
        isRef(method.id, "pm_")
      ) {
        fixture.method = method.id;
        fixture.methodDisposition = "retained-test";
      }
    } catch {
      /* No fixture retry. */
    }
  }

  async function observe(run, phase) {
    if (phase === "known" && !run.original) return observation("error");
    if (!run.attempted) return observation("error");
    const result = await scoped(phase, run, () =>
      phase === "known"
        ? gateway.retrievePaymentResult(run.original.reference)
        : gateway.retrievePaymentResultByPaymentId(run.paymentId),
    );
    const raw = result.response?.raw;
    if (phase === "known" && result.response?.status === 404 && raw?.error?.code === "resource_missing")
      return observation("not-found");
    if (!result.succeeded || !result.response?.ok) return observation("error");
    if (phase === "search" && Array.isArray(raw?.data) && raw.data.length === 0 && result.value === null)
      return observation("not-found");
    if (phase === "search" && (!Array.isArray(raw?.data) || raw.data.length !== 1 || raw.has_more !== false))
      return observation("error");
    const object = privateObject(
      phase === "known" ? raw : raw.data[0],
      phase === "known" ? run.branch : branches[1],
      run.paymentId,
    );
    if (
      !object ||
      object.reference !== result.value?.processorPaymentReference ||
      (phase === "known" && object.reference !== run.original.reference) ||
      (phase === "search" && run.index === 1 && run.original && object.reference !== run.original.reference)
    )
      return observation("error");
    if (phase === "search") {
      recordCharges(run, raw.data[0]);
      if (run.index === 0) run.relatedPaymentIntent = true;
    }
    return observation("found", object);
  }

  try {
    await provisionFixture();
    await Promise.all(
      paymentRuns.map(async (run) => {
        if (run.index === 1 && !fixture.method) {
          run.failure = "fixture";
          return;
        }
        run.input = {
          evidenceWindow: window,
          paymentId: run.paymentId,
          buyerAccountId: `acc_probe_${nonce()}`,
          orderIds: [],
          amount: "1.00",
          currencyCode: "usd",
          paymentMethodCategory: "card",
          description: "Synthetic uncertain creation probe",
          returnUrl: `${GOVERNED_RETURN_ORIGIN}/checkout/payments/${encodeURIComponent(run.paymentId)}`,
          ...(run.index === 1
            ? {
                savedCheckoutInstrument: {
                  instrumentId: `sci_probe_${nonce()}`,
                  providerCustomerReference: fixture.customer,
                  providerReference: fixture.method,
                  confirmationExperience: "off-session-token",
                },
              }
            : {}),
        };
        run.attempted = true;
      const create = await scoped("create", run, () => gateway.createPaymentSession(run.input));
      if (!run.original || create.succeeded) run.failure = "original-response";
      }),
    );
    for (const [bucket, targetElapsedMs] of buckets) {
      await Promise.all(
        paymentRuns.map(async (run) => {
          if (run.start !== null && targetElapsedMs > 0)
            await wait(Math.max(0, Math.ceil(run.start + targetElapsedMs - clock.now())));
          const at = new Date().toISOString();
          const elapsedMs = run.start === null ? null : Math.round(clock.now() - run.start);
          const [knownObjectGet, runtimePaymentIdSearch] =
            run.start === null
              ? [observation("error"), observation("error")]
              : await Promise.all([observe(run, "known"), observe(run, "search")]);
          run.observations.push({ bucket, targetElapsedMs, at, elapsedMs, knownObjectGet, runtimePaymentIdSearch });
        }),
      );
      onPhase(bucket);
    }
    for (const run of paymentRuns) {
      run.replayAt = null;
      if (!run.original) continue;
      run.replayAt = new Date().toISOString();
      await scoped("replay", run, () => gateway.createPaymentSession(run.input));
      if (!run.writes[1]?.confirmed || run.writes[1].confirmed.reference !== run.original.reference)
        run.failure = "exact-replay";
    }
  } finally {
    const saved = paymentRuns[1];
    saved.disposition = !saved.attempted ? "not-attempted" : saved.original ? "retained-test" : "unknown";
    if (
      saved.original &&
      ["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture"].includes(
        saved.original.state,
      )
    ) {
      const cancellation = await scoped("cancel", saved, () =>
        gateway.cancelPayment(saved.original.reference, { kind: "ungoverned" }),
      );
      const canceled = privateObject(cancellation.response?.raw, saved.branch, saved.paymentId);
      saved.disposition =
        cancellation.succeeded && canceled?.reference === saved.original.reference && canceled.state === "canceled"
          ? "canceled"
          : "unknown";
    }
    if (fixture.method) {
      const detached = await scoped("detach", null, () => gateway.detachSavedPaymentMethod(fixture.method));
      const raw = detached.response?.raw;
      fixture.methodDisposition =
        detached.succeeded && raw?.livemode === false && raw.id === fixture.method && raw.customer === null
          ? "detached"
          : "unknown";
    }
    globalThis.fetch = originalFetch;
  }

  return {
    schemaVersion: "stripe-payment-create-uncertain-outcome/v1",
    source,
    deployment: "not-applicable-local-adapter",
    journal: "deployed-executor-private-process-port",
    apiVersion: STRIPE_API_VERSION,
    startedAt,
    completedAt: new Date().toISOString(),
    fixtureDisposition: { customer: fixture.customerDisposition, paymentMethod: fixture.methodDisposition },
    rows: paymentRuns.map((run) => {
      const [first, replay] = run.writes;
      const row = {
        branch: run.branch,
        responseKind: run.responseKind,
        acceptedAt: run.confirmedAt,
        callerLossAt: run.lossAt,
        observations: run.observations,
        exactReplay: {
          at: run.replayAt,
          sameObject: Boolean(first?.confirmed && replay?.confirmed?.reference === first.confirmed.reference),
          requestDigestEqual: Boolean(replay && digest(first.bytes) === digest(replay.bytes)),
          keyDigestEqual: Boolean(replay && digest(first.key) === digest(replay.key)),
        },
        failingPhase: run.failure,
        disposition: {
          paymentObject: run.index === 0 ? (run.original ? "retained-test" : "unknown") : run.disposition,
          unexpectedReplayObject:
            replay?.confirmed && replay.confirmed.reference !== run.original.reference
              ? "retained-test"
              : replay && !replay.confirmed
                ? "unknown"
                : "not-observed",
          relatedPaymentIntent: run.relatedPaymentIntent ? "retained-test" : "not-observed",
          relatedCharges: Array.from(run.charges, () => "retained-test"),
        },
      };
      return { ...row, conclusion: conclude(row) };
    }),
  };
}

function requireShape(condition) {
  if (!condition) throw refusal();
}

function closed(object, keys) {
  requireShape(
    object &&
      Object.getPrototypeOf(object) === Object.prototype &&
      Object.keys(object).length === keys.length &&
      keys.every((key) => Object.hasOwn(object, key)),
  );
}

function instant(value, nullable = false) {
  requireShape(
    (nullable && value === null) ||
      (typeof value === "string" &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
        new Date(value).toISOString() === value),
  );
}

export function serializeResult(result) {
  closed(result, [
    "schemaVersion",
    "source",
    "deployment",
    "journal",
    "apiVersion",
    "startedAt",
    "completedAt",
    "fixtureDisposition",
    "rows",
  ]);
  requireShape(
    result.schemaVersion === "stripe-payment-create-uncertain-outcome/v1" &&
      /^[a-f0-9]{40}$/.test(result.source) &&
      result.deployment === "not-applicable-local-adapter" &&
      result.journal === "deployed-executor-private-process-port" &&
      result.apiVersion === STRIPE_API_VERSION,
  );
  instant(result.startedAt);
  instant(result.completedAt);
  closed(result.fixtureDisposition, ["customer", "paymentMethod"]);
  requireShape(Object.values(result.fixtureDisposition).every((value) => dispositions.includes(value)));
  requireShape(Array.isArray(result.rows) && result.rows.length === branches.length);
  for (const [index, row] of result.rows.entries()) {
    closed(row, [
      "branch",
      "responseKind",
      "acceptedAt",
      "callerLossAt",
      "observations",
      "exactReplay",
      "failingPhase",
      "disposition",
      "conclusion",
    ]);
    requireShape(
      row.branch === branches[index] &&
        ["none", "fixture", "original-response", "exact-replay"].includes(row.failingPhase) &&
        ["not-observed", "unconfirmed", "accepted", "confirmation-error-with-object"].includes(row.responseKind),
    );
    instant(row.acceptedAt, true);
    instant(row.callerLossAt, true);
    requireShape(
      ["accepted", "confirmation-error-with-object"].includes(row.responseKind) === (row.acceptedAt !== null) &&
        (row.acceptedAt === null
          ? row.callerLossAt === null
          : row.callerLossAt !== null && row.callerLossAt >= row.acceptedAt),
    );
    requireShape(Array.isArray(row.observations) && row.observations.length === buckets.length);
    for (const [i, entry] of row.observations.entries()) {
      closed(entry, ["bucket", "targetElapsedMs", "at", "elapsedMs", "knownObjectGet", "runtimePaymentIdSearch"]);
      requireShape(
        entry.bucket === buckets[i][0] &&
          entry.targetElapsedMs === buckets[i][1] &&
          (row.callerLossAt === null
            ? entry.elapsedMs === null
            : Number.isSafeInteger(entry.elapsedMs) && entry.elapsedMs >= entry.targetElapsedMs),
      );
      instant(entry.at);
      for (const [read, checkout] of [
        [entry.knownObjectGet, index === 0],
        [entry.runtimePaymentIdSearch, false],
      ]) {
        closed(read, ["result", "providerState", "paymentStatus"]);
        requireShape(
          ["found", "not-found", "error"].includes(read.result) &&
            (read.result === "found"
              ? [...(checkout ? sessionStates : piStates), "unknown"].includes(read.providerState) &&
                (checkout ? [...paymentStates, "unknown"].includes(read.paymentStatus) : read.paymentStatus === null)
              : read.providerState === null && read.paymentStatus === null),
        );
      }
    }
    closed(row.exactReplay, ["at", "sameObject", "requestDigestEqual", "keyDigestEqual"]);
    instant(row.exactReplay.at, true);
    requireShape(
      (row.exactReplay.at === null || row.exactReplay.at >= row.observations.at(-1).at) &&
        [row.exactReplay.sameObject, row.exactReplay.requestDigestEqual, row.exactReplay.keyDigestEqual].every(
          (value) => typeof value === "boolean",
        ),
    );
    closed(row.disposition, ["paymentObject", "unexpectedReplayObject", "relatedPaymentIntent", "relatedCharges"]);
    requireShape(
      [
        row.disposition.paymentObject,
        row.disposition.unexpectedReplayObject,
        row.disposition.relatedPaymentIntent,
      ].every((value) => dispositions.includes(value)) &&
        Array.isArray(row.disposition.relatedCharges) &&
        row.disposition.relatedCharges.length <= 6 &&
        row.disposition.relatedCharges.every((value) => value === "retained-test"),
    );
    closed(row.conclusion, ["result", "authority"]);
    const expected = conclude(row);
    requireShape(row.conclusion.result === expected.result && row.conclusion.authority === expected.authority);
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

async function main() {
  const [, , arm, expectedHead, ...extra] = process.argv;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!isStripeTestServerKey(secretKey, { allowRestricted: true })) {
    console.error("BLOCKED: missing TEST STRIPE_SECRET_KEY");
    process.exitCode = 2;
    return;
  }
  const git = (args) =>
    execFileSync("git", args, {
      cwd: fileURLToPath(root),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const source = git(["rev-parse", "HEAD"]);
  if (
    arm !== "--run-test-mode" ||
    extra.length ||
    expectedHead !== source ||
    git(["status", "--porcelain", "--untracked-files=no"])
  )
    throw refusal();
  await mkdir(new URL("artifacts/", root), { recursive: true });
  // Refuse to overwrite evidence or blindly launch a second capture in this seat.
  // The sentinel has no private material and survives a failed/interrupted launch.
  await writeFile(new URL("artifacts/stripe-payment-create-uncertain-outcome.started", root), "TEST probe launch\n", {
    flag: "wx",
  });
  const result = await captureProbe({
    secretKey,
    source,
    armed: true,
    onPhase: (bucket) => console.log(`Observed bucket: ${bucket}`),
  });
  const serialized = serializeResult(result);
  await writeFile(artifact, serialized, { flag: "wx" });
  console.log(`Wrote closed probe evidence; SHA-256 ${digest(serialized)}`);
  if (result.rows.some((row) => row.failingPhase !== "none")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => {
    console.error("Probe stopped; no raw provider details emitted.");
    process.exitCode = 1;
  });
}
