import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const BROWSER_BOOTSTRAP = "https://connect-js.stripe.com/v1.0/connect.js";
export const WINDOW_SCHEDULE = Object.freeze([
  Object.freeze({ flow: "P", mappers: Object.freeze(["customer", "setup-embedded", "payment-saved"]) }),
  Object.freeze({ flow: "S", mappers: Object.freeze(["connect-setup"]) }),
  Object.freeze({ flow: "M", mappers: Object.freeze(["connect-manage"]) }),
  Object.freeze({ flow: "N", mappers: Object.freeze(["connect-notification"]) }),
]);
export const HTTP_LIMITS = Object.freeze({ scenario: 128, browser: 128, disposition: 64 });
export const POLICY_DIGEST = createHash("sha256")
  .update(
    ["test-window-policy.mjs", "test-window-server.mjs", "test-window-browser.mjs"]
      .map((name) => readFileSync(new URL(name, import.meta.url), "utf8"))
      .join("\n"),
  )
  .digest("hex");

export function configurationDigest(configuration) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        configuration.deploymentEnvironment,
        configuration.providerMode,
        configuration.accountsApi,
        configuration.apiVersion,
        configuration.configVersion,
        configuration.policyVersion,
        configuration.policyDigest,
        configuration.sdkVersion,
      ]),
    )
    .digest("hex");
}

export function closedObject(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function browserRequestAllowed(request) {
  if (
    !closedObject(request, ["url", "method", "headers", "body"]) ||
    request.url !== BROWSER_BOOTSTRAP ||
    request.method !== "GET" ||
    request.body !== null
  )
    return false;
  try {
    const url = new URL(request.url);
    if (url.href !== BROWSER_BOOTSTRAP || url.username || url.password || url.search || url.hash) return false;
    const headers = new Headers(request.headers);
    // Only the fixed public-resource negotiation headers are accepted. Nothing
    // supplied by SDK code can become a credential-bearing outgoing header.
    return [...headers].every(([key, value]) => key === "accept" && value === "*/*");
  } catch {
    return false;
  }
}

const METHODS = Object.freeze(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const ORIGINS = Object.freeze({
  "https://connect-js.stripe.com": "connect-js",
  "https://js.stripe.com": "js",
  "https://api.stripe.com": "api",
  "https://merchant-ui-api.stripe.com": "merchant-ui-api",
});

export function denialBucket(request) {
  let origin = "other";
  let path = "other";
  try {
    const url = new URL(request.url);
    origin = ORIGINS[url.origin] ?? "other";
    if (origin === "connect-js" && url.pathname === "/v1.0/connect.js") path = "bootstrap";
  } catch {
    // Unparseable input has no reflected diagnostic.
  }
  return { method: METHODS.includes(request.method) ? request.method : "other", origin, path };
}

export function createAttemptBudget({ expiresAt, cleanupSeconds, limits = HTTP_LIMITS, now = Date.now, abort }) {
  const deadline = Date.parse(expiresAt);
  if (
    !Number.isFinite(deadline) ||
    !Number.isSafeInteger(cleanupSeconds) ||
    cleanupSeconds < 1 ||
    !closedObject(limits, Object.keys(HTTP_LIMITS)) ||
    Object.entries(limits).some(([key, count]) => !Number.isSafeInteger(count) || count < 1 || count > HTTP_LIMITS[key])
  )
    throw new Error("invalid-budget");
  const counts = { scenario: 0, browser: 0, disposition: 0 };
  const denied = new Map();
  let stopped = false;
  const assert = (kind) => {
    if (!Object.hasOwn(counts, kind)) throw new Error("invalid-budget");
    const expires = kind === "disposition" ? deadline : deadline - cleanupSeconds * 1000;
    if (now() >= expires || (stopped && kind !== "disposition")) {
      stopped = true;
      abort?.();
      throw new Error("capture-bound");
    }
  };
  return {
    assert,
    take(kind) {
      assert(kind);
      if (counts[kind] >= limits[kind]) {
        stopped = true;
        abort?.();
        throw new Error("capture-bound");
      }
      // No await between the bound and increment: concurrent callbacks reserve
      // attempts before either the policy decision or a transport send.
      counts[kind]++;
    },
    deny(request) {
      const bucket = denialBucket(request);
      const key = JSON.stringify(bucket);
      const previous = denied.get(key);
      if ((previous?.count ?? 0) >= limits.browser) throw new Error("capture-bound");
      denied.set(key, { ...bucket, count: (previous?.count ?? 0) + 1 });
    },
    snapshot() {
      return { ...counts, total: counts.scenario + counts.browser + counts.disposition, denials: [...denied.values()] };
    },
  };
}

export function createBrowserBootstrapTransport({ budget, send, signal }) {
  return async (candidate) => {
    budget.take("browser");
    const request = typeof candidate === "function" ? await candidate() : candidate;
    if (!browserRequestAllowed(request)) {
      budget.deny(request);
      return { outcome: "policy-blocked" };
    }
    try {
      const response = await send(BROWSER_BOOTSTRAP, {
        method: "GET",
        headers: { Accept: "*/*" },
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal,
      });
      if (response.status !== 200 || response.headers.has("set-cookie")) return { outcome: "error" };
      const reader = response.body?.getReader();
      if (!reader) return { outcome: "error" };
      const chunks = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 4 * 1024 * 1024) return { outcome: "error" };
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return { outcome: "loaded", bytes: Buffer.concat(chunks) };
    } catch {
      return { outcome: "error" };
    }
  };
}
