#!/usr/bin/env node
// Redacted staging-only checkout order-readiness trace for payment-start blockers.
//
// This script is intentionally diagnostic-only: it uses read-only SQL against
// staging context databases and writes only sanitized counts, presence values,
// statuses, positions, and ages. It never calls provider APIs and never dumps
// payloads or metadata.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { postgresClientConfig, postgresFailureFields } from "./lib/postgres-connection.mjs";

export const CHECKOUT_ORDER_READINESS_TRACE_VERSION = "checkout-order-readiness-trace/v1";
export const REQUIRED_CONFIRM_TEXT = "collect redacted staging order-readiness trace";
export const DEFAULT_WINDOW_MINUTES = 30;
export const MIN_WINDOW_MINUTES = 1;
export const MAX_WINDOW_MINUTES = 240;

export const REQUIRED_PROJECTION_TRACES = Object.freeze([
  {
    sourceContextName: "ordering",
    targetContextName: "inventory",
    projectionName: "inventory-order-reservation-workflow",
    databaseContextName: "inventory",
  },
  {
    sourceContextName: "inventory",
    targetContextName: "ordering",
    projectionName: "ordering-inventory-reservation-outcomes",
    databaseContextName: "ordering",
  },
  {
    sourceContextName: "ordering",
    targetContextName: "payments",
    projectionName: "payments-order-input-projection",
    databaseContextName: "payments",
  },
]);

export const REQUIRED_WAKE_INTEREST = Object.freeze({
  sourceContextName: "ordering",
  eventType: "ordering.order.created",
  targetContextName: "inventory",
  projectionName: "inventory-order-reservation-workflow",
  checkpointKey: "inventory-order-reservation-workflow:ordering:v1",
  manifestContextName: "inventory",
});

