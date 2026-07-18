#!/usr/bin/env node
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const defaultAttempts = 24;
const defaultDelayMs = 5000;
// Fail-fast tuning for deterministic ingress topology failures.
// A ready ingress that has no matching host/route rule answers with a stable
// 404. That is not a warming backend, so it must not consume the full retry
// budget. We only declare a topology failure once the same URL has returned
// 404 on several *consecutive* probes AND a minimum warmup grace has elapsed,
// so ordinary pod convergence (which typically surfaces as connection refused,
// 502/503, or a transient 404 that clears) is never misread as a route defect.
const defaultTopologyStreak = 4;
const defaultWarmupGraceMs = 60000;

export async function probeIngressUrl(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is unavailable; run with Node.js 18 or newer.");
  }

  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    signal: options.signal,
  });

  return {
    url,
    status: response.status,
    ok:
      options.expectedStatus == null
        ? response.status >= 200 && response.status < 400
        : response.status === options.expectedStatus,
  };
}

/**
 * Classify a single probe result into a readiness disposition:
 * - "ready": the ingress served a success/redirect status.
 * - "topology": a deterministic 404 (a ready ingress with no matching route).
 * - "transient": anything else (connection refused, DNS not resolved, 5xx,
 *   or any other status) that a still-converging rollout can legitimately
 *   emit before it becomes ready.
 */
export function classifyProbeResult(result) {
  if (result.ok) {
    return "ready";
  }
  if (result.status === 404) {
    return "topology";
  }
  return "transient";
}

export class IngressReadinessError extends Error {
  constructor(message, { classification, failures }) {
    super(message);
    this.name = "IngressReadinessError";
    this.classification = classification;
    this.failures = failures;
  }
}

