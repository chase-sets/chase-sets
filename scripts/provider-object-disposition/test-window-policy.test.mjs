import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  BROWSER_BOOTSTRAP,
  browserRequestAllowed,
  createBrowserBudget,
  createBrowserBootstrapTransport,
  denialBucket,
} from "./test-window-policy.mjs";

const budgets = [];
function setup(send = vi.fn(async () => new Response("SYNTHETIC_BOOTSTRAP"))) {
  const stop = vi.fn();
  const budget = createBrowserBudget({ expiresAt: new Date(Date.now() + 5000).toISOString(), stop });
  budgets.push(budget);
  return { budget, stop, send, transport: createBrowserBootstrapTransport({ budget, send }) };
}
const allowed = () => ({ url: BROWSER_BOOTSTRAP, method: "GET", headers: {}, body: null });
afterEach(async () => {
  await Promise.all(budgets.splice(0).map((budget) => budget.close()));
  vi.useRealTimers();
});

it("sends only a fixed serialized and parsed GET with no child headers, body or redirect authority", async () => {
  const { transport, send, budget } = setup();
  expect(await transport(allowed())).toEqual({ outcome: "loaded", bytes: Buffer.from("SYNTHETIC_BOOTSTRAP") });
  expect(send).toHaveBeenCalledExactlyOnceWith(BROWSER_BOOTSTRAP, {
    method: "GET",
    headers: { Accept: "*/*" },
    redirect: "manual",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: budget.signal,
  });
  expect(budget.snapshot()).toEqual({ attempts: 1, denials: [] });
});

const urls = [
  `${BROWSER_BOOTSTRAP}?`,
  `${BROWSER_BOOTSTRAP}#`,
  `${BROWSER_BOOTSTRAP}?key=SYNTHETIC_PRIVATE`,
  `${BROWSER_BOOTSTRAP}#SYNTHETIC_PRIVATE`,
  `${BROWSER_BOOTSTRAP}/`,
  "https://connect-js.stripe.com:443/v1.0/connect.js",
  "https://connect-js.stripe.com:444/v1.0/connect.js",
  "https://CONNECT-JS.stripe.com/v1.0/connect.js",
  "https://connect-js.stripe.com/v1.0/./connect.js",
  "https://connect-js.stripe.com/v1.0/%63onnect.js",
  "https://connect-js.stripe.com./v1.0/connect.js",
  "https://user@connect-js.stripe.com/v1.0/connect.js",
  "https://user:pass@connect-js.stripe.com/v1.0/connect.js",
  "https://connect-js.stripe.com.invalid/v1.0/connect.js",
  "https://sub.connect-js.stripe.com/v1.0/connect.js",
  "http://connect-js.stripe.com/v1.0/connect.js",
  " https://connect-js.stripe.com/v1.0/connect.js",
  "https:\\connect-js.stripe.com/v1.0/connect.js",
  "https://connect-js.stripe.com/v1.0/../v1.0/connect.js",
  "https://js.stripe.com/v3",
  "https://api.stripe.com/v1/accounts",
  "https://api.stripe.com/v1/accounts/search",
  "https://merchant-ui-api.stripe.com/accounts",
  "file:///etc/passwd",
  "http://127.0.0.1/",
  "ws://example.invalid/",
  "wss://connect-js.stripe.com/",
  "data:text/plain,SYNTHETIC_PRIVATE",
  "not a URL",
  "",
];
it.each(urls)("denies a nonexact serialized URL without sending (%#)", async (url) => {
  const { transport, send, budget } = setup();
  expect(await transport({ ...allowed(), url })).toEqual({ outcome: "policy-blocked" });
  expect(send).not.toHaveBeenCalled();
  expect(budget.snapshot().attempts).toBe(1);
  expect(JSON.stringify(budget.snapshot())).not.toContain("SYNTHETIC_PRIVATE");
});