const REQUIRED_CONTEXT_DATABASES = Object.freeze(["checkout", "ordering", "inventory", "payments"]);
const REQUIRED_RELAY_SOURCE_CONTEXTS = Object.freeze(["ordering", "inventory"]);
const DEFAULT_OUT_PATH = "artifacts/checkout-order-readiness-trace/trace.json";
const SENSITIVE_PATTERNS = Object.freeze([
  /postgres(?:ql)?:\/\/[^"'\s]+/gi,
  /https?:\/\/[^"'\s]+/gi,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  /\bBearer\s+[A-Za-z0-9._-]+/g,
  /\b(?:client_secret|processor_client_secret|cookie|token|sessionToken)\b/gi,
  /\b(?:acct|acc|usr|user|buyer|seller|addr|ord|pay|pi|pm|cs|cus|seti|tok)_[A-Za-z0-9_:-]{4,}\b/g,
]);

export function contextDatabaseEnvName(contextName) {
  return `DATABASE_URL_${String(contextName).toUpperCase().replaceAll("-", "_")}`;
}

export function parseCheckoutOrderReadinessTraceArgs(argv, env = process.env) {
  const windowMinutes = clampInteger(
    readOption(argv, "--window-minutes") ?? readEnv("TRACE_WINDOW_MINUTES", env),
    DEFAULT_WINDOW_MINUTES,
    MIN_WINDOW_MINUTES,
    MAX_WINDOW_MINUTES,
  );

  return {
    environment:
      readOption(argv, "--environment") ??
      readEnv("TRACE_ENVIRONMENT", env) ??
      readEnv("CHASE_SETS_ENVIRONMENT", env) ??
      "staging",
    checkoutSessionId: readOption(argv, "--checkout-session-id") ?? readEnv("TRACE_CHECKOUT_SESSION_ID", env),
    observedAtUtc: readOption(argv, "--observed-at-utc") ?? readEnv("TRACE_OBSERVED_AT_UTC", env),
    windowMinutes,
    confirm: readOption(argv, "--confirm") ?? readEnv("TRACE_CONFIRM", env),
    outPath: readOption(argv, "--out") ?? readEnv("TRACE_OUT", env) ?? DEFAULT_OUT_PATH,
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    controlDatabaseUrl: readEnv("PLATFORM_CONTROL_DATABASE_URL", env),
    workerWakeDisabledProjections: parseProjectionKeyList(readEnv("WORKER_WAKE_DISABLED_PROJECTIONS", env)),
    contextDatabaseUrls: Object.fromEntries(
      REQUIRED_CONTEXT_DATABASES.map((contextName) => [contextName, readEnv(contextDatabaseEnvName(contextName), env)]),
    ),
  };
}

export function validateCheckoutOrderReadinessTraceOptions(options) {
  const errors = [];
  if (
    String(options.environment ?? "")
      .trim()
      .toLowerCase() !== "staging"
  ) {
    errors.push("Trace environment must be exactly staging; production is refused.");
  }
  if (options.confirm !== REQUIRED_CONFIRM_TEXT) {
    errors.push(`Confirm text must be exactly "${REQUIRED_CONFIRM_TEXT}".`);
  }
  if (!normalizeString(options.checkoutSessionId)) {
    errors.push("--checkout-session-id or TRACE_CHECKOUT_SESSION_ID is required.");
  }
  if (!parseIsoUtc(options.observedAtUtc)) {
    errors.push("--observed-at-utc must be an ISO UTC timestamp.");
  }
  if (!Number.isInteger(options.windowMinutes)) {
    errors.push("--window-minutes must be an integer.");
  }
  if (!normalizeString(options.controlDatabaseUrl)) {
    errors.push("PLATFORM_CONTROL_DATABASE_URL is required.");
  }
  for (const contextName of REQUIRED_CONTEXT_DATABASES) {
    if (!normalizeString(options.contextDatabaseUrls?.[contextName])) {
      errors.push(`${contextDatabaseEnvName(contextName)} is required.`);
    }
  }
  for (const [name, value] of [
    ["PLATFORM_CONTROL_DATABASE_URL", options.controlDatabaseUrl],
    ...Object.entries(options.contextDatabaseUrls ?? {}).map(([contextName, databaseUrl]) => [
      contextDatabaseEnvName(contextName),
      databaseUrl,
    ]),
  ]) {
    if (
      String(value ?? "")
        .toLowerCase()
        .includes("production")
    ) {
      errors.push(`${name} appears to target production; production is refused.`);
    }
  }
  return errors;
}

export async function runCheckoutOrderReadinessTrace(options, deps) {
  const observedAt = parseIsoUtc(options.observedAtUtc);
  if (!observedAt) {
    throw new Error("observedAtUtc must be a valid ISO timestamp.");
  }

  const checkout = await deps.fetchCheckoutSession(options.checkoutSessionId, observedAt);
  const orderIds = checkout.orderIds;
  const ordering = await deps.fetchOrderingFacts(orderIds, observedAt, options.windowMinutes);
  const inventory = await deps.fetchInventoryFacts(orderIds, observedAt);
  const payments = attachPaymentsStaleness(
    await deps.fetchPaymentsFacts(orderIds, options.checkoutSessionId, observedAt),
    ordering,
  );
  const projectionState = await deps.fetchProjectionState(REQUIRED_PROJECTION_TRACES, observedAt);
  const relayCursors = await deps.fetchRelayCursors(REQUIRED_RELAY_SOURCE_CONTEXTS, observedAt);
  const wakeInterestDiagnostics = buildWakeInterestDiagnostics({
    disabledProjectionKeys: options.workerWakeDisabledProjections,
  });

  return buildCheckoutOrderReadinessTraceEvidence({
    checkedAt: options.checkedAt,
    observedAtUtc: observedAt.toISOString(),
    windowMinutes: options.windowMinutes,
    checkoutSessionId: options.checkoutSessionId,
    checkout,
    ordering,
    inventory,
    payments,
    projectionState,
    relayCursors,
    wakeInterestDiagnostics,
  });
}

export function buildCheckoutOrderReadinessTraceEvidence(input) {
  const orderCount = count(input.checkout.orderIds);
  const pendingPaymentRecorded = Boolean(input.ordering.pendingPaymentRecorded?.exists);
  const paymentInputCount = toFiniteNumber(input.payments.orderInputs?.rowCount) ?? 0;
  const paymentInputMissingCount =
    orderCount > 0 ? Math.max(0, orderCount - (toFiniteNumber(input.payments.orderInputs?.byOrderIdCount) ?? 0)) : 0;
  const pendingPaymentInputCount = toFiniteNumber(input.payments.orderInputs?.statusCounts?.["pending-payment"]) ?? 0;
  const paymentsInputPresentForAllOrders = orderCount > 0 && paymentInputMissingCount === 0;
  const paymentsInputAllPendingPayment =
    paymentsInputPresentForAllOrders && paymentInputCount > 0 && pendingPaymentInputCount === paymentInputCount;
  const stalePaymentInput = Boolean(input.payments.orderInputs?.staleRelativeToPendingPayment);
  const decision = classifyStalledLeg({
    pendingPaymentRecorded,
    paymentsInputPresentForAllOrders,
    paymentsInputAllPendingPayment,
    stalePaymentInput,
  });

  const evidence = {
    schemaVersion: CHECKOUT_ORDER_READINESS_TRACE_VERSION,
    issueNumbers: [2662, 2628],
    environment: "staging",
    checkedAt: input.checkedAt,
    observedAtUtc: input.observedAtUtc,
    windowMinutes: input.windowMinutes,
    checkoutSession: {
      referenceFingerprint: fingerprint(input.checkoutSessionId),
      present: input.checkout.present,
      sourceType: input.checkout.sourceType,
      orderIdCount: orderCount,
      orderIdPresence: orderCount > 0,
      paymentIdPresence: input.checkout.paymentIdPresence,
      orderWriteCommitPositions: summarizeCommitPositions(input.checkout.orderWriteCommitPositions),
      createdAgeMsAtObservedAt: ageMs(input.checkout.createdAt, input.observedAtUtc),
      updatedAgeMsAtObservedAt: ageMs(input.checkout.updatedAt, input.observedAtUtc),
    },
    ordering: sanitizeOrderingFacts(input.ordering),
    inventory: sanitizeInventoryFacts(input.inventory),
    payments: sanitizePaymentsFacts(input.payments, { orderCount, paymentInputMissingCount }),
    projectionState: input.projectionState,
    relayCursors: input.relayCursors,
    wakeInterestDiagnostics:
      input.wakeInterestDiagnostics ??
      buildWakeInterestDiagnostics({
        disabledProjectionKeys: [],
      }),
    decision,
    redaction: {
      identifiers: "hashed-or-presence-only",
      accountIds: "never-recorded",
      emails: "never-recorded",
      addresses: "never-recorded",
      buyerSellerNames: "never-recorded",
      providerReferences: "never-recorded",
      clientSecrets: "never-recorded",
      cookiesAndTokens: "never-recorded",
      fullUrls: "never-recorded",
      payloadsAndMetadata: "never-recorded",
      databaseUrls: "never-recorded",
    },
  };

  const leaks = assertRedactedTraceEvidence(evidence);
  if (leaks.length > 0) {
    throw new Error(`Checkout order-readiness trace leaked sensitive values: ${leaks.join(", ")}`);
  }

  return evidence;
}

export function classifyStalledLeg(input) {
  if (!input.pendingPaymentRecorded) {
    return {
      stalledLeg: "ordering-inventory-reservation-workflow-blockage",
      label: "Ordering/Inventory reservation workflow blockage",
      reason: "ordering.order.pending-payment-recorded was not observed for the checkout orders.",
    };
  }
  if (!input.paymentsInputPresentForAllOrders || input.stalePaymentInput) {
    return {
      stalledLeg: "payments-projection-wake-blockage",
      label: "Payments projection/wake blockage",
      reason: "Ordering recorded pending payment, but Payments order input is missing or stale.",
    };
  }
  if (input.paymentsInputAllPendingPayment) {
    return {
      stalledLeg: "checkout-retry-handoff-bug",
      label: "Checkout retry/handoff bug",
      reason: "Payments has pending-payment order input, so checkout should be able to retry or hand off.",
    };
  }
  return {
    stalledLeg: "unclassified-payment-start-blockage",
    label: "Unclassified payment-start blockage",
    reason: "The sanitized facts do not match the known #2628 decision branches.",
  };
}

export function renderTraceStepSummary(evidence) {
  const wakeRuntimeSummary = formatWakeRuntimeDiagnostics(evidence.projectionState.traces);
  const lines = [
    "## Checkout Order-Readiness Trace",
    "",
    `- Classified stalled leg: **${evidence.decision.label}**`,
    `- Checkout session present: ${formatBool(evidence.checkoutSession.present)}`,
    `- Order IDs present/count: ${formatBool(evidence.checkoutSession.orderIdPresence)} / ${evidence.checkoutSession.orderIdCount}`,
    `- Payment ID present: ${formatBool(evidence.checkoutSession.paymentIdPresence)}`,
    `- Pending-payment-recorded present/count: ${formatBool(evidence.ordering.pendingPaymentRecorded.present)} / ${evidence.ordering.pendingPaymentRecorded.count}`,
    `- Payments order inputs count/missing: ${evidence.payments.orderInputs.rowCount} / ${evidence.payments.orderInputs.missingOrderInputCount}`,
    "",
    "| Area | Sanitized facts |",
    "| --- | --- |",
    `| Inventory reservations | rows ${evidence.inventory.reservations.rowCount}; confirmed ${evidence.inventory.reservations.statusCounts.confirmed ?? 0}; rejected ${evidence.inventory.reservations.statusCounts.rejected ?? 0}; active holds ${evidence.inventory.reservations.activeHoldPresentCount} |`,
    `| Payments inputs | statuses ${formatCounts(evidence.payments.orderInputs.statusCounts)}; stale ${formatBool(evidence.payments.orderInputs.staleRelativeToPendingPayment)} |`,
    `| Payments by checkout source | count ${evidence.payments.paymentsByCheckoutSource.rowCount}; statuses ${formatCounts(evidence.payments.paymentsByCheckoutSource.statusCounts)} |`,
    `| Projection checkpoints | missing ${evidence.projectionState.missingCheckpointCount}; stale/behind ${evidence.projectionState.staleOrBehindCount}; wake queued/claimed/failed ${formatCounts(evidence.projectionState.wakeStateCounts)} |`,
    `| Wake runtime diagnostics | ${wakeRuntimeSummary} |`,
    `| Relay cursors | missing ${evidence.relayCursors.missingCount}; behind ${evidence.relayCursors.behindCount} |`,
    `| Wake interest | ordering created to inventory reservation ${formatBool(evidence.wakeInterestDiagnostics.interestPresent)}; disabled by env ${formatBool(evidence.wakeInterestDiagnostics.disabledByWorkerWakeDisabledProjections)} |`,
    "",
    "Sanitized artifact uploaded by this workflow contains only counts, booleans, statuses, positions, and ages.",
  ];
  return `${lines.join("\n")}\n`;
}

export function buildWakeInterestDiagnostics(input = {}) {
  const disabledProjectionKeys = parseProjectionKeyList(input.disabledProjectionKeys);
  const disabledProjectionKey = `${REQUIRED_WAKE_INTEREST.targetContextName}:${REQUIRED_WAKE_INTEREST.projectionName}`;
  const manifestInterest = input.manifestInterest ?? loadRequiredWakeInterestFromManifest();

  return {
    sourceContextName: REQUIRED_WAKE_INTEREST.sourceContextName,
    eventType: REQUIRED_WAKE_INTEREST.eventType,
    targetContextName: REQUIRED_WAKE_INTEREST.targetContextName,
    projectionName: REQUIRED_WAKE_INTEREST.projectionName,
    checkpointKey: REQUIRED_WAKE_INTEREST.checkpointKey,
    interestPresent: Boolean(manifestInterest?.interestPresent),
    manifestContextName: REQUIRED_WAKE_INTEREST.manifestContextName,
    disabledProjectionKey,
    disabledByWorkerWakeDisabledProjections: disabledProjectionKeys.includes(disabledProjectionKey),
  };
}

export function assertReadOnlySql(sql) {
  const normalized = String(sql ?? "")
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error("Checkout order-readiness trace only allows SELECT/WITH SQL.");
  }
  if (normalized.includes(";")) {
    throw new Error("Checkout order-readiness trace SQL must contain a single read-only statement.");
  }
  if (
    /\b(insert|update|delete|merge|alter|create|drop|truncate|grant|revoke|copy|call|do|vacuum|analyze|lock)\b/i.test(
      normalized,
    )
  ) {
    throw new Error("Checkout order-readiness trace refused non-read SQL.");
  }
  return normalized;
}

export function assertRedactedTraceEvidence(evidence) {
  const serialized = JSON.stringify(evidence);
  const leaks = [];
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = serialized.match(pattern);
    if (matches) {
      leaks.push(...matches);
    }
  }
  return [...new Set(leaks)].sort();
}

