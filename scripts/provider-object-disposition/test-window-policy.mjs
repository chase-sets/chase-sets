export const BROWSER_BOOTSTRAP = "https://connect-js.stripe.com/v1.0/connect.js";
const methods = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];
const origins = new Map([
  ["https://connect-js.stripe.com", "connect-js"],
  ["https://js.stripe.com", "js"],
  ["https://api.stripe.com", "api"],
  ["https://merchant-ui-api.stripe.com", "merchant-ui-api"],
]);

export function browserRequestAllowed(request) {
  if (
    request === null ||
    typeof request !== "object" ||
    Object.keys(request).sort().join(",") !== "body,headers,method,url" ||
    request.url !== BROWSER_BOOTSTRAP ||
    request.method !== "GET" ||
    request.body !== null
  )
    return false;
  try {
    const url = new URL(request.url);
    if (url.href !== BROWSER_BOOTSTRAP || url.username || url.password || url.search || url.hash) return false;
    const headers = request.headers;
    return (
      headers !== null &&
      Object.getPrototypeOf(headers) === Object.prototype &&
      Object.entries(headers).every(([key, value]) => key.toLowerCase() === "accept" && value === "*/*") &&
      Object.keys(headers).length <= 1
    );
  } catch {
    return false;
  }
}

export function denialBucket(request) {
  let origin = "other";
  let path = "other";
  try {
    const url = new URL(request?.url);
    origin = origins.get(url.origin) ?? "other";
    if (origin === "connect-js" && url.pathname === "/v1.0/connect.js") path = "bootstrap";
  } catch {
    // Missing and unparseable inputs have no reflected diagnostic.
  }
  return { method: methods.includes(request?.method) ? request.method : "other", origin, path };
}

export function createBrowserBudget({ expiresAt, stop, signal }) {
  const deadline = Date.parse(expiresAt);
  if (
    typeof expiresAt !== "string" ||
    !Number.isFinite(deadline) ||
    new Date(deadline).toISOString() !== expiresAt ||
    deadline <= Date.now() ||
    deadline - Date.now() > 2_147_483_647 ||
    typeof stop !== "function"
  )
    throw new Error("browser-budget-invalid");
  const controller = new AbortController();
  const denials = new Map();
  let attempts = 0;
  let deniedAttempts = 0;
  let closing;
  const close = () => {
    if (!controller.signal.aborted) {
      controller.abort();
      clearTimeout(timer);
      signal?.removeEventListener("abort", close);
      closing = Promise.resolve().then(stop);
      // The owner must await close; asynchronous expiry must not leak a rejection.
      void closing.catch(() => {});
    }
    return closing;
  };
  const timer = setTimeout(close, deadline - Date.now());
  timer.unref?.();
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) close();
  const assert = () => {
    if (controller.signal.aborted || Date.now() >= deadline) {
      close();
      throw new Error("browser-bound");
    }
  };
  return {
    signal: controller.signal,
    assert,
    take() {
      assert();
      if (attempts === 128) {
        close();
        throw new Error("browser-bound");
      }
      // Reservation is synchronous, before policy, metadata reads or sending.
      attempts++;
    },
    deny(request) {
      if (deniedAttempts >= attempts) {
        close();
        throw new Error("browser-bound");
      }
      deniedAttempts++;
      const bucket = denialBucket(request);
      const key = JSON.stringify(bucket);
      const previous = denials.get(key);
      denials.set(key, { ...bucket, count: (previous?.count ?? 0) + 1 });
    },
    snapshot: () => ({ attempts, denials: [...denials.values()].map((entry) => ({ ...entry })) }),
    close,
  };
}

async function beforeAbort(promise, signal) {
  if (signal.aborted) throw new Error("browser-bound");
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(new Error("browser-bound"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function createBrowserBootstrapTransport({ budget, send }) {
  if (typeof send !== "function") throw new Error("browser-transport-unavailable");
  return async (request) => {
    budget.take();
    if (!browserRequestAllowed(request)) {
      budget.deny(request);
      return { outcome: "policy-blocked" };
    }
    let reader;
    try {
      budget.assert();
      // Neither URL nor headers come from the child. There is no default sender.
      const response = await beforeAbort(
        send(BROWSER_BOOTSTRAP, {
          method: "GET",
          headers: { Accept: "*/*" },
          redirect: "manual",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: budget.signal,
        }),
        budget.signal,
      );
      budget.assert();
      if (response.status !== 200 || response.redirected || response.headers.has("set-cookie")) {
        void response.body?.cancel().catch(() => {});
        return { outcome: "error" };
      }
      reader = response.body?.getReader();
      if (!reader) return { outcome: "error" };
      const chunks = [];
      let length = 0;
      for (;;) {
        const { done, value } = await beforeAbort(reader.read(), budget.signal);
        budget.assert();
        if (done) break;
        length += value.byteLength;
        if (length > 4 * 1024 * 1024) return { outcome: "error" };
        chunks.push(Buffer.from(value));
      }
      return { outcome: "loaded", bytes: Buffer.concat(chunks) };
    } catch {
      return { outcome: "error" };
    } finally {
      if (reader) void reader.cancel().catch(() => {});
    }
  };
}
