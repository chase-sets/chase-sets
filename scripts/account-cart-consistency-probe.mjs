#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const ACCOUNT_CART_CONSISTENCY_PROBE_VERSION = "account-cart-consistency-probe/v1";
export const ACCOUNT_CART_PROBE_OUTCOMES = Object.freeze([
  "missing_strategy",
  "optimistic_applied",
  "freshness_timeout",
  "rollback",
  "reconciliation",
  "stale_response_discard",
]);
export const ACCOUNT_CART_PROBE_AUTOMATION_CONTRACT = Object.freeze({
  mode: "doc-backed-observation",
  reason:
    "The probe records and gates redacted account-cart post-write consistency observations supplied by the owning runtime or browser smoke. It does not create live cart mutations itself until account-cart fixture ownership and cleanup are explicit.",
  routeTemplate: "/account/cart",
  interpretationRunbook: "docs/runbooks/account-cart-consistency-probe.md",
  telemetryMetric: "chase_sets_post_write_consistency_events_total",
});

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ACCOUNT_ID_PATTERN = /\b(?:account|acct|usr|user)_[0-9A-Za-z_:-]+\b/g;
const CART_ID_PATTERN = /\b(?:cart|crt)_[0-9A-Za-z_:-]+\b/g;
const CHECKOUT_SESSION_ID_PATTERN = /\bchk_[0-9A-Za-z_:-]+\b/g;
const RAW_AFTER_WRITE_PATTERN = /afterWrite=[^&\s")]+|Chase-Sets-Read-After-Write["':=\s]+[^"',\s)]+/gi;
const COOKIE_OR_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._-]+|chase_sets_(?:session|guest_checkout)=[^;\s]+/gi;
const FULL_URL_PATTERN = /https?:\/\/[^\s"]+/gi;

export function parseAccountCartConsistencyProbeArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("ACCOUNT_CART_CONSISTENCY_PROBE_OUT", env),
    observationPath:
      readOption(argv, "--observation-file") ?? readEnv("ACCOUNT_CART_CONSISTENCY_PROBE_OBSERVATION_FILE", env),
    environment:
      readOption(argv, "--environment") ?? readEnv("ACCOUNT_CART_CONSISTENCY_PROBE_ENVIRONMENT", env) ?? "staging",
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    evidenceReference:
      readOption(argv, "--evidence-reference") ?? readEnv("ACCOUNT_CART_CONSISTENCY_PROBE_EVIDENCE_REFERENCE", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    routeTemplate:
      readOption(argv, "--route-template") ??
      readEnv("ACCOUNT_CART_CONSISTENCY_PROBE_ROUTE_TEMPLATE", env) ??
      "/account/cart",
  };
}

export async function runAccountCartConsistencyProbe(options) {
  if (!options.observationPath && typeof options.observe !== "function") {
    throw new Error("ACCOUNT_CART_CONSISTENCY_PROBE_OBSERVATION_FILE or --observation-file is required.");
  }

  const observation =
    typeof options.observe === "function"
      ? await options.observe(options)
      : JSON.parse(await readFile(options.observationPath, "utf8"));
  if (assertRedactedAccountCartConsistencyEvidence({ observation }).length > 0) {
    throw new Error("Account-cart consistency probe evidence leaked sensitive values.");
  }
  const evidence = buildAccountCartConsistencyProbeEvidence({ ...options, observation });
  const leaks = assertRedactedAccountCartConsistencyEvidence(evidence);
  if (leaks.length > 0) {
    throw new Error(`Account-cart consistency probe evidence leaked sensitive values: ${leaks.join(", ")}`);
  }

  if (options.outPath) {
    await writeJsonRecord(options.outPath, evidence);
  }

  return evidence;
}