export async function createTraceDatabaseAdapter(options) {
  const { default: pg } = await import("pg");
  const clients = new Map();

  async function clientFor(url) {
    if (!clients.has(url)) {
      const client = new pg.Client(postgresClientConfig(url));
      await client.connect();
      clients.set(url, client);
    }
    return clients.get(url);
  }

  async function query(contextName, sql, params = []) {
    assertReadOnlySql(sql);
    const databaseUrl =
      contextName === "control" ? options.controlDatabaseUrl : options.contextDatabaseUrls?.[contextName];
    if (!databaseUrl) {
      throw new Error(`Database URL for context '${contextName}' is not configured.`);
    }
    const client = await clientFor(databaseUrl);
    return client.query(sql, params);
  }

  return {
    fetchCheckoutSession: async (checkoutSessionId) => {
      const result = await query(
        "checkout",
        `SELECT source_type,
                order_ids,
                order_write_commit_positions,
                payment_id IS NOT NULL AS payment_id_present,
                created_at,
                updated_at
         FROM checkout_session_pages
         WHERE session_id = $1`,
        [checkoutSessionId],
      );
      const row = result.rows[0];
      return {
        present: Boolean(row),
        sourceType: row?.source_type ?? null,
        orderIds: asStringArray(row?.order_ids),
        orderWriteCommitPositions: Array.isArray(row?.order_write_commit_positions)
          ? row.order_write_commit_positions
          : [],
        paymentIdPresence: Boolean(row?.payment_id_present),
        createdAt: row?.created_at ?? null,
        updatedAt: row?.updated_at ?? null,
      };
    },
    fetchOrderingFacts: async (orderIds, observedAt, windowMinutes) =>
      fetchOrderingFacts(query, orderIds, observedAt, windowMinutes),
    fetchInventoryFacts: async (orderIds, observedAt) => fetchInventoryFacts(query, orderIds, observedAt),
    fetchPaymentsFacts: async (orderIds, checkoutSessionId, observedAt) =>
      fetchPaymentsFacts(query, orderIds, checkoutSessionId, observedAt),
    fetchProjectionState: async (projectionTraces, observedAt) =>
      fetchProjectionState(query, projectionTraces, observedAt),
    fetchRelayCursors: async (sourceContexts, observedAt) => fetchRelayCursors(query, sourceContexts, observedAt),
    close: async () => {
      for (const client of clients.values()) {
        await client.end().catch(() => undefined);
      }
      clients.clear();
    },
  };
}

