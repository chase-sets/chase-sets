import process from "node:process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE,
  POLICY_VALUES_DEGRADED_STATE,
} from "../bounded-contexts/public-presence/features/help/domain/policy-value-state.ts";
import { derivePublicWebRouteInventory } from "./public-web-route-inventory.mjs";

export const PUBLIC_WEB_ROUTE_SMOKE_MODES = Object.freeze(["no-5xx", "healthy"]);

// Anonymous production lifecycle probe on 2026-07-29 after landing and admin
// readiness passed. The largest response was `/` at 98,181 identity-encoded
// bytes. Twenty-five percent explicit growth headroom keeps the limit tied to
// measured production shape instead of a round-number guess.
export const PRODUCTION_SHAPED_LARGEST_RESPONSE_BYTES = 98_181;
export const RESPONSE_SIZE_HEADROOM_NUMERATOR = 5;
export const RESPONSE_SIZE_HEADROOM_DENOMINATOR = 4;
export const MAX_PUBLIC_WEB_RESPONSE_BYTES = Math.ceil(
  (PRODUCTION_SHAPED_LARGEST_RESPONSE_BYTES * RESPONSE_SIZE_HEADROOM_NUMERATOR) / RESPONSE_SIZE_HEADROOM_DENOMINATOR,
);

export const STRICT_PUBLIC_ROUTE_MEMBER_IDS = Object.freeze([
  "sales-fees",
  "faq",
  "order-protection",
  "refunds-and-returns",
  "help-article:buying:order-protection",
]);

export const PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS = Object.freeze({
  aborted: "aborted",
  deadlineExceeded: "deadline-exceeded",
  gateDeadlineExceeded: "gate-deadline-exceeded",
  requestFailed: "request-failed",
  responseTooLarge: "response-too-large",
  serverError: "status-5xx",
  strictContentType: "strict-content-type",
  strictDegradedState: "strict-degraded-state",
  strictStatus: "strict-status",
});

const DEFAULT_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_GATE_TIMEOUT_MS = 120_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function routeIdentity(route) {
  return `${route.memberId} (${route.path})`;
}

class PublicRouteSmokeFailure extends Error {
  constructor(reason, route, detail, options = {}) {
    super(`[${reason}] ${routeIdentity(route)} ${detail}`, options);
    this.name = "PublicRouteSmokeFailure";
    this.reason = reason;
    this.route = route;
  }
}

function routeFailure(reason, route, detail, options) {
  return new PublicRouteSmokeFailure(reason, route, detail, options);
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  assert(["http:", "https:"].includes(parsed.protocol), "Public route smoke base URL must use HTTP or HTTPS.");
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function isHtmlContentType(value) {
  return typeof value === "string" && /^text\/html(?:\s*;|$)/i.test(value.trim());
}

function hasDegradedStateAttribute(body) {
  const doubleQuoted = `${POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE}="${POLICY_VALUES_DEGRADED_STATE}"`;
  const singleQuoted = `${POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE}='${POLICY_VALUES_DEGRADED_STATE}'`;
  return body.includes(doubleQuoted) || body.includes(singleQuoted);
}

function prepareInventory(inventory) {
  const strictIds = new Set(STRICT_PUBLIC_ROUTE_MEMBER_IDS);
  const strictMatches = new Map();
  const fetchable = [];
  const indeterminate = [];

  for (const member of inventory.members) {
    if (member.kind === "INDETERMINATE") {
      indeterminate.push(member);
      continue;
    }
    assert(
      member.kind === "CONCRETE" || member.kind === "EXPANDED",
      `Public route inventory member '${member.memberId}' has unknown kind '${member.kind}'.`,
    );
    const strict = strictIds.has(member.memberId);
    if (strict) strictMatches.set(member.memberId, member);
    fetchable.push({ ...member, strict });
  }

  const missingStrictIds = STRICT_PUBLIC_ROUTE_MEMBER_IDS.filter((memberId) => !strictMatches.has(memberId));
  assert(
    missingStrictIds.length === 0,
    `Public route inventory is missing strict target(s): ${missingStrictIds.join(", ")}.`,
  );
  return {
    fetchable,
    indeterminate,
    strictRoutes: STRICT_PUBLIC_ROUTE_MEMBER_IDS.map((memberId) => strictMatches.get(memberId)),
  };
}

async function readBoundedBody(response, { maxBytes, retainBody, abort }) {
  if (!response.body) return { bytes: 0, text: "" };

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        const error = new Error(`response exceeded the ${maxBytes}-byte bound`);
        abort(error);
        try {
          await reader.cancel(error);
        } catch {
          // Aborting the request is the cleanup authority; cancellation can
          // reject because the abort already closed the stream.
        }
        throw error;
      }
      if (retainBody) chunks.push(result.value);
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The request abort closes the transport even if the reader is already
        // errored or locked by the underlying fetch implementation.
      }
    }
    reader.releaseLock();
  }

  if (!retainBody) return { bytes, text: "" };
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, text: new TextDecoder().decode(body) };
}

