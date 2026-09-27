import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseStrictRfc3339, validateProviderObjectDisposition } from "./validate-provider-object-disposition.mjs";

const MAPPERS = Object.freeze([
  "customer",
  "setup-embedded",
  "payment-saved",
  "connect-setup",
  "connect-manage",
  "connect-notification",
]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const instant = (value) => parseStrictRfc3339(value) !== null;
const head = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const admissionKeys = new Set([
  "deploymentEnvironment",
  "providerMode",
  "reviewedHead",
  "executedHead",
  "journalHead",
  "deployedHead",
  "expiresAt",
  "apiVersion",
  "configDigest",
  "maxHttpAttempts",
  "maxObjects",
  "retentionGuarantee",
]);
const refused = (code) => ({
  version: "provider-lifecycle-capture/v1",
  classification: "refused",
  code,
  replayQualified: false,
});

/**
 * The host-packaged launch supplies the admitted configuration and private mapper
 * closures. The bare CLI cannot obtain provider authority from flags or credentials.
 * Private closure state and response bytes never enter the returned packet.
 */
export async function captureEvidenceWindow(launch) {
  if (!launch || typeof launch.admit !== "function") return refused("authority-unavailable");
  let admission;
  try {
    admission = await launch.admit();
  } catch {
    return refused("authority-unavailable");
  }
  if (admission?.deploymentEnvironment === "production" || admission?.providerMode === "live")
    return refused("production-environment");
  if (
    !admission ||
    Object.keys(admission).some((key) => !admissionKeys.has(key)) ||
    admission.providerMode !== "test" ||
    !["dev", "test"].includes(admission.deploymentEnvironment) ||
    !head(admission.reviewedHead) ||
    !head(admission.executedHead) ||
    !head(admission.journalHead) ||
    !head(admission.deployedHead) ||
    admission.reviewedHead !== admission.executedHead ||
    !instant(admission.expiresAt) ||
    Date.parse(admission.expiresAt) <= Date.now() ||
    !Number.isSafeInteger(admission.maxHttpAttempts) ||
    admission.maxHttpAttempts < 1 ||
    admission.maxHttpAttempts > 646 ||
    !Number.isSafeInteger(admission.maxObjects) ||
    admission.maxObjects < 1 ||
    admission.maxObjects > 323 ||
    !/^\d{4}-\d\d-\d\d\.[a-z]+$/.test(admission.apiVersion ?? "") ||
    !/^[a-f0-9]{64}$/.test(admission.configDigest ?? "")
  )
    return refused("authority-unavailable");
  if (
    admission.retentionGuarantee &&
    (Object.keys(admission.retentionGuarantee).some((key) => !["source", "seconds"].includes(key)) ||
      admission.retentionGuarantee.source !== "https://docs.stripe.com/api/idempotent_requests" ||
      !Number.isSafeInteger(admission.retentionGuarantee.seconds) ||
      admission.retentionGuarantee.seconds <= 0 ||
      admission.retentionGuarantee.seconds > 86400)
  )
    return refused("authority-unavailable");
  // Open only after admission, so malformed or production launches cannot construct a provider-capable driver.
  let driver;
  try {
    driver = await launch.open(admission);
  } catch {
    return refused("journal-unavailable");
  }
  if (
    !driver ||
    typeof driver.dispose !== "function" ||
    typeof driver.journal?.readWindow !== "function" ||
    !Array.isArray(driver.scenarios) ||
    driver.scenarios.length !== MAPPERS.length ||
    MAPPERS.some((mapper) => driver.scenarios.filter((scenario) => scenario.mapper === mapper).length !== 1)
  )
    return refused("invalid-input");
  let attempts = 0;
  const objects = new Set();
  const observations = [];
  const originalFetch = globalThis.fetch;
  let active;
  let first;
  let replay;
  let phase;
  let repeats;
  let classification = "observed";
  let disposition;
  let modeRefused = false;
  globalThis.fetch = async (url, init = {}) => {
    if (modeRefused || Date.now() >= Date.parse(admission.expiresAt) || attempts >= admission.maxHttpAttempts)
      throw new Error("capture-bound");
    const endpoint = new URL(typeof url === "string" || url instanceof URL ? url : url.url);
    if (endpoint.origin !== "https://api.stripe.com" || endpoint.search || endpoint.hash)
      throw new Error("capture-target");
    const headers = new Headers(init.headers);
    if (headers.get("Stripe-Version") !== admission.apiVersion) throw new Error("capture-version");
    const method = init.method ?? "GET";
    const create =
      method === "POST" && /^\/v1\/(customers|setup_intents|payment_intents|account_sessions)$/.test(endpoint.pathname);
    if (
      method !== "GET" &&
      !create &&
      !(method === "POST" && /^\/v1\/(payment_intents|setup_intents)\/[A-Za-z0-9_]+\/cancel$/.test(endpoint.pathname))
    )
      throw new Error("capture-operation");
    const key = headers.get("Idempotency-Key");
    if (method === "POST" && !/^evidence-window\/v1:[a-f0-9]{32}:[1-6]:\d+:(create|dispose)$/.test(key ?? ""))
      throw new Error("capture-journal-key");
    if (method === "POST") {
      const [, windowId, objectClass, ordinal, operation] = key.split(":");
      const rows = await driver.journal.readWindow(windowId);
      const row = rows.find(
        (candidate) =>
          candidate.key.windowId === windowId &&
          candidate.key.objectClass === Number(objectClass) &&
          candidate.key.creationOrdinal === Number(ordinal) &&
          candidate.key.operation === operation,
      );
      if (
        !row ||
        !row.envelope ||
        (create && row.binding.writerKind !== active) ||
        !["pending", "succeeded"].includes(row.state) ||
        Date.now() >= Date.parse(row.replayDeadline) ||
        row.envelope.endpoint !== endpoint.pathname ||
        row.envelope.method !== method ||
        row.envelope.bodyText !== (init.body ?? null) ||
        row.envelope.apiVersion !== admission.apiVersion ||
        row.envelope.connectedAccountReference !== headers.get("Stripe-Account")
      )
        throw new Error("capture-journal-binding");
    }
    // Reserve after the asynchronous journal read: two tabs must not race past the cap.
    if (
      modeRefused ||
      Date.now() >= Date.parse(admission.expiresAt) ||
      attempts >= admission.maxHttpAttempts ||
      (create && !objects.has(key) && objects.size >= admission.maxObjects)
    )
      throw new Error("capture-bound");
    if (create) objects.add(key);
    attempts++;
    const sentAt = new Date().toISOString();
    const response = await originalFetch(url, init);
    if (!active || !create || !response.ok) return response;
    const bytes = Buffer.from(await response.arrayBuffer());
    const body = JSON.parse(bytes.toString("utf8"));
    if (body.livemode !== false) {
      modeRefused = true;
      throw new Error("capture-mode-unobserved");
    }
    const observed = {
      sentAt,
      key,
      request: digest(
        JSON.stringify([
          endpoint.pathname,
          method,
          init.body ?? null,
          headers.get("Stripe-Account"),
          headers.get("Stripe-Version"),
        ]),
      ),
      response: digest(bytes),
      expiresAt: Number.isSafeInteger(body.expires_at) ? new Date(body.expires_at * 1000).toISOString() : null,
    };
    if (phase === "original") {
      first = observed;
      // Real acceptance was privately observed, but the caller/J sees an uncertain response.
      throw new Error("capture-response-withheld");
    }
    if (phase === "replay") replay = observed;
    else repeats.push(observed);
    return new Response(bytes, { status: response.status, headers: response.headers });
  };
  try {
    for (const scenario of driver.scenarios) {
      active = scenario.mapper;
      first = null;
      replay = null;
      repeats = [];
      phase = "original";
      try {
        await scenario.original();
      } catch {
        /* Withheld response is an expected uncertain write. */
      }
      phase = "replay";
      // Host closure creates a fresh runtime over the same persisted J, never a new key.
      try {
        await scenario.restartAndReplay();
      } catch {
        /* Report closed uncertainty below. */
      }
      const equality = Boolean(
        first &&
        replay &&
        first.key === replay.key &&
        first.request === replay.request &&
        first.response === replay.response,
      );
      const elapsedSeconds = first && replay ? (Date.parse(replay.sentAt) - Date.parse(first.sentAt)) / 1000 : null;
      let usability = "not-applicable";
      let repeatedSameSlot = null;
      let twoTabs = null;
      if (scenario.mapper.startsWith("connect-")) {
        usability = "unknown";
        if (equality && replay.expiresAt && Date.parse(replay.expiresAt) > Date.now()) {
          phase = "repeat";
          try {
            await scenario.repeatSameSlot();
          } catch {
            /* Missing or refused is unknown. */
          }
          repeatedSameSlot =
            repeats.length === 1 &&
            repeats[0].key === first.key &&
            repeats[0].request === first.request &&
            repeats[0].response === first.response;
          repeats = [];
          try {
            await scenario.twoTabs();
          } catch {
            /* Missing or refused is unknown. */
          }
          twoTabs =
            repeats.length === 2 &&
            repeats.every(
              (observed) =>
                observed.key === first.key &&
                observed.request === first.request &&
                observed.response === first.response,
            );
          if (repeatedSameSlot && twoTabs && Date.parse(replay.expiresAt) > Date.now()) {
            try {
              usability = (await scenario.initializeIntendedComponent()) === true ? "usable" : "unknown";
            } catch {
              /* Unknown is not usable. */
            }
          }
        }
      }
      const guarantee = admission.retentionGuarantee;
      const supportedInterval =
        guarantee &&
        typeof guarantee.source === "string" &&
        /^https:\/\/docs\.stripe\.com\//.test(guarantee.source) &&
        Number.isSafeInteger(guarantee.seconds) &&
        guarantee.seconds > 0 &&
        guarantee.seconds <= 86400 &&
        elapsedSeconds !== null &&
        elapsedSeconds >= 0 &&
        elapsedSeconds < guarantee.seconds;
      observations.push({
        mapper: scenario.mapper,
        classification:
          equality && (usability === "not-applicable" || usability === "usable") ? "observed-equal" : "unknown",
        originalSentAt: first?.sentAt ?? null,
        replaySentAt: replay?.sentAt ?? null,
        elapsedSeconds,
        equal: equality,
        expiresAt: replay?.expiresAt ?? first?.expiresAt ?? null,
        usability,
        repeatedSameSlot,
        twoTabs,
        intervalSupported: Boolean(supportedInterval),
      });
    }
  } catch {
    classification = "unknown";
  } finally {
    active = null;
    try {
      disposition = await driver.dispose();
    } catch {
      classification = "unknown";
    }
    globalThis.fetch = originalFetch;
  }
  if (!validateProviderObjectDisposition(disposition).ok) return refused("cleanup-incomplete");
  if (observations.length !== MAPPERS.length || observations.some((entry) => entry.classification === "unknown"))
    classification = "unknown";
  return {
    version: "provider-lifecycle-capture/v1",
    classification,
    reviewedHead: admission.reviewedHead,
    executedHead: admission.executedHead,
    journalHead: admission.journalHead,
    deployedHead: admission.deployedHead,
    apiVersion: admission.apiVersion,
    configDigest: admission.configDigest,
    providerMode: "test",
    plannedHttpAttempts: admission.maxHttpAttempts,
    actualHttpAttempts: attempts,
    plannedObjects: admission.maxObjects,
    actualLogicalCreations: objects.size,
    retentionGuarantee: admission.retentionGuarantee
      ? {
          source: "https://docs.stripe.com/api/idempotent_requests",
          seconds: admission.retentionGuarantee.seconds,
        }
      : null,
    observations,
    disposition,
    // Independent exact-head acceptance and the relied-on interval are host-owned, not self-certified here.
    replayQualified: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(refused("authority-unavailable")) + "\n");
  process.exitCode = 2;
}