async function fetchOrderingFacts(query, orderIds, observedAt, windowMinutes) {
  if (orderIds.length === 0) {
    return emptyOrderingFacts();
  }
  const orderRows = await query(
    "ordering",
    `SELECT status, source_type, created_at, updated_at
     FROM ordering_order_pages
     WHERE order_id = ANY($1::text[])`,
    [orderIds],
  );
  const streamIds = orderIds.map((orderId) => `ordering.order-${orderId}`);
  const events = await query(
    "ordering",
    `SELECT event_type,
            COUNT(*)::integer AS count,
            MIN(global_position)::text AS min_global_position,
            MAX(global_position)::text AS max_global_position,
            MIN(recorded_at) AS first_recorded_at,
            MAX(recorded_at) AS last_recorded_at,
            COUNT(*) FILTER (
              WHERE recorded_at >= ($2::timestamptz - ($3::integer * INTERVAL '1 minute'))
                AND recorded_at <= ($2::timestamptz + ($3::integer * INTERVAL '1 minute'))
            )::integer AS count_in_window
     FROM event_store_events
     WHERE stream_id = ANY($1::text[])
     GROUP BY event_type
     ORDER BY event_type`,
    [streamIds, observedAt.toISOString(), windowMinutes],
  );
  const pendingPaymentEvents = events.rows.find((row) => row.event_type === "ordering.order.pending-payment-recorded");
  return {
    orderRows: {
      rowCount: orderRows.rows.length,
      statusCounts: countBy(orderRows.rows, "status"),
      sourceTypeCounts: countBy(orderRows.rows, "source_type"),
      maxUpdatedAgeMsAtObservedAt: maxAgeMs(
        orderRows.rows.map((row) => row.updated_at),
        observedAt,
      ),
    },
    events: {
      eventTypeCounts: Object.fromEntries(events.rows.map((row) => [row.event_type, toFiniteNumber(row.count) ?? 0])),
      eventTypeWindowCounts: Object.fromEntries(
        events.rows.map((row) => [row.event_type, toFiniteNumber(row.count_in_window) ?? 0]),
      ),
      minGlobalPosition: minStringNumber(events.rows.map((row) => row.min_global_position)),
      maxGlobalPosition: maxStringNumber(events.rows.map((row) => row.max_global_position)),
    },
    pendingPaymentRecorded: {
      exists: Boolean(pendingPaymentEvents),
      count: toFiniteNumber(pendingPaymentEvents?.count) ?? 0,
      maxGlobalPosition: pendingPaymentEvents?.max_global_position ?? null,
      lastRecordedAt: pendingPaymentEvents?.last_recorded_at ?? null,
      lastRecordedAgeMsAtObservedAt: ageMs(pendingPaymentEvents?.last_recorded_at, observedAt),
    },
  };
}

async function fetchInventoryFacts(query, orderIds, observedAt) {
  if (orderIds.length === 0) {
    return emptyInventoryFacts();
  }
  const reservations = await query(
    "inventory",
    `SELECT status,
            hold_id IS NOT NULL AS hold_present,
            released_at IS NOT NULL AS released,
            updated_at
     FROM inventory_reservation_pages
     WHERE order_id = ANY($1::text[])`,
    [orderIds],
  );
  return {
    reservations: {
      rowCount: reservations.rows.length,
      statusCounts: countBy(reservations.rows, "status"),
      holdPresentCount: reservations.rows.filter((row) => row.hold_present).length,
      activeHoldPresentCount: reservations.rows.filter(
        (row) => row.status === "confirmed" && row.hold_present && !row.released,
      ).length,
      releasedCount: reservations.rows.filter((row) => row.released).length,
      maxUpdatedAgeMsAtObservedAt: maxAgeMs(
        reservations.rows.map((row) => row.updated_at),
        observedAt,
      ),
    },
  };
}