async function fetchRoute({ fetchImpl, input, route, mode, maxResponseBytes, timeoutMs, signal }) {
  const controller = new AbortController();
  let deadlineExpired = false;
  let responseTooLarge = false;
  const abortFromCaller = () => controller.abort(signal.reason ?? new Error("public route smoke aborted"));
  if (signal?.aborted) {
    throw routeFailure(PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.aborted, route, "was aborted before the request.");
  }
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  const timeout = setTimeout(() => {
    deadlineExpired = true;
    controller.abort(new Error(`request deadline expired after ${timeoutMs}ms`));
  }, timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(input, {
      redirect: "follow",
      headers: {
        Accept: "text/html",
        "Accept-Encoding": "identity",
      },
      signal: controller.signal,
    });
    const isStrict = mode === "healthy" && route.strict;
    let consumed;
    try {
      consumed = await readBoundedBody(response, {
        maxBytes: maxResponseBytes,
        retainBody: isStrict,
        abort(error) {
          responseTooLarge = true;
          controller.abort(error);
        },
      });
    } catch (error) {
      if (responseTooLarge) {
        throw routeFailure(
          PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.responseTooLarge,
          route,
          `exceeded ${maxResponseBytes} bytes.`,
          { cause: error },
        );
      }
      throw error;
    }

    if (response.status >= 500) {
      throw routeFailure(
        PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.serverError,
        route,
        `returned ${response.status} ${response.statusText || "Server Error"}.`,
      );
    }
    if (isStrict && response.status !== 200) {
      throw routeFailure(
        PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.strictStatus,
        route,
        `must finish at status 200 after redirects, got ${response.status} ${response.statusText}.`,
      );
    }
    const contentType = response.headers.get("content-type");
    if (isStrict && !isHtmlContentType(contentType)) {
      throw routeFailure(
        PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.strictContentType,
        route,
        `must finish as HTML after redirects, got '${contentType ?? "missing Content-Type"}'.`,
      );
    }
    if (isStrict && hasDegradedStateAttribute(consumed.text)) {
      throw routeFailure(
        PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.strictDegradedState,
        route,
        `carried ${POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE}="${POLICY_VALUES_DEGRADED_STATE}".`,
      );
    }
    return { bytes: consumed.bytes, response };
  } catch (error) {
    if (error instanceof PublicRouteSmokeFailure) throw error;
    if (deadlineExpired) {
      throw routeFailure(
        PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.deadlineExceeded,
        route,
        `did not complete headers and body within ${timeoutMs}ms.`,
        { cause: error },
      );
    }
    if (signal?.aborted) {
      throw routeFailure(PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.aborted, route, "was aborted by its caller.", {
        cause: error,
      });
    }
    throw routeFailure(
      PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.requestFailed,
      route,
      `could not be fetched: ${describeError(error)}.`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function delayWithinGate(milliseconds, { gateDeadline, signal, route }) {
  if (signal?.aborted) {
    throw routeFailure(PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.aborted, route, "was aborted before retry.");
  }
  const remaining = gateDeadline - performance.now();
  if (remaining <= 0 || milliseconds > remaining) {
    throw routeFailure(
      PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.gateDeadlineExceeded,
      route,
      "exhausted the total gate deadline before retry.",
    );
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(routeFailure(PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.aborted, route, "was aborted during retry delay."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function probeRoute({
  baseUrl,
  route,
  mode,
  fetchImpl,
  attempts,
  retryDelayMs,
  requestTimeoutMs,
  maxResponseBytes,
  gateDeadline,
  signal,
  logger,
}) {
  const input = new URL(route.path, baseUrl).toString();
  let lastFailure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = gateDeadline - performance.now();
    if (remaining <= 0) {
      throw routeFailure(
        PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.gateDeadlineExceeded,
        route,
        "exhausted the total gate deadline before its request.",
      );
    }
    try {
      const result = await fetchRoute({
        fetchImpl,
        input,
        route,
        mode,
        maxResponseBytes,
        timeoutMs: Math.max(1, Math.min(requestTimeoutMs, Math.floor(remaining))),
        signal,
      });
      logger.log(
        `[public-route-smoke] ${route.memberId} ${route.path} -> ${result.response.status} (${result.bytes} bytes)${
          mode === "healthy" && route.strict ? " healthy" : ""
        }`,
      );
      return result;
    } catch (error) {
      lastFailure = error;
      if (
        error instanceof PublicRouteSmokeFailure &&
        [
          PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.aborted,
          PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.gateDeadlineExceeded,
        ].includes(error.reason)
      ) {
        throw error;
      }
    }

    if (attempt < attempts) {
      logger.warn(
        `[public-route-smoke] ${describeError(lastFailure)} Retrying (${attempt + 1}/${attempts}) within the gate deadline.`,
      );
      await delayWithinGate(retryDelayMs, { gateDeadline, signal, route });
    }
  }
  throw lastFailure;
}

export async function smokePublicWebRoutes(options) {
  assert(
    PUBLIC_WEB_ROUTE_SMOKE_MODES.includes(options.mode),
    `Public route smoke mode must be one of: ${PUBLIC_WEB_ROUTE_SMOKE_MODES.join(", ")}.`,
  );
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const requestTimeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const gateTimeoutMs = options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_PUBLIC_WEB_RESPONSE_BYTES;
  for (const [name, value] of Object.entries({
    attempts,
    retryDelayMs,
    requestTimeoutMs,
    gateTimeoutMs,
    maxResponseBytes,
  })) {
    assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer.`);
  }
  const logger = options.logger ?? console;
  const startedAt = performance.now();
  const gateDeadline = startedAt + gateTimeoutMs;
  const inventory = options.inventory ?? derivePublicWebRouteInventory({ rootDir: options.rootDir });
  const prepared = prepareInventory(inventory);

  logger.log(
    `[public-route-smoke] Derived ${inventory.members.length} members at ${inventory.derivedAgainst}: ` +
      `${prepared.fetchable.length} fetchable, ${prepared.indeterminate.length} indeterminate, ` +
      `${prepared.strictRoutes.length} strict healthy targets.`,
  );
  for (const member of prepared.indeterminate) {
    logger.log(`[public-route-smoke] INDETERMINATE ${member.memberId} ${member.path}: ${member.reason}`);
  }

  let attempted = 0;
  for (const route of prepared.fetchable) {
    try {
      await probeRoute({
        baseUrl,
        route,
        mode: options.mode,
        fetchImpl: options.fetchImpl ?? fetch,
        attempts,
        retryDelayMs,
        requestTimeoutMs,
        maxResponseBytes,
        gateDeadline,
        signal: options.signal,
        logger,
      });
      attempted += 1;
    } catch (error) {
      attempted += 1;
      throw new Error(`Public route smoke failed (${options.mode}):\n- ${describeError(error)}`, { cause: error });
    }
  }

  logger.log(
    `[public-route-smoke] Passed ${attempted} fetchable members in ${options.mode} mode within ${Math.ceil(
      performance.now() - startedAt,
    )}ms.`,
  );
  return { inventory, ...prepared, attempted };
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number.parseInt(value, 10);
  assert(
    Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value,
    `${optionName} must be a positive integer.`,
  );
  return parsed;
}

export function parsePublicWebRouteSmokeCliArgs(args) {
  const parsedArgs = args[0] === "--" ? args.slice(1) : args;
  const values = new Map();
  for (let index = 0; index < parsedArgs.length; index += 1) {
    const option = parsedArgs[index];
    assert(option.startsWith("--"), `Unexpected public route smoke argument '${option}'.`);
    const value = parsedArgs[index + 1];
    assert(value && !value.startsWith("--"), `${option} requires a value.`);
    assert(!values.has(option), `${option} may be provided only once.`);
    values.set(option, value);
    index += 1;
  }
  const supported = new Set([
    "--base-url",
    "--mode",
    "--attempts",
    "--retry-delay-ms",
    "--timeout-ms",
    "--gate-timeout-ms",
  ]);
  for (const option of values.keys()) assert(supported.has(option), `Unknown public route smoke option '${option}'.`);
  assert(values.has("--base-url"), "--base-url is required.");
  assert(values.has("--mode"), "--mode is required.");
  return {
    baseUrl: values.get("--base-url"),
    mode: values.get("--mode"),
    attempts: values.has("--attempts")
      ? parsePositiveInteger(values.get("--attempts"), "--attempts")
      : DEFAULT_ATTEMPTS,
    retryDelayMs: values.has("--retry-delay-ms")
      ? parsePositiveInteger(values.get("--retry-delay-ms"), "--retry-delay-ms")
      : DEFAULT_RETRY_DELAY_MS,
    timeoutMs: values.has("--timeout-ms")
      ? parsePositiveInteger(values.get("--timeout-ms"), "--timeout-ms")
      : DEFAULT_REQUEST_TIMEOUT_MS,
    gateTimeoutMs: values.has("--gate-timeout-ms")
      ? parsePositiveInteger(values.get("--gate-timeout-ms"), "--gate-timeout-ms")
      : DEFAULT_GATE_TIMEOUT_MS,
  };
}

async function main() {
  const controller = new AbortController();
  const abort = (signalName) => {
    if (!controller.signal.aborted) controller.abort(new Error(`received ${signalName}`));
  };
  const onSigint = () => abort("SIGINT");
  const onSigterm = () => abort("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    await smokePublicWebRoutes({
      ...parsePublicWebRouteSmokeCliArgs(process.argv.slice(2)),
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(describeError(error));
    process.exitCode = 1;
  });
}
