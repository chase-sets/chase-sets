// Anonymous observations of the staging product host: the payment-provider mode and
// both readiness surfaces. Each observer sends one GET, with no Authorization header
// and no cookie, to one named path on the one named host, and resolves to a closed
// result or to exactly `{stop, httpStatus, degradedCheckNames}`. A stop carries no
// partial observation, so a refusal never grants; response bodies, check messages and
// exception text never enter a result.

export const STAGING_PRODUCT_ORIGIN = "https://marketplace.staging.chasesets.com";
export const PRODUCT_RESPONSE_BYTE_LIMIT = 1_048_576;

const PROVIDER_MODE_PATH = "/api/marketplace/payment-provider-mode";
const WEB_READINESS_PATH = "/health/ready";
// `/api/health` reports projection replay, not readiness, and is never read.
const BACKEND_READINESS_PATH = "/api/health/ready";

// The shipped shapes: bounded-contexts/payments/features/payments/api/contracts.ts,
// infrastructure/platform-runtime/web-assets.ts and infrastructure/platform-runtime/health.ts.
const PROVIDER_MODE_KEYS = ["mode", "paymentProcessorKind", "moneyMovementKind", "deploymentEnvironment", "observedAt"];
const PROVIDER_MODES = ["test", "live", "unconfigured"];
const GATEWAY_KINDS = ["stripe", "fake"];
const WEB_READINESS_KEYS = ["ok", "service", "checkedAt", "origin"];
const CHECK_STATUSES = ["ok", "degraded"];
const MAXIMUM_CHECKS = 200;

// The two headers the platform treats as a credential (infrastructure/platform-runtime/http.ts).
const CREDENTIAL_HEADERS = ["authorization", "cookie"];

const offsetInstant = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i;

const stop = (name, httpStatus = null, degradedCheckNames = []) =>
  Object.freeze({ stop: name, httpStatus, degradedCheckNames: Object.freeze(degradedCheckNames) });

const isHttpStatus = (value) => Number.isInteger(value) && value >= 100 && value <= 599;
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactly = (value, keys) =>
  isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function isOffsetInstant(value) {
  const match = typeof value === "string" ? offsetInstant.exec(value) : null;
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return (
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function isSerializedOrigin(value) {
  try {
    return typeof value === "string" && new URL(value).origin === value;
  } catch {
    return false;
  }
}

// JSON.parse keeps the last of two equal keys, so a body could hide `"mode":"live"`
// behind a later `"mode":"test"`. The text has already parsed, so this scan can trust
// the grammar and only tracks which keys each open object has seen.
function hasDuplicateKey(text) {
  const open = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") open.push({ keys: new Set(), expectingKey: true });
    else if (character === "[") open.push(null);
    else if (character === "}" || character === "]") open.pop();
    else if (character === "," && open.at(-1)) open.at(-1).expectingKey = true;
    else if (character === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const object = open.at(-1);
      if (object?.expectingKey) {
        const key = JSON.parse(text.slice(index, end + 1));
        if (object.keys.has(key)) return true;
        object.keys.add(key);
        object.expectingKey = false;
      }
      index = end;
    }
  }
  return false;
}

// The parsed body, or undefined when the bytes are not UTF-8 JSON free of duplicate keys.
function parseBody(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    return hasDuplicateKey(text) ? undefined : value;
  } catch {
    return undefined;
  }
}