async function fetchPaymentsFacts(query, orderIds, checkoutSessionId, observedAt) {
  const orderInputs = orderIds.length
    ? await query(
        "payments",
        `SELECT order_id,
                source_type,
                status,
                created_at,
                updated_at
         FROM payments_order_inputs
         WHERE order_id = ANY($1::text[])
            OR (source_type = 'checkout' AND source_reference_id = $2)`,
        [orderIds, checkoutSessionId],
      )
    : await query(
        "payments",
        `SELECT order_id,
                source_type,
                status,
                created_at,
                updated_at
         FROM payments_order_inputs
         WHERE source_type = 'checkout' AND source_reference_id = $1`,
        [checkoutSessionId],
      );
  const paymentsBySource = orderIds.length
    ? await query(
        "payments",
        `SELECT status, processor_status, updated_at
         FROM payments_payment_pages
         WHERE (source_context = 'checkout' AND source_reference_id = $1)
            OR order_ids ?| $2::text[]`,
        [checkoutSessionId, orderIds],
      )
    : await query(
        "payments",
        `SELECT status, processor_status, updated_at
         FROM payments_payment_pages
         WHERE source_context = 'checkout' AND source_reference_id = $1`,
        [checkoutSessionId],
      );

  return {
    orderInputs: {
      rowCount: orderInputs.rows.length,
      byOrderIdCount: new Set(orderInputs.rows.map((row) => row.order_id).filter(Boolean)).size,
      byCheckoutSourceCount: orderInputs.rows.filter((row) => row.source_type === "checkout").length,
      statusCounts: countBy(orderInputs.rows, "status"),
      maxUpdatedAt: maxDate(orderInputs.rows.map((row) => row.updated_at)),
      maxUpdatedAgeMsAtObservedAt: maxAgeMs(
        orderInputs.rows.map((row) => row.updated_at),
        observedAt,
      ),
    },
    paymentsByCheckoutSource: {
      rowCount: paymentsBySource.rows.length,
      statusCounts: countBy(paymentsBySource.rows, "status"),
      processorStatusCounts: countBy(paymentsBySource.rows, "processor_status"),
      maxUpdatedAgeMsAtObservedAt: maxAgeMs(
        paymentsBySource.rows.map((row) => row.updated_at),
        observedAt,
      ),
    },
  };
}

async function fetchProjectionState(query, projectionTraces, observedAt) {
  const traces = [];
  const wakeStateCounts = {};
  for (const trace of projectionTraces) {
    const checkpoint = await query(
      trace.databaseContextName,
      `SELECT projection_name,
              source_context_name,
              subscription_version,
              last_global_position::text AS last_global_position,
              lease_owner_id IS NOT NULL AS lease_owner_present,
              updated_at
       FROM event_subscription_checkpoints
       WHERE projection_name = $1
         AND source_context_name = $2
       ORDER BY subscription_version DESC
       LIMIT 1`,
      [trace.projectionName, trace.sourceContextName],
    );
    const wake = await query(
      "control",
      `SELECT state,
              COUNT(*)::integer AS count,
              MAX(required_position)::text AS max_required_position,
              MIN(next_eligible_at) AS oldest_next_eligible_at,
              MAX(updated_at) AS newest_updated_at
       FROM platform_projection_wake_intents
       WHERE source_context_name = $1
         AND target_context_name = $2
         AND projection_name = $3
       GROUP BY state
       ORDER BY state`,
      [trace.sourceContextName, trace.targetContextName, trace.projectionName],
    );
    const failedWakeDiagnostics = await query(
      "control",
      `SELECT attempt_count,
              required_position::text AS required_position,
              next_eligible_at,
              updated_at,
              last_error
       FROM platform_projection_wake_intents
       WHERE source_context_name = $1
         AND target_context_name = $2
         AND projection_name = $3
         AND state = 'failed'
       ORDER BY updated_at DESC
       LIMIT 5`,
      [trace.sourceContextName, trace.targetContextName, trace.projectionName],
    );
    const claimedWakeDiagnostics = await query(
      "control",
      `SELECT attempt_count,
              required_position::text AS required_position,
              claimed_required_position::text AS claimed_required_position,
              claimed_until,
              claimed_until <= $4::timestamptz AS stale_at_observed_at,
              next_eligible_at,
              updated_at
       FROM platform_projection_wake_intents
       WHERE source_context_name = $1
         AND target_context_name = $2
         AND projection_name = $3
         AND state = 'claimed'
       ORDER BY updated_at DESC
       LIMIT 5`,
      [trace.sourceContextName, trace.targetContextName, trace.projectionName, observedAt.toISOString()],
    );
    const readiness = await query(
      "control",
      `SELECT COUNT(*)::integer AS count,
              MAX(ready_position)::text AS max_ready_position,
              MAX(recorded_at) AS newest_recorded_at
       FROM platform_projection_checkpoint_readiness
       WHERE source_context_name = $1
         AND target_context_name = $2
         AND projection_name = $3`,
      [trace.sourceContextName, trace.targetContextName, trace.projectionName],
    );

    const checkpointRow = checkpoint.rows[0] ?? null;
    const stateCounts = Object.fromEntries(wake.rows.map((row) => [row.state, toFiniteNumber(row.count) ?? 0]));
    for (const [state, countValue] of Object.entries(stateCounts)) {
      wakeStateCounts[state] = (wakeStateCounts[state] ?? 0) + countValue;
    }
    traces.push({
      sourceContextName: trace.sourceContextName,
      targetContextName: trace.targetContextName,
      projectionName: trace.projectionName,
      checkpoint: checkpointRow
        ? {
            present: true,
            subscriptionVersion: toFiniteNumber(checkpointRow.subscription_version),
            lastGlobalPosition: checkpointRow.last_global_position,
            leaseOwnerPresent: Boolean(checkpointRow.lease_owner_present),
            updatedAgeMsAtObservedAt: ageMs(checkpointRow.updated_at, observedAt),
          }
        : {
            present: false,
            subscriptionVersion: null,
            lastGlobalPosition: null,
            leaseOwnerPresent: false,
            updatedAgeMsAtObservedAt: null,
          },
      wake: {
        stateCounts,
        maxRequiredPosition: maxStringNumber(wake.rows.map((row) => row.max_required_position)),
        oldestNextEligibleAgeMsAtObservedAt: maxAgeMs(
          wake.rows.map((row) => row.oldest_next_eligible_at),
          observedAt,
        ),
        newestUpdatedAgeMsAtObservedAt: minAgeMs(
          wake.rows.map((row) => row.newest_updated_at),
          observedAt,
        ),
        failedDiagnostics: summarizeWakeFailureDiagnostics(failedWakeDiagnostics.rows, observedAt),
        claimDiagnostics: summarizeWakeClaimDiagnostics(claimedWakeDiagnostics.rows, observedAt),
      },
      checkpointReadiness: {
        rowCount: toFiniteNumber(readiness.rows[0]?.count) ?? 0,
        maxReadyPosition: readiness.rows[0]?.max_ready_position ?? null,
        newestRecordedAgeMsAtObservedAt: ageMs(readiness.rows[0]?.newest_recorded_at, observedAt),
      },
    });
  }

  return {
    traces,
    missingCheckpointCount: traces.filter((trace) => !trace.checkpoint.present).length,
    staleOrBehindCount: traces.filter(
      (trace) =>
        trace.checkpoint.updatedAgeMsAtObservedAt !== null && trace.checkpoint.updatedAgeMsAtObservedAt > 120_000,
    ).length,
    wakeStateCounts,
  };
}