export function buildAccountCartConsistencyProbeEvidence(input) {
  const observation = input.observation ?? {};
  const outcomes = classifyAccountCartConsistencyOutcomes(observation);
  const blockers = [];

  if (outcomes.includes("missing_strategy")) {
    blockers.push("Account cart mutation did not declare a post-write consistency strategy.");
  }
  if (!outcomes.includes("optimistic_applied")) {
    blockers.push("Account cart probe did not observe the optimistic cart update.");
  }
  if (!outcomes.includes("reconciliation")) {
    blockers.push("Account cart probe did not observe server reconciliation after the write.");
  }
  if (!outcomes.includes("stale_response_discard")) {
    blockers.push("Account cart probe did not observe stale response discard protection.");
  }
  if (outcomes.includes("freshness_timeout")) {
    blockers.push("Account cart probe observed a post-write freshness timeout.");
  }
  if (observation.unexpectedRollback === true) {
    blockers.push("Account cart probe observed an unexpected rollback.");
  }
  if (assertRedactedAccountCartConsistencyEvidence({ observation }).length > 0) {
    blockers.push(
      "Observation input contains sensitive account-cart data and must be replaced with redacted evidence.",
    );
  }

  return {
    schemaVersion: ACCOUNT_CART_CONSISTENCY_PROBE_VERSION,
    checkedAt: input.checkedAt,
    releaseCommit: normalizeString(input.releaseCommit) ?? "",
    environment: normalizeString(input.environment) ?? "staging",
    routeTemplate: sanitizeRouteTemplate(input.routeTemplate),
    surface: "account-cart",
    strategy: normalizeStrategy(observation.strategy),
    observedOutcomes: outcomes,
    promotionDecision: blockers.length === 0 ? "promote" : "abort",
    blockers,
    latencyMs: normalizeOptionalNonNegativeInteger(observation.latencyMs),
    reconciliationLatencyMs: normalizeOptionalNonNegativeInteger(observation.reconciliationLatencyMs),
    staleResponseAgeMs: normalizeOptionalNonNegativeInteger(observation.staleResponseAgeMs),
    rollbackReasonCategory: normalizeCategory(observation.rollbackReasonCategory),
    evidenceReference: normalizeString(input.evidenceReference),
    telemetry: {
      metric: "chase_sets_post_write_consistency_events_total",
      requiredLabels: {
        context: "checkout",
        surface: "account-cart",
        route_id: "account-cart",
        route_template: sanitizeRouteTemplate(input.routeTemplate),
        correction_source: "fresh-read:loader-revalidation",
      },
      outcomes: ACCOUNT_CART_PROBE_OUTCOMES,
    },
    automation: ACCOUNT_CART_PROBE_AUTOMATION_CONTRACT,
    redaction: {
      accountId: "never-recorded",
      cartId: "never-recorded",
      email: "never-recorded",
      sessionToken: "never-recorded",
      cookie: "never-recorded",
      afterWrite: "never-recorded",
      checkoutSessionId: "never-recorded",
      eventIds: "never-recorded",
      fullUrls: "never-recorded",
    },
  };
}

export function classifyAccountCartConsistencyOutcomes(observation = {}) {
  const outcomes = [];
  if (!normalizeStrategy(observation.strategy) || observation.strategyConfigured === false) {
    outcomes.push("missing_strategy");
  }
  if (observation.optimisticApplied === true) {
    outcomes.push("optimistic_applied");
  }
  if (observation.freshnessTimedOut === true) {
    outcomes.push("freshness_timeout");
  }
  if (observation.rollbackObserved === true || observation.unexpectedRollback === true) {
    outcomes.push("rollback");
  }
  if (observation.reconciliationObserved === true) {
    outcomes.push("reconciliation");
  }
  if (observation.staleResponseDiscarded === true) {
    outcomes.push("stale_response_discard");
  }
  return outcomes;
}

export function assertRedactedAccountCartConsistencyEvidence(evidence) {
  const serialized = JSON.stringify(evidence);
  const leaks = [];
  for (const pattern of [
    EMAIL_PATTERN,
    ACCOUNT_ID_PATTERN,
    CART_ID_PATTERN,
    CHECKOUT_SESSION_ID_PATTERN,
    RAW_AFTER_WRITE_PATTERN,
    COOKIE_OR_TOKEN_PATTERN,
    FULL_URL_PATTERN,
  ]) {
    const match = serialized.match(pattern);
    if (match) {
      leaks.push(...match);
    }
  }
  return [...new Set(leaks)];
}

function normalizeStrategy(value) {
  const strategy = normalizeString(value);
  if (
    strategy === "fresh-read" ||
    strategy === "optimistic-with-correction" ||
    strategy === "snapshot-return" ||
    strategy === "realtime-correction"
  ) {
    return strategy;
  }
  return null;
}

function normalizeCategory(value) {
  const category = normalizeString(value);
  if (!category) {
    return null;
  }
  return category.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || null;
}

function sanitizeRouteTemplate(value) {
  const routeTemplate = normalizeString(value) ?? "/account/cart";
  return routeTemplate
    .split("/")
    .map((part) => {
      if (!part || part.startsWith(":")) {
        return part;
      }
      if (/^[a-z]{2,12}_[A-Za-z0-9]+$/.test(part) || /^[0-9A-Fa-f-]{12,}$/.test(part)) {
        return ":id";
      }
      return part;
    })
    .join("/")
    .replace(/[^A-Za-z0-9_./:-]+/g, "_")
    .slice(0, 160);
}

function normalizeOptionalNonNegativeInteger(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = Number.parseInt(String(value), 10);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

async function main(argv, env = process.env) {
  try {
    const evidence = await runAccountCartConsistencyProbe(parseAccountCartConsistencyProbeArgs(argv, env));
    console.log(JSON.stringify(evidence, null, 2));
    return evidence.promotionDecision === "promote" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