it.each(["HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE", "get", "GET\n"])(
  "denies methods before sending (%s)",
  async (method) => {
    const { transport, send } = setup();
    expect(await transport({ ...allowed(), method })).toEqual({ outcome: "policy-blocked" });
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(["Authorization", "Cookie", "Referer", "Referrer", "Upgrade", "Origin", "X-Api-Key", "Content-Type"])(
  "does not forward or discard a forbidden header to turn it into permission (%s)",
  async (header) => {
    const { transport, send } = setup();
    expect(await transport({ ...allowed(), headers: { [header]: "SYNTHETIC_PRIVATE" } })).toEqual({
      outcome: "policy-blocked",
    });
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(["", Buffer.alloc(0), "SYNTHETIC_PRIVATE", {}, undefined])("denies any non-null body (%#)", async (body) => {
  const { transport, send } = setup();
  expect(await transport({ ...allowed(), body })).toEqual({ outcome: "policy-blocked" });
  expect(send).not.toHaveBeenCalled();
});

it.each([null, undefined, {}, [], { ...allowed(), extra: true }])(
  "refuses malformed/extended request records (%#)",
  (form) => {
    expect(browserRequestAllowed(form)).toBe(false);
  },
);

it.each([301, 302, 303, 307, 308])("does not follow even a same-origin redirect (%s)", async (status) => {
  const { transport, send } = setup(
    vi.fn(async () => new Response(null, { status, headers: { Location: BROWSER_BOOTSTRAP } })),
  );
  expect(await transport(allowed())).toEqual({ outcome: "error" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("rejects response cookies, redirect-followed responses and overflow without returning bytes", async () => {
  for (const response of [
    new Response("SYNTHETIC_PRIVATE", { headers: { "Set-Cookie": "SYNTHETIC_PRIVATE" } }),
    { status: 200, redirected: true, headers: new Headers() },
    new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
  ]) {
    const { transport } = setup(async () => response);
    expect(await transport(allowed())).toEqual({ outcome: "error" });
  }
});

it("reserves permitted and denied attempts atomically and destroys the child at the cap", async () => {
  const { transport, budget, stop, send } = setup();
  const results = await Promise.allSettled(
    Array.from({ length: 256 }, (_, index) => transport(index % 2 ? { ...allowed(), method: "POST" } : allowed())),
  );
  expect(budget.snapshot().attempts).toBe(128);
  expect(budget.snapshot().denials).toEqual([{ method: "POST", origin: "connect-js", path: "bootstrap", count: 64 }]);
  expect(send).toHaveBeenCalledTimes(64);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(128);
  await budget.close();
  expect(stop).toHaveBeenCalledTimes(1);
});

it("expiry aborts a stalled sender, returns no bytes and preserves counts", async () => {
  vi.useFakeTimers();
  const { transport, budget, stop } = setup(() => new Promise(() => {}));
  const pending = transport(allowed());
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toEqual({ outcome: "error" });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(budget.snapshot()).toEqual({ attempts: 1, denials: [] });
  await expect(transport(allowed())).rejects.toThrow("browser-bound");
});

it("expiry aborts a stalled response reader as well as a pending send", async () => {
  vi.useFakeTimers();
  const { transport, stop } = setup(async () => new Response(new ReadableStream({ start() {} })));
  const pending = transport(allowed());
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toEqual({ outcome: "error" });
  expect(stop).toHaveBeenCalledTimes(1);
});

it("denial schema has at most 80 closed buckets and never retains private input", () => {
  const buckets = new Set();
  for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "SYNTHETIC_PRIVATE"]) {
    for (const host of ["connect-js", "js", "api", "merchant-ui-api", "SYNTHETIC_PRIVATE"]) {
      for (const path of ["/v1.0/connect.js", "/SYNTHETIC_PRIVATE"]) {
        const bucket = denialBucket({ method, url: `https://${host}.stripe.com${path}?SYNTHETIC_PRIVATE` });
        expect(JSON.stringify(bucket)).not.toContain("SYNTHETIC_PRIVATE");
        buckets.add(JSON.stringify(bucket));
      }
    }
  }
  expect(buckets.size).toBeLessThanOrEqual(80);
});

it("the forbidden-send assertion detects a governing-only URL policy mutant with a synthetic sender", async () => {
  const source = await readFile(new URL("test-window-policy.mjs", import.meta.url), "utf8");
  const predicate = "if (!browserRequestAllowed(request))";
  expect(source.split(predicate)).toHaveLength(2);
  const mutant = await import(
    `data:text/javascript;base64,${Buffer.from(source.replace(predicate, "if (false)")).toString("base64")}`
  );
  const { budget, send } = setup();
  const transport = mutant.createBrowserBootstrapTransport({ budget, send });
  await transport({ ...allowed(), url: "https://api.stripe.com/v1/accounts" });
  expect(send).toHaveBeenCalledTimes(1);
  expect(() => expect(send).not.toHaveBeenCalled()).toThrow();
});