// The complete body, or null once it passes the byte limit; the rest is discarded unread.
async function readBounded(response, deadline) {
  if (Number(response.headers.get("content-length") ?? 0) > PRODUCT_RESPONSE_BYTE_LIMIT) {
    response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.byteLength;
      if (bytes > PRODUCT_RESPONSE_BYTE_LIMIT) return null;
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function productUrl(path) {
  const url = typeof path === "string" && path.startsWith("/") ? new URL(path, STAGING_PRODUCT_ORIGIN) : null;
  if (!url || url.origin !== STAGING_PRODUCT_ORIGIN || url.pathname !== path || url.search || url.hash) {
    throw new TypeError("product-request-invalid");
  }
  return url.href;
}

/**
 * One request to the named staging product host. Redirects are returned, never
 * followed; nothing is retried; one deadline covers the headers and the complete body;
 * and a body over 1,048,576 bytes is `response-too-large`. Resolves to
 * `{httpStatus, body}` (body bytes) or `{failure, httpStatus}`, where `failure` is
 * `response-too-large`, `request-timeout` or `request-failed` and `httpStatus` is null
 * until headers arrive. Only an invalid argument rejects, before anything is sent.
 */
export async function requestProductHost({
  method = "GET",
  path,
  headers = {},
  body,
  timeoutMs,
  transport = globalThis.fetch,
}) {
  const url = productUrl(path);
  if (
    !["GET", "POST"].includes(method) ||
    (method === "GET" && body !== undefined) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 60_000 ||
    typeof transport !== "function"
  ) {
    throw new TypeError("product-request-invalid");
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer;
  // Settles only by rejecting, so a transport that ignores the abort signal stays bounded.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("deadline"));
    }, timeoutMs);
  });
  deadline.catch(() => {});
  let httpStatus = null;
  try {
    const response = await Promise.race([
      transport(url, { method, headers, body, redirect: "manual", credentials: "omit", signal: controller.signal }),
      deadline,
    ]);
    if (!isHttpStatus(response.status)) return { failure: "request-failed", httpStatus: null };
    httpStatus = response.status;
    const bytes = await readBounded(response, deadline);
    return bytes === null ? { failure: "response-too-large", httpStatus } : { httpStatus, body: bytes };
  } catch {
    return { failure: timedOut ? "request-timeout" : "request-failed", httpStatus };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// One anonymous GET: a stop, or the status with the parsed body. A transport failure or
// timeout is the observing step's own stop.
async function anonymousGet(path, { headers = {}, timeoutMs, transport } = {}, failureStop) {
  const requestHeaders = new Headers(headers);
  if (CREDENTIAL_HEADERS.some((name) => requestHeaders.has(name))) return stop("request-credential-not-permitted");
  requestHeaders.set("accept", "application/json");
  const response = await requestProductHost({
    path,
    headers: Object.fromEntries(requestHeaders),
    timeoutMs,
    transport,
  });
  if (response.failure === "response-too-large") return stop("response-too-large", response.httpStatus);
  if (response.failure) return stop(failureStop, response.httpStatus);
  return { httpStatus: response.httpStatus, json: parseBody(response.body) };
}

const isProviderModeBody = (body) =>
  hasExactly(body, PROVIDER_MODE_KEYS) &&
  PROVIDER_MODES.includes(body.mode) &&
  GATEWAY_KINDS.includes(body.paymentProcessorKind) &&
  GATEWAY_KINDS.includes(body.moneyMovementKind) &&
  body.deploymentEnvironment === "staging" &&
  isOffsetInstant(body.observedAt);

const isWebReadinessBody = (body) =>
  hasExactly(body, WEB_READINESS_KEYS) &&
  typeof body.ok === "boolean" &&
  typeof body.service === "string" &&
  isOffsetInstant(body.checkedAt) &&
  isSerializedOrigin(body.origin);

// An ok check is exactly {name, status}; only a degraded check may add the message
// this observer never reads.
const isReadinessCheck = (check) =>
  (hasExactly(check, ["name", "status"]) ||
    (hasExactly(check, ["name", "status", "message"]) &&
      check.status === "degraded" &&
      typeof check.message === "string")) &&
  typeof check.name === "string" &&
  check.name.length > 0 &&
  CHECK_STATUSES.includes(check.status);

const isBackendReadinessBody = (body) =>
  hasExactly(body, ["status", "checks"]) &&
  CHECK_STATUSES.includes(body.status) &&
  Array.isArray(body.checks) &&
  body.checks.length >= 1 &&
  body.checks.length <= MAXIMUM_CHECKS &&
  body.checks.every(isReadinessCheck);

const degradedCheckNames = (checks) =>
  [...new Set(checks.filter((check) => check.status !== "ok").map((check) => check.name))].sort();

/**
 * GET /api/marketplace/payment-provider-mode. Grants only `test` with at least one
 * `stripe` kind, keeping both kinds, so a Connect-only deployment (`fake` processor,
 * `stripe` money movement) grants. `unconfigured` is never permission.
 */
export async function observeProviderMode(options) {
  const response = await anonymousGet(PROVIDER_MODE_PATH, options, "test-mode-indicator-unobservable");
  if (response.stop) return response;
  if (response.httpStatus === 404) return stop("mode-route-absent", 404);
  if (response.httpStatus !== 200) return stop("test-mode-indicator-unobservable", response.httpStatus);
  const body = response.json;
  if (!isProviderModeBody(body)) return stop("readiness-schema-unexpected", 200);
  if (body.mode === "live") return stop("live-mode-detected", 200);
  if (body.mode === "unconfigured") return stop("test-mode-indicator-unobservable", 200);
  if (body.paymentProcessorKind === "fake" && body.moneyMovementKind === "fake") {
    return stop("provider-mode-inconsistent", 200);
  }
  return Object.freeze({
    url: `${STAGING_PRODUCT_ORIGIN}${PROVIDER_MODE_PATH}`,
    httpStatus: 200,
    mode: "test",
    paymentProcessorKind: body.paymentProcessorKind,
    moneyMovementKind: body.moneyMovementKind,
    deploymentEnvironment: "staging",
    observedAt: body.observedAt,
  });
}

/**
 * GET /health/ready, the web tier's `{ok, service, checkedAt, origin}`. Grants on 200
 * with `ok: true` from the `marketplace` service; `checkedAt` and `origin` are
 * validated, not kept. The backend's shape here, at any status, is
 * `readiness-schema-unexpected`.
 */
export async function observeWebReadiness(options) {
  const response = await anonymousGet(WEB_READINESS_PATH, options, "web-not-ready");
  if (response.stop) return response;
  const body = response.json;
  if (isBackendReadinessBody(body)) return stop("readiness-schema-unexpected", response.httpStatus);
  if (response.httpStatus !== 200) return stop("web-not-ready", response.httpStatus);
  if (!isWebReadinessBody(body)) return stop("readiness-schema-unexpected", 200);
  if (body.ok !== true || body.service !== "marketplace") return stop("web-not-ready", 200);
  return Object.freeze({
    url: `${STAGING_PRODUCT_ORIGIN}${WEB_READINESS_PATH}`,
    httpStatus: 200,
    ok: true,
    service: body.service,
  });
}

/**
 * GET /api/health/ready, the API tier's `{status, checks[]}`. Grants on 200 with an
 * `ok` aggregate and every check `ok`. Anything else is `host-not-ready`, naming the
 * degraded checks when the body binds this shape; the web's shape here, at any status,
 * is `readiness-schema-unexpected`.
 */
export async function observeBackendReadiness(options) {
  const response = await anonymousGet(BACKEND_READINESS_PATH, options, "host-not-ready");
  if (response.stop) return response;
  const body = response.json;
  if (isWebReadinessBody(body)) return stop("readiness-schema-unexpected", response.httpStatus);
  const bound = isBackendReadinessBody(body);
  if (response.httpStatus !== 200) {
    return stop("host-not-ready", response.httpStatus, bound ? degradedCheckNames(body.checks) : []);
  }
  if (!bound) return stop("readiness-schema-unexpected", 200);
  const degraded = degradedCheckNames(body.checks);
  if (body.status !== "ok" || degraded.length > 0) return stop("host-not-ready", 200, degraded);
  return Object.freeze({
    url: `${STAGING_PRODUCT_ORIGIN}${BACKEND_READINESS_PATH}`,
    httpStatus: 200,
    aggregateStatus: "ok",
    checkCount: body.checks.length,
    degradedCheckNames: Object.freeze([]),
  });
}