export async function waitForIngressUrls(options) {
  const urls = normalizeUrls(options.urls);
  const attempts = options.attempts ?? defaultAttempts;
  const delayMs = options.delayMs ?? defaultDelayMs;
  const topologyStreak = options.topologyStreak ?? defaultTopologyStreak;
  const warmupGraceMs = options.warmupGraceMs ?? defaultWarmupGraceMs;
  const fetchImpl = options.fetchImpl;
  const expectedStatus = options.expectedStatus;
  const sleepImpl = options.sleepImpl ?? sleep;
  const nowImpl = options.nowImpl ?? Date.now;
  const startedAt = nowImpl();
  const notFoundStreaks = new Map();
  let lastResults = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResults = await Promise.all(
      urls.map(async (url) => {
        try {
          return await probeIngressUrl(url, { fetchImpl, expectedStatus });
        } catch (error) {
          return {
            url,
            status: null,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    if (lastResults.every((result) => result.ok)) {
      return { attempts: attempt, results: lastResults };
    }

    // Track consecutive-404 streaks per URL. Any non-404 outcome (ready,
    // other status, or a thrown error) resets the streak, so only a stable,
    // corroborated 404 accumulates toward a topology verdict.
    for (const result of lastResults) {
      if (classifyProbeResult(result) === "topology") {
        notFoundStreaks.set(result.url, (notFoundStreaks.get(result.url) ?? 0) + 1);
      } else {
        notFoundStreaks.set(result.url, 0);
      }
    }

    const elapsedMs = nowImpl() - startedAt;
    if (elapsedMs >= warmupGraceMs) {
      const topologyFailures = lastResults.filter((result) => (notFoundStreaks.get(result.url) ?? 0) >= topologyStreak);
      if (topologyFailures.length > 0) {
        throw buildTopologyError(topologyFailures, notFoundStreaks, attempt);
      }
    }

    if (attempt < attempts) {
      await sleepImpl(delayMs);
    }
  }

  const failures = lastResults
    .filter((result) => !result.ok)
    .map((result) => `${result.url} -> ${result.status ?? result.error ?? "unknown"}`)
    .join(", ");
  throw new IngressReadinessError(`Ingress URL readiness timed out after ${attempts} attempt(s): ${failures}.`, {
    classification: "transient-timeout",
    failures,
  });
}

function buildTopologyError(topologyFailures, notFoundStreaks, attempt) {
  const failures = topologyFailures.map((result) => ({
    url: result.url,
    status: result.status,
    consecutive404: notFoundStreaks.get(result.url) ?? 0,
  }));
  const detail = failures
    .map((failure) => `${failure.url} -> HTTP 404 x${failure.consecutive404} consecutive`)
    .join(", ");
  const message =
    `Ingress topology failure detected after ${attempt} attempt(s): ${detail}. ` +
    "A ready ingress returned a stable 404, so no host/route rule matches these URL(s) " +
    "(mis-routed or missing ingress object, wrong host mapping, or absent backend service) " +
    "— this is a deterministic routing defect, not a warming backend. " +
    "Failing fast and holding the promotion; inspect the ingress host rules and service " +
    "backends for the URL(s) above rather than waiting out the readiness budget.";
  return new IngressReadinessError(message, { classification: "topology", failures });
}

function normalizeUrls(urls) {
  const normalized = [...new Set((urls ?? []).map((url) => String(url).trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new Error("At least one --url is required.");
  }

  for (const url of normalized) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error(`Ingress readiness URL must use https: ${url}`);
    }
  }

  return normalized;
}

function parsePositiveInteger(value, flagName) {
  if (!/^\d+$/.test(String(value)) || Number(value) <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return Number(value);
}

function parseHttpStatus(value, flagName) {
  if (!/^\d{3}$/.test(String(value)) || Number(value) < 100 || Number(value) > 599) {
    throw new Error(`${flagName} must be an HTTP status from 100 through 599.`);
  }
  return Number(value);
}

function parseNonNegativeInteger(value, flagName) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${flagName} must be a non-negative integer.`);
  }
  return Number(value);
}

function parseArgs(argv) {
  const options = {
    urls: [],
    attempts: defaultAttempts,
    delayMs: defaultDelayMs,
    topologyStreak: defaultTopologyStreak,
    warmupGraceMs: defaultWarmupGraceMs,
    expectedStatus: undefined,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") {
      options.urls.push(readNextArg(argv, ++index, arg));
    } else if (arg === "--attempts") {
      options.attempts = parsePositiveInteger(readNextArg(argv, ++index, arg), arg);
    } else if (arg === "--delay-ms") {
      options.delayMs = parsePositiveInteger(readNextArg(argv, ++index, arg), arg);
    } else if (arg === "--topology-streak") {
      options.topologyStreak = parsePositiveInteger(readNextArg(argv, ++index, arg), arg);
    } else if (arg === "--warmup-grace-ms") {
      options.warmupGraceMs = parseNonNegativeInteger(readNextArg(argv, ++index, arg), arg);
    } else if (arg === "--expect-status") {
      options.expectedStatus = parseHttpStatus(readNextArg(argv, ++index, arg), arg);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(
        "Usage: node ./scripts/platform-ingress-wait.mjs --url <https-url> [--url <https-url>...] " +
          "[--attempts <count>] [--delay-ms <ms>] [--topology-streak <count>] [--warmup-grace-ms <ms>] " +
          "[--expect-status <status>] [--dry-run]",
      );
    }
  }

  options.urls = normalizeUrls(options.urls);
  return options;
}

function readNextArg(argv, index, name) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          urlCount: options.urls.length,
          urls: options.urls,
          attempts: options.attempts,
          delayMs: options.delayMs,
          topologyStreak: options.topologyStreak,
          warmupGraceMs: options.warmupGraceMs,
          expectedStatus: options.expectedStatus ?? null,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const result = await waitForIngressUrls(options);
  console.log(`Ingress URLs ready after ${result.attempts} attempt(s): ${options.urls.join(", ")}`);
  return 0;
}

if (process.argv[1]?.endsWith("platform-ingress-wait.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