export function summarizeWakeFailureDiagnostics(rows, observedAt) {
  const samples = Array.isArray(rows) ? rows : [];
  const errors = samples.map((row) => readJsonRecord(row?.last_error));
  return {
    sampleCount: samples.length,
    maxAttemptCount: maxFiniteNumber(samples.map((row) => row?.attempt_count)),
    maxRequiredPosition: maxStringNumber(samples.map((row) => row?.required_position)),
    oldestNextEligibleAgeMsAtObservedAt: maxAgeMs(
      samples.map((row) => row?.next_eligible_at),
      observedAt,
    ),
    newestUpdatedAgeMsAtObservedAt: minAgeMs(
      samples.map((row) => row?.updated_at),
      observedAt,
    ),
    reasonCounts: countTokens(errors.map((error) => safeDiagnosticToken(error?.reason) ?? "unknown")),
    messageCategoryCounts: countTokens(errors.map((error) => classifyWakeErrorMessage(error?.message))),
    messageSampleCounts: countTokens(errors.map((error) => safeWakeErrorMessageSample(error?.message))),
    workerIdPresentCount: errors.filter((error) => normalizeString(error?.workerId)).length,
    checkpointPositionMax: maxStringNumber(errors.map((error) => error?.checkpointPosition)),
    requiredPositionFromErrorMax: maxStringNumber(errors.map((error) => error?.requiredPosition)),
    blockedStreamCountMax: maxFiniteNumber(errors.map((error) => error?.blockedStreamCount)),
    poisonEventCountMax: maxFiniteNumber(errors.map((error) => error?.poisonEventCount)),
  };
}

export function summarizeWakeClaimDiagnostics(rows, observedAt) {
  const samples = Array.isArray(rows) ? rows : [];
  return {
    sampleCount: samples.length,
    maxAttemptCount: maxFiniteNumber(samples.map((row) => row?.attempt_count)),
    maxRequiredPosition: maxStringNumber(samples.map((row) => row?.required_position)),
    maxClaimedRequiredPosition: maxStringNumber(samples.map((row) => row?.claimed_required_position)),
    staleAtObservedCount: samples.filter((row) => Boolean(row?.stale_at_observed_at)).length,
    oldestClaimedUntilAgeMsAtObservedAt: maxAgeMs(
      samples.map((row) => row?.claimed_until),
      observedAt,
    ),
    soonestClaimExpiresInMsAtObservedAt: minFutureMs(
      samples.map((row) => row?.claimed_until),
      observedAt,
    ),
    oldestNextEligibleAgeMsAtObservedAt: maxAgeMs(
      samples.map((row) => row?.next_eligible_at),
      observedAt,
    ),
    newestUpdatedAgeMsAtObservedAt: minAgeMs(
      samples.map((row) => row?.updated_at),
      observedAt,
    ),
  };
}

async function fetchRelayCursors(query, sourceContexts, observedAt) {
  const result = await query(
    "control",
    `SELECT source_context_name,
            last_fanout_position::text AS last_fanout_position,
            owner_id IS NOT NULL AS owner_present,
            updated_at
     FROM platform_projection_wake_relay_cursors
     WHERE source_context_name = ANY($1::text[])`,
    [sourceContexts],
  );
  const bySource = new Map(result.rows.map((row) => [row.source_context_name, row]));
  const cursors = sourceContexts.map((sourceContextName) => {
    const row = bySource.get(sourceContextName);
    return row
      ? {
          sourceContextName,
          present: true,
          lastFanoutPosition: row.last_fanout_position,
          ownerPresent: Boolean(row.owner_present),
          updatedAgeMsAtObservedAt: ageMs(row.updated_at, observedAt),
        }
      : {
          sourceContextName,
          present: false,
          lastFanoutPosition: null,
          ownerPresent: false,
          updatedAgeMsAtObservedAt: null,
        };
  });
  return {
    cursors,
    missingCount: cursors.filter((cursor) => !cursor.present).length,
    behindCount: cursors.filter((cursor) => cursor.present && cursor.updatedAgeMsAtObservedAt > 120_000).length,
  };
}

function sanitizeOrderingFacts(ordering) {
  return {
    orderRows: ordering.orderRows,
    events: ordering.events,
    pendingPaymentRecorded: {
      present: Boolean(ordering.pendingPaymentRecorded?.exists),
      count: toFiniteNumber(ordering.pendingPaymentRecorded?.count) ?? 0,
      maxGlobalPosition: ordering.pendingPaymentRecorded?.maxGlobalPosition ?? null,
      lastRecordedAgeMsAtObservedAt: ordering.pendingPaymentRecorded?.lastRecordedAgeMsAtObservedAt ?? null,
    },
  };
}

function sanitizeInventoryFacts(inventory) {
  return {
    reservations: inventory.reservations,
  };
}

function sanitizePaymentsFacts(payments, summary) {
  const orderInputs = {
    ...payments.orderInputs,
    missingOrderInputCount: summary.paymentInputMissingCount,
    staleRelativeToPendingPayment: Boolean(payments.orderInputs?.staleRelativeToPendingPayment),
  };
  delete orderInputs.maxUpdatedAt;
  return {
    orderInputs,
    paymentsByCheckoutSource: payments.paymentsByCheckoutSource,
  };
}

