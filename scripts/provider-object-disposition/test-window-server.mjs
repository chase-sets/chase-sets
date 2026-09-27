import { createHash } from "node:crypto";

const resources = Object.freeze({
  customer: "customers",
  "setup-embedded": "setup_intents",
  "payment-saved": "payment_intents",
  "connect-setup": "account_sessions",
  "connect-manage": "account_sessions",
  "connect-notification": "account_sessions",
});
const digest = (value) => createHash("sha256").update(value).digest("hex");
const deny = () => {
  throw new Error("capture-target");
};

export function createServerFence({
  journal,
  configuration,
  fixtures,
  budget,
  send,
  signal,
  scenarioSignal,
  maxObjects = 6,
}) {
  const creations = new Set();
  const charges = new Set();
  const observations = [];
  const started = performance.now();
  let activeWindow;
  let modeRefused = false;
  return {
    activate(value) {
      activeWindow = value;
    },
    observations() {
      return structuredClone(observations);
    },
    creationCount() {
      return creations.size;
    },
    async fetch(target, init = {}) {
      const active = activeWindow;
      budget.take(active?.phase === "disposition" ? "disposition" : "scenario");
      if (!active || modeRefused || typeof target !== "string") deny();
      const url = new URL(target);
      if (
        url.origin !== "https://api.stripe.com" ||
        url.href !== target ||
        url.username ||
        url.password ||
        target.includes("#")
      )
        deny();
      const headers = new Headers(init.headers);
      if (headers.get("Stripe-Version") !== configuration.apiVersion || headers.has("Stripe-Account")) deny();
      const rows = await journal.readWindow(active.windowId);
      if (rows.length > 646 || rows.some((row) => row.key.windowId !== active.windowId)) deny();
      const method = init.method ?? "GET";
      const key = headers.get("Idempotency-Key");
      let row;
      let create = false;
      if (method === "POST") {
        if (url.search || target.includes("?")) deny();
        row = rows.find(
          (candidate) =>
            `evidence-window/v1:${candidate.key.windowId}:${candidate.key.objectClass}:${candidate.key.creationOrdinal}:${candidate.key.operation}` ===
            key,
        );
        if (
          !row ||
          !row.envelope ||
          row.state !== "pending" ||
          Date.now() >= Date.parse(row.replayDeadline) ||
          row.envelope.endpoint !== url.pathname ||
          row.envelope.method !== method ||
          row.envelope.apiVersion !== configuration.apiVersion ||
          row.envelope.connectedAccountReference !== null ||
          row.envelope.bodyText !== (init.body === undefined ? null : String(init.body))
        )
          deny();
        create = row.key.operation === "create";
        if (create) {
          if (
            active.phase === "disposition" ||
            row.binding.writerKind !== active.mapper ||
            url.pathname !== `/v1/${resources[active.mapper]}`
          )
            deny();
          if (
            !active.members.some(
              (member) =>
                member.writerKind === row.binding.writerKind &&
                member.logicalOperationId === row.binding.logicalOperationId &&
                member.ownerAccountId === row.binding.ownerAccountId,
            )
          )
            deny();
        } else {
          if (active.phase !== "disposition" || !["cancel-payment", "cancel-setup"].includes(row.binding.writerKind))
            deny();
          const original = rows.find(
            (candidate) =>
              candidate.key.operation === "create" &&
              candidate.key.objectClass === row.key.objectClass &&
              candidate.key.creationOrdinal === row.key.creationOrdinal,
          );
          if (
            !original?.providerReference ||
            row.envelope.target !== original.providerReference ||
            url.pathname !==
              `/v1/${row.key.objectClass === 3 ? "setup_intents" : "payment_intents"}/${original.providerReference}/cancel`
          )
            deny();
        }
      } else if (method === "GET" && (init.body === undefined || init.body === null)) {
        const include = new URLSearchParams([
          ["include[0]", "configuration.recipient"],
          ["include[1]", "requirements"],
          ["include[2]", "defaults"],
        ]);
        const account = `/v2/core/accounts/${fixtures.connectedAccount}?${include}`;
        const known = new Set([`/v1/customers/${fixtures.customerB}`]);
        for (const candidate of rows) {
          if (candidate.key.operation !== "create" || !candidate.providerReference) continue;
          if (
            !active.members.some(
              (member) =>
                member.writerKind === candidate.binding.writerKind &&
                member.logicalOperationId === candidate.binding.logicalOperationId &&
                member.ownerAccountId === candidate.binding.ownerAccountId,
            )
          )
            continue;
          const resource = { 2: "payment_intents", 3: "setup_intents", 5: "customers" }[candidate.key.objectClass];
          if (resource) known.add(`/v1/${resource}/${candidate.providerReference}`);
        }
        for (const charge of charges) known.add(`/v1/charges/${charge}`);
        if (
          target !== `https://api.stripe.com${account}` &&
          (url.search || target.includes("?") || !known.has(url.pathname))
        )
          deny();
        if (
          target === `https://api.stripe.com${account}` &&
          !["connect-setup", "connect-manage"].includes(active.mapper)
        )
          deny();
      } else deny();
      if (create && !creations.has(key) && creations.size >= maxObjects) deny();
      budget.assert(active.phase === "disposition" ? "disposition" : "scenario");
      if (create) creations.add(key);
      const sentAt = new Date().toISOString();
      const sendOffsetMilliseconds = performance.now() - started;
      const observation =
        method === "POST"
          ? {
              mapper: active.mapper,
              phase: active.phase,
              sentAt,
              sendOffsetMilliseconds,
              keyDigest: digest(key),
              version: row.version,
              replayDeadline: row.replayDeadline,
              requestDigest: digest(
                JSON.stringify([target, method, String(init.body ?? ""), configuration.apiVersion]),
              ),
              responseDigest: null,
              expiresAt: null,
              withheld: false,
            }
          : null;
      if (observation) observations.push(observation);
      const signals = [
        signal,
        active.phase === "disposition" ? null : scenarioSignal,
        AbortSignal.timeout(10000),
      ].filter(Boolean);
      const response = await send(target, { ...init, headers, redirect: "manual", signal: AbortSignal.any(signals) });
      if (response.status >= 300 && response.status < 400) deny();
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      if (!reader) deny();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 65536) deny();
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bytes = Buffer.concat(chunks);
      if (response.ok) {
        const body = JSON.parse(bytes.toString("utf8"));
        if (body.livemode !== false) {
          modeRefused = true;
          throw new Error("capture-mode-unobserved");
        }
        if (
          /^\/v1\/payment_intents\/[A-Za-z0-9_]+$/.test(url.pathname) &&
          typeof body.latest_charge === "string" &&
          /^ch_[A-Za-z0-9_]+$/.test(body.latest_charge)
        )
          charges.add(body.latest_charge);
        if (observation) {
          observation.responseDigest = digest(bytes);
          observation.expiresAt =
            Number.isSafeInteger(body.expires_at) && body.expires_at > 0
              ? new Date(body.expires_at * 1000).toISOString()
              : null;
          if (
            active.phase === "original" ||
            (active.phase === "disposition" &&
              !observations.some(
                (entry) => entry !== observation && entry.keyDigest === digest(key) && entry.responseDigest !== null,
              ))
          ) {
            observation.withheld = true;
            throw new Error("capture-response-withheld");
          }
        }
      }
      return new Response(bytes, { status: response.status, headers: response.headers });
    },
  };
}