export function attachPaymentsStaleness(payments, ordering) {
  const pendingAt = ordering.pendingPaymentRecorded?.lastRecordedAt
    ? Date.parse(ordering.pendingPaymentRecorded.lastRecordedAt)
    : NaN;
  const inputUpdatedAt = payments.orderInputs?.maxUpdatedAt ? Date.parse(payments.orderInputs.maxUpdatedAt) : NaN;
  return {
    ...payments,
    orderInputs: {
      ...payments.orderInputs,
      staleRelativeToPendingPayment:
        Number.isFinite(pendingAt) && (!Number.isFinite(inputUpdatedAt) || inputUpdatedAt < pendingAt),
    },
  };
}

function emptyOrderingFacts() {
  return {
    orderRows: { rowCount: 0, statusCounts: {}, sourceTypeCounts: {}, maxUpdatedAgeMsAtObservedAt: null },
    events: { eventTypeCounts: {}, eventTypeWindowCounts: {}, minGlobalPosition: null, maxGlobalPosition: null },
    pendingPaymentRecorded: {
      exists: false,
      count: 0,
      maxGlobalPosition: null,
      lastRecordedAt: null,
      lastRecordedAgeMsAtObservedAt: null,
    },
  };
}

function emptyInventoryFacts() {
  return {
    reservations: {
      rowCount: 0,
      statusCounts: {},
      holdPresentCount: 0,
      activeHoldPresentCount: 0,
      releasedCount: 0,
      maxUpdatedAgeMsAtObservedAt: null,
    },
  };
}

function summarizeCommitPositions(value) {
  if (!Array.isArray(value)) {
    return {
      valueType: typeof value,
      entryCount: 0,
      sourceContextCounts: {},
      eventIdCount: 0,
      maxGlobalPosition: null,
    };
  }
  const sourceContextCounts = {};
  let eventIdCount = 0;
  const positions = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const sourceContextName = normalizeString(entry.sourceContextName) ?? "unknown";
    sourceContextCounts[sourceContextName] = (sourceContextCounts[sourceContextName] ?? 0) + 1;
    if (Array.isArray(entry.eventIds)) {
      eventIdCount += entry.eventIds.length;
    }
    if (entry.maxGlobalPosition !== undefined) {
      positions.push(entry.maxGlobalPosition);
    }
  }
  return {
    valueType: "array",
    entryCount: value.length,
    sourceContextCounts,
    eventIdCount,
    maxGlobalPosition: maxStringNumber(positions),
  };
}

function fingerprint(value) {
  const normalized = String(value ?? "");
  if (!normalized) {
    return null;
  }
  return `sha256:${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function parseIsoUtc(value) {
  const text = normalizeString(value);
  if (!text || !text.endsWith("Z")) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function parseProjectionKeyList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))].sort();
  }
  return [
    ...new Set(
      String(value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function loadRequiredWakeInterestFromManifest() {
  const manifestPath = fileURLToPath(new URL("../bounded-contexts/inventory/context.json", import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const subscription = (manifest.eventSubscriptions ?? []).find(
    (entry) =>
      entry?.sourceContextName === REQUIRED_WAKE_INTEREST.sourceContextName &&
      entry?.projectionName === REQUIRED_WAKE_INTEREST.projectionName &&
      Array.isArray(entry?.eventTypes) &&
      entry.eventTypes.includes(REQUIRED_WAKE_INTEREST.eventType),
  );
  const projectionGroup = (manifest.projectionGroups ?? []).find(
    (entry) =>
      entry?.projectionName === REQUIRED_WAKE_INTEREST.projectionName &&
      Array.isArray(entry?.sourceContextNames) &&
      entry.sourceContextNames.includes(REQUIRED_WAKE_INTEREST.sourceContextName),
  );
  const checkpointKey =
    subscription?.projectionName && subscription?.sourceContextName && subscription?.subscriptionVersion
      ? `${subscription.projectionName}:${subscription.sourceContextName}:v${subscription.subscriptionVersion}`
      : null;

  return {
    interestPresent: Boolean(subscription && projectionGroup && checkpointKey === REQUIRED_WAKE_INTEREST.checkpointKey),
  };
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.length > 0) : [];
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function countBy(rows, propertyName) {
  const counts = {};
  for (const row of rows ?? []) {
    const value = normalizeString(row?.[propertyName]) ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function countTokens(values) {
  const counts = {};
  for (const value of values ?? []) {
    const token = safeDiagnosticToken(value) ?? "unknown";
    counts[token] = (counts[token] ?? 0) + 1;
  }
  return counts;
}

function readJsonRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function safeDiagnosticToken(value) {
  const text = normalizeString(value);
  if (!text) {
    return null;
  }
  if (containsSensitivePattern(text)) {
    return "redacted-sensitive-token";
  }
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "unknown";
}

function classifyWakeErrorMessage(value) {
  const text = normalizeString(value);
  if (!text) {
    return "none";
  }
  if (containsSensitivePattern(text)) {
    return "message-redacted-sensitive";
  }

  const lower = text.toLowerCase();
  if (lower.includes("statement timeout") || lower.includes("canceling statement due to statement timeout")) {
    return "statement-timeout";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "timeout";
  }
  if (lower.includes("deadlock")) {
    return "deadlock";
  }
  if (lower.includes("duplicate key") || lower.includes("unique constraint") || lower.includes("violates")) {
    return "constraint-violation";
  }
  if (lower.includes("does not exist") || lower.includes("undefined_table") || lower.includes("undefined column")) {
    return "schema-missing";
  }
  if (lower.includes("permission denied")) {
    return "permission-denied";
  }
  if (lower.includes("connection") || lower.includes("econnreset") || lower.includes("etimedout")) {
    return "connection-failure";
  }
  if (lower.includes("lease") || lower.includes("claim")) {
    return "lease-or-claim";
  }
  if (lower.includes("abort")) {
    return "aborted";
  }
  return "message-present";
}

function safeWakeErrorMessageSample(value) {
  const text = normalizeString(value);
  if (!text) {
    return "none";
  }
  if (containsSensitivePattern(text)) {
    return "redacted-sensitive-message";
  }
  return safeDiagnosticToken(
    text
      .replace(/\b[A-Za-z][A-Za-z0-9]{1,12}_[A-Za-z0-9_:-]{4,}\b/g, "id")
      .replace(/\b[0-9a-f]{16,}\b/gi, "hex")
      .replace(/[.]+/g, " "),
  );
}

function containsSensitivePattern(value) {
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      return true;
    }
  }
  return false;
}

function ageMs(value, observedAt) {
  const timestamp = Date.parse(String(value ?? ""));
  const observed = observedAt instanceof Date ? observedAt.getTime() : Date.parse(String(observedAt ?? ""));
  if (!Number.isFinite(timestamp) || !Number.isFinite(observed)) {
    return null;
  }
  return Math.max(0, Math.round(observed - timestamp));
}

function maxAgeMs(values, observedAt) {
  const ages = values.map((value) => ageMs(value, observedAt)).filter((value) => value !== null);
  return ages.length === 0 ? null : Math.max(...ages);
}

function minAgeMs(values, observedAt) {
  const ages = values.map((value) => ageMs(value, observedAt)).filter((value) => value !== null);
  return ages.length === 0 ? null : Math.min(...ages);
}

function minFutureMs(values, observedAt) {
  const observed = observedAt instanceof Date ? observedAt.getTime() : Date.parse(String(observedAt ?? ""));
  if (!Number.isFinite(observed)) {
    return null;
  }
  const deltas = values
    .map((value) => Date.parse(String(value ?? "")))
    .filter((timestamp) => Number.isFinite(timestamp))
    .map((timestamp) => Math.max(0, Math.round(timestamp - observed)));
  return deltas.length === 0 ? null : Math.min(...deltas);
}

function maxDate(values) {
  const dates = values
    .map((value) => {
      const timestamp = Date.parse(String(value ?? ""));
      return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
    })
    .filter(Boolean)
    .sort();
  return dates.at(-1) ?? null;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function maxFiniteNumber(values) {
  const numbers = values.map(toFiniteNumber).filter((value) => value !== null);
  return numbers.length === 0 ? null : Math.max(...numbers);
}

function maxStringNumber(values) {
  let max = null;
  for (const value of values) {
    const parsed = toBigInt(value);
    if (parsed === null) {
      continue;
    }
    if (max === null || parsed > max) {
      max = parsed;
    }
  }
  return max === null ? null : max.toString();
}

function minStringNumber(values) {
  let min = null;
  for (const value of values) {
    const parsed = toBigInt(value);
    if (parsed === null) {
      continue;
    }
    if (min === null || parsed < min) {
      min = parsed;
    }
  }
  return min === null ? null : min.toString();
}

function toBigInt(value) {
  try {
    return value === null || value === undefined || value === "" ? null : BigInt(String(value));
  } catch {
    return null;
  }
}

function formatBool(value) {
  return value ? "yes" : "no";
}

function formatCounts(counts) {
  const entries = Object.entries(counts ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? "none" : entries.map(([name, value]) => `${name}:${value}`).join(", ");
}

function formatWakeRuntimeDiagnostics(traces) {
  const summaries = [];
  for (const trace of traces ?? []) {
    const diagnostics = trace?.wake?.failedDiagnostics;
    const claimDiagnostics = trace?.wake?.claimDiagnostics;
    if (!diagnostics || diagnostics.sampleCount === 0) {
      if (!claimDiagnostics || claimDiagnostics.sampleCount === 0) {
        continue;
      }
      summaries.push(
        `${trace.targetContextName}/${trace.projectionName} claimed samples ${
          claimDiagnostics.sampleCount
        }; stale claims ${claimDiagnostics.staleAtObservedCount}; max attempts ${
          claimDiagnostics.maxAttemptCount ?? "unknown"
        }; claim expires in ${claimDiagnostics.soonestClaimExpiresInMsAtObservedAt ?? "unknown"}ms`,
      );
      continue;
    }
    summaries.push(
      `${trace.targetContextName}/${trace.projectionName} samples ${diagnostics.sampleCount}; reasons ${formatCounts(
        diagnostics.reasonCounts,
      )}; messages ${formatCounts(diagnostics.messageCategoryCounts)}; message samples ${formatCounts(
        diagnostics.messageSampleCounts,
      )}; max attempts ${diagnostics.maxAttemptCount ?? "unknown"}`,
    );
  }
  return summaries.length === 0 ? "none" : summaries.join("; ");
}

async function main(argv, env = process.env) {
  let adapter = null;
  try {
    const options = parseCheckoutOrderReadinessTraceArgs(argv, env);
    const errors = validateCheckoutOrderReadinessTraceOptions(options);
    if (errors.length > 0) {
      console.error(errors.join(" "));
      return 2;
    }

    adapter = await createTraceDatabaseAdapter(options);
    const rawEvidence = await runCheckoutOrderReadinessTrace(options, {
      fetchCheckoutSession: adapter.fetchCheckoutSession,
      fetchOrderingFacts: adapter.fetchOrderingFacts,
      fetchInventoryFacts: adapter.fetchInventoryFacts,
      fetchPaymentsFacts: adapter.fetchPaymentsFacts,
      fetchProjectionState: adapter.fetchProjectionState,
      fetchRelayCursors: adapter.fetchRelayCursors,
    });

    await writeJsonRecord(options.outPath, rawEvidence);
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, renderTraceStepSummary(rawEvidence));
    }
    console.log(`Wrote sanitized checkout order-readiness trace to ${options.outPath}.`);
    console.log(`Classified stalled leg: ${rawEvidence.decision.stalledLeg}.`);
    return 0;
  } catch (error) {
    console.error(JSON.stringify(postgresFailureFields(error)));
    return 2;
  } finally {
    await adapter?.close?.();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--")));
}
