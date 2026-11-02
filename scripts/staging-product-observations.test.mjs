import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAYMENT_PROVIDER_GATEWAY_KINDS,
  PAYMENT_PROVIDER_MODE_RESPONSE_MEMBERS,
  PAYMENT_PROVIDER_MODES,
  parsePaymentProviderModeResponse,
} from "../bounded-contexts/payments/features/payments/api/contracts.ts";
import { createHealthRoutes } from "../infrastructure/platform-runtime/health.ts";
import { createWebReadyLoader } from "../infrastructure/platform-runtime/web-assets.ts";
import {
  PRODUCT_RESPONSE_BYTE_LIMIT,
  STAGING_PRODUCT_ORIGIN,
  observeBackendReadiness,
  observeProviderMode,
  observeWebReadiness,
  requestProductHost,
} from "./staging-product-observations.mjs";

// Both readiness bodies exactly as captured anonymously from staging on 2026-08-12.
const captured = JSON.parse(
  readFileSync(new URL("./fixtures/staging-product-observations/captured-readiness.json", import.meta.url), "utf8"),
);
const modeUrl = `${STAGING_PRODUCT_ORIGIN}/api/marketplace/payment-provider-mode`;
const webUrl = `${STAGING_PRODUCT_ORIGIN}/health/ready`;
const backendUrl = `${STAGING_PRODUCT_ORIGIN}/api/health/ready`;
const timeoutMs = 1000;

const reply = (body, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
// Answers every request with a fresh response and records each call.
const answering = (respond) => vi.fn(async () => respond());
const failing = () => {
  throw new TypeError("synthetic-transport-failure-marker");
};
const oversized = () => reply(" ".repeat(PRODUCT_RESPONSE_BYTE_LIMIT + 1));
const stopped = (stop, httpStatus = null, degradedCheckNames = []) => ({ stop, httpStatus, degradedCheckNames });
const omit = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

// Headers arrive at 100 ms and the body then trickles forever; with fake timers the
// one deadline must end both this and a transport that never answers.
const endlessBody = () =>
  new Promise((resolve) =>
    setTimeout(() => {
      let cancelled = false;
      resolve(
        new Response(
          new ReadableStream({
            pull: (controller) =>
              new Promise((pulled) =>
                setTimeout(() => {
                  if (!cancelled) controller.enqueue(new TextEncoder().encode(" "));
                  pulled();
                }, 20),
              ),
            cancel: () => {
              cancelled = true;
            },
          }),
        ),
      );
    }, 100),
  );

afterEach(() => {
  vi.useRealTimers();
});

// Synthetic: the mode route has never been live-captured. These bodies follow the shipped
// closed contract, and each case states whether that contract's own parser serves it.
const modeBody = (overrides = {}) => ({
  mode: "test",
  paymentProcessorKind: "fake",
  moneyMovementKind: "stripe",
  deploymentEnvironment: "staging",
  observedAt: "2026-10-20T01:02:03.456Z",
  ...overrides,
});
const modeGrant = (body) => ({
  url: modeUrl,
  httpStatus: 200,
  mode: "test",
  paymentProcessorKind: body.paymentProcessorKind,
  moneyMovementKind: body.moneyMovementKind,
  deploymentEnvironment: "staging",
  observedAt: body.observedAt,
});

describe("grants only an observed test mode", () => {
  it("binds the shipped closed mode contract", () => {
    expect([...PAYMENT_PROVIDER_MODE_RESPONSE_MEMBERS].sort()).toEqual([
      "deploymentEnvironment",
      "mode",
      "moneyMovementKind",
      "observedAt",
      "paymentProcessorKind",
    ]);
    expect([...PAYMENT_PROVIDER_MODES].sort()).toEqual(["live", "test", "unconfigured"]);
    expect([...PAYMENT_PROVIDER_GATEWAY_KINDS].sort()).toEqual(["fake", "stripe"]);
  });

  it("grants a Connect-only test mode from one anonymous GET and keeps both kinds", async () => {
    const body = modeBody();
    expect(parsePaymentProviderModeResponse(body)).not.toBeNull();
    const transport = answering(() => reply(body));
    expect(await observeProviderMode({ timeoutMs, transport })).toStrictEqual(modeGrant(body));
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe(modeUrl);
    expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    expect(init.headers).toStrictEqual({ accept: "application/json" });
  });

  it("grants a test mode with both kinds stripe", async () => {
    const body = modeBody({ paymentProcessorKind: "stripe" });
    expect(parsePaymentProviderModeResponse(body)).not.toBeNull();
    expect(await observeProviderMode({ timeoutMs, transport: answering(() => reply(body)) })).toStrictEqual(
      modeGrant(body),
    );
  });

  it.each([
    [
      "both kinds fake under test, a triple the route's own invariant forbids",
      modeBody({ moneyMovementKind: "fake" }),
      false,
      "provider-mode-inconsistent",
    ],
    ["live", modeBody({ mode: "live", paymentProcessorKind: "stripe" }), true, "live-mode-detected"],
    [
      "unconfigured",
      modeBody({ mode: "unconfigured", moneyMovementKind: "fake" }),
      true,
      "test-mode-indicator-unobservable",
    ],
  ])("stops on %s", async (_case, body, served, stop) => {
    expect(parsePaymentProviderModeResponse(body) !== null).toBe(served);
    expect(await observeProviderMode({ timeoutMs, transport: answering(() => reply(body)) })).toStrictEqual(
      stopped(stop, 200),
    );
  });

  it.each([
    [
      "404, a runtime that predates the route",
      () => reply({ error: { code: "not_found" } }, 404),
      "mode-route-absent",
      404,
    ],
    ["500", () => reply({ error: { code: "synthetic" } }, 500), "test-mode-indicator-unobservable", 500],
    [
      "a redirect, which is not followed",
      () => new Response(null, { status: 302, headers: { location: `${STAGING_PRODUCT_ORIGIN}/sign-in` } }),
      "test-mode-indicator-unobservable",
      302,
    ],
    ["a transport failure", failing, "test-mode-indicator-unobservable", null],
    ["a body over the byte limit", oversized, "response-too-large", 200],
  ])("stops on %s without a retry", async (_case, respond, stop, httpStatus) => {
    const transport = answering(respond);
    const result = await observeProviderMode({ timeoutMs, transport });
    expect(result).toStrictEqual(stopped(stop, httpStatus));
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["hung headers", () => new Promise(() => {}), null],
    ["an endless body", endlessBody, 200],
  ])("stops on a timeout during %s", async (_case, respond, httpStatus) => {
    vi.useFakeTimers();
    const transport = vi.fn(respond);
    const observation = observeProviderMode({ timeoutMs, transport });
    await vi.advanceTimersByTimeAsync(timeoutMs + 100);
    expect(await Promise.race([observation, Promise.resolve("pending")])).toStrictEqual(
      stopped("test-mode-indicator-unobservable", httpStatus),
    );
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it.each([
    ["the withdrawn processorKind beside both kinds", JSON.stringify({ ...modeBody(), processorKind: "stripe" })],
    [
      "the withdrawn processorKind in place of both kinds",
      JSON.stringify(
        omit(omit({ ...modeBody(), processorKind: "stripe" }, "paymentProcessorKind"), "moneyMovementKind"),
      ),
    ],
    ...PAYMENT_PROVIDER_MODE_RESPONSE_MEMBERS.map((member) => [
      `no ${member}`,
      JSON.stringify(omit(modeBody(), member)),
    ]),
    ["a mode outside the enumeration", JSON.stringify(modeBody({ mode: "sandbox" }))],
    ["a kind outside the enumeration", JSON.stringify(modeBody({ moneyMovementKind: "paypal" }))],
    ["a deployment environment other than staging", JSON.stringify(modeBody({ deploymentEnvironment: "production" }))],
    ["an offset-less observedAt", JSON.stringify(modeBody({ observedAt: "2026-10-20T01:02:03.456" }))],
    ["a date-only observedAt", JSON.stringify(modeBody({ observedAt: "2026-10-20" }))],
    ["an impossible observedAt", JSON.stringify(modeBody({ observedAt: "2026-02-30T01:02:03Z" }))],
    ["a nested mode", JSON.stringify(modeBody({ mode: { value: "test" } }))],
    ["an array", JSON.stringify([modeBody()])],
    ["a duplicate key hiding live", `{"mode":"live",${JSON.stringify(modeBody()).slice(1)}`],
    [
      "a duplicate key spelled with an escape",
      `{"mode":"live","mod\\u0065":"test",${JSON.stringify(omit(modeBody(), "mode")).slice(1)}`,
    ],
    ["text that is not JSON", "<html>sign in</html>"],
  ])("refuses %s as an unexpected schema", async (_case, text) => {
    expect(await observeProviderMode({ timeoutMs, transport: answering(() => reply(text)) })).toStrictEqual(
      stopped("readiness-schema-unexpected", 200),
    );
  });

  it.each([
    ["an Authorization header", { Authorization: "Bearer synthetic-session-token" }],
    ["a cookie", { Cookie: "session=synthetic-session" }],
  ])("refuses a request carrying %s before sending it", async (_case, headers) => {
    const transport = answering(() => reply(modeBody()));
    expect(await observeProviderMode({ timeoutMs, headers, transport })).toStrictEqual(
      stopped("request-credential-not-permitted"),
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("still observes with a header that is not a credential", async () => {
    const transport = answering(() => reply(modeBody()));
    expect(
      await observeProviderMode({ timeoutMs, headers: { "User-Agent": "synthetic-probe" }, transport }),
    ).toStrictEqual(modeGrant(modeBody()));
    expect(transport.mock.calls[0][1].headers).toStrictEqual({
      accept: "application/json",
      "user-agent": "synthetic-probe",
    });
  });
});

describe("binds both readiness schemas", () => {
  const webGrant = { url: webUrl, httpStatus: 200, ok: true, service: "marketplace" };
  const backendGrant = (checkCount) => ({
    url: backendUrl,
    httpStatus: 200,
    aggregateStatus: "ok",
    checkCount,
    degradedCheckNames: [],
  });
  const webBody = (overrides = {}) => ({ ...JSON.parse(captured.web.body), ...overrides });
  const okCheck = (name) => ({ name, status: "ok" });
  const okChecks = (count) => Array.from({ length: count }, (_, index) => okCheck(`synthetic.check-${index}`));

  it("grants the captured web shape and the shipped web readiness loader", async () => {
    expect(
      await observeWebReadiness({ timeoutMs, transport: answering(() => reply(captured.web.body)) }),
    ).toStrictEqual(webGrant);
    const loader = createWebReadyLoader("marketplace");
    const transport = vi.fn(async (url) => loader({ request: new Request(url) }));
    expect(await observeWebReadiness({ timeoutMs, transport })).toStrictEqual(webGrant);
    expect(transport.mock.calls[0][0]).toBe(webUrl);
    expect(transport.mock.calls[0][1].headers).toStrictEqual({ accept: "application/json" });
  });

  it("grants the captured backend shape and the shipped health routes", async () => {
    expect(
      await observeBackendReadiness({ timeoutMs, transport: answering(() => reply(captured.backend.body)) }),
    ).toStrictEqual(backendGrant(1));
    const routes = createHealthRoutes({ readinessChecks: [{ name: "control.database", check: async () => {} }] });
    const transport = vi.fn(async () => routes.request("/ready"));
    expect(await observeBackendReadiness({ timeoutMs, transport })).toStrictEqual(backendGrant(1));
    expect(transport.mock.calls[0][0]).toBe(backendUrl);
    expect(transport.mock.calls[0][1].headers).toStrictEqual({ accept: "application/json" });
  });

  it("grants exactly 200 checks", async () => {
    const transport = answering(() => reply({ status: "ok", checks: okChecks(200) }));
    expect(await observeBackendReadiness({ timeoutMs, transport })).toStrictEqual(backendGrant(200));
  });

  it.each([
    ["ok false", () => reply(webBody({ ok: false })), "web-not-ready", 200],
    ["another service", () => reply(webBody({ service: "platform-api" })), "web-not-ready", 200],
    ["503", () => new Response("Service Unavailable", { status: 503 }), "web-not-ready", 503],
    ["a transport failure", failing, "web-not-ready", null],
    ["a body over the byte limit", oversized, "response-too-large", 200],
  ])("refuses web readiness on %s", async (_case, respond, stop, httpStatus) => {
    const transport = answering(respond);
    expect(await observeWebReadiness({ timeoutMs, transport })).toStrictEqual(stopped(stop, httpStatus));
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the backend shape", () => reply(captured.backend.body), 200],
    [
      "the backend shape at 503",
      () => reply({ status: "degraded", checks: [{ name: "a", status: "degraded" }] }, 503),
      503,
    ],
    ["an extra key", () => reply(webBody({ status: "ok" })), 200],
    ["a string ok", () => reply(webBody({ ok: "true" })), 200],
    ["an offset-less checkedAt", () => reply(webBody({ checkedAt: "2026-08-12T00:04:31.570" })), 200],
    ["an origin with a path", () => reply(webBody({ origin: "http://marketplace.staging.chasesets.com/" })), 200],
    ["text that is not JSON", () => reply("<html>ready</html>"), 200],
  ])("refuses web readiness given %s as an unexpected schema", async (_case, respond, httpStatus) => {
    expect(await observeWebReadiness({ timeoutMs, transport: answering(respond) })).toStrictEqual(
      stopped("readiness-schema-unexpected", httpStatus),
    );
  });

  it("keeps only the names of degraded checks from the shipped health routes", async () => {
    const marker = "synthetic-check-message-marker";
    const routes = createHealthRoutes({
      readinessChecks: [
        {
          name: "control.database",
          check: async () => {
            throw new Error(marker);
          },
        },
        { name: "control.cache", check: async () => {} },
      ],
      isDraining: () => true,
    });
    const transport = vi.fn(async () => routes.request("/ready"));
    const result = await observeBackendReadiness({ timeoutMs, transport });
    expect(result).toStrictEqual(stopped("host-not-ready", 503, ["control.database", "process.draining"]));
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain("draining for shutdown");
  });

  it.each([
    [
      "a degraded member under an ok aggregate",
      () =>
        reply({ status: "ok", checks: [okCheck("control.database"), { name: "control.cache", status: "degraded" }] }),
      200,
      ["control.cache"],
    ],
    [
      "a degraded aggregate whose check repeats a name",
      () =>
        reply({
          status: "degraded",
          checks: [
            { name: "control.database", status: "degraded", message: "synthetic-check-message-marker" },
            { name: "control.database", status: "degraded" },
          ],
        }),
      200,
      ["control.database"],
    ],
    ["503 without a readiness body", () => new Response("Service Unavailable", { status: 503 }), 503, []],
    ["a transport failure", failing, null, []],
  ])("refuses backend readiness on %s", async (_case, respond, httpStatus, names) => {
    const transport = answering(respond);
    const result = await observeBackendReadiness({ timeoutMs, transport });
    expect(result).toStrictEqual(stopped("host-not-ready", httpStatus, names));
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("refuses an oversized backend body", async () => {
    expect(await observeBackendReadiness({ timeoutMs, transport: answering(oversized) })).toStrictEqual(
      stopped("response-too-large", 200),
    );
  });

  it.each([
    ["the web shape", () => reply(captured.web.body), 200],
    ["the web shape at 503", () => reply(webBody({ ok: false }), 503), 503],
    [
      "a message on an ok check",
      () => reply({ status: "ok", checks: [{ ...okCheck("a"), message: "synthetic" }] }),
      200,
    ],
    ["an extra key on a check", () => reply({ status: "ok", checks: [{ ...okCheck("a"), latencyMs: 1 }] }), 200],
    ["an extra top-level key", () => reply({ status: "ok", checks: [okCheck("a")], projectionReplay: {} }), 200],
    ["no checks", () => reply({ status: "ok", checks: [] }), 200],
    ["201 checks", () => reply({ status: "ok", checks: okChecks(201) }), 200],
    ["an unknown check status", () => reply({ status: "ok", checks: [{ name: "a", status: "unknown" }] }), 200],
    ["an empty check name", () => reply({ status: "ok", checks: [okCheck("")] }), 200],
    ["checks that are not an array", () => reply({ status: "ok", checks: { a: "ok" } }), 200],
    ["an unknown aggregate status", () => reply({ status: "starting", checks: [okCheck("a")] }), 200],
    [
      "a duplicate key hiding a degraded aggregate",
      () => reply('{"status":"degraded","status":"ok","checks":[{"name":"a","status":"ok"}]}'),
      200,
    ],
    [
      "a duplicate key hiding a degraded check",
      () => reply('{"status":"ok","checks":[{"name":"a","status":"degraded","status":"ok"}]}'),
      200,
    ],
    ["text that is not JSON", () => reply("<html>ready</html>"), 200],
  ])("refuses backend readiness given %s as an unexpected schema", async (_case, respond, httpStatus) => {
    const result = await observeBackendReadiness({ timeoutMs, transport: answering(respond) });
    expect(result).toStrictEqual(stopped("readiness-schema-unexpected", httpStatus));
  });

  it.each([
    ["web", observeWebReadiness],
    ["backend", observeBackendReadiness],
  ])("refuses a credentialed %s readiness request before sending it", async (_surface, observe) => {
    const transport = answering(() => reply(captured.backend.body));
    for (const headers of [{ authorization: "Bearer synthetic-session-token" }, { cookie: "session=synthetic" }])
      expect(await observe({ timeoutMs, headers, transport })).toStrictEqual(
        stopped("request-credential-not-permitted"),
      );
    expect(transport).not.toHaveBeenCalled();
  });

  it("reads only the two named readiness paths, never /api/health", async () => {
    const transport = vi.fn(async (url) => reply(url === webUrl ? captured.web.body : captured.backend.body));
    expect(await observeWebReadiness({ timeoutMs, transport })).toStrictEqual(webGrant);
    expect(await observeBackendReadiness({ timeoutMs, transport })).toStrictEqual(backendGrant(1));
    expect(transport.mock.calls.map(([url]) => url)).toEqual([webUrl, backendUrl]);
  });
});

describe("requestProductHost", () => {
  it("sends one request with manual redirects and returns the status and bytes without a retry", async () => {
    const redirect = answering(
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
    );
    const redirected = await requestProductHost({ path: "/health/ready", timeoutMs, transport: redirect });
    expect(redirected.httpStatus).toBe(302);
    expect(redirected.body.byteLength).toBe(0);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });

    const unavailable = answering(() => new Response("Service Unavailable", { status: 503 }));
    const failed = await requestProductHost({ path: "/api/health/ready", timeoutMs, transport: unavailable });
    expect(failed.httpStatus).toBe(503);
    expect(Buffer.from(failed.body).toString("utf8")).toBe("Service Unavailable");
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it("passes a JSON POST body through for the command's sign-in", async () => {
    const transport = answering(() => reply({ sessionToken: "synthetic-session-token" }));
    const body = JSON.stringify({ email: "synthetic@example.invalid", password: "synthetic" });
    const result = await requestProductHost({
      method: "POST",
      path: "/api/auth/password-sign-in",
      headers: { "content-type": "application/json" },
      body,
      timeoutMs,
      transport,
    });
    expect(result.httpStatus).toBe(200);
    expect(transport).toHaveBeenCalledWith(
      `${STAGING_PRODUCT_ORIGIN}/api/auth/password-sign-in`,
      expect.objectContaining({ method: "POST", body, redirect: "manual" }),
    );
  });

  it("accepts a body at the byte limit and refuses one byte more, with or without Content-Length", async () => {
    const atLimit = await requestProductHost({
      path: "/health/ready",
      timeoutMs,
      transport: answering(() => new Response("x".repeat(PRODUCT_RESPONSE_BYTE_LIMIT))),
    });
    expect(atLimit.body.byteLength).toBe(PRODUCT_RESPONSE_BYTE_LIMIT);
    expect(
      await requestProductHost({
        path: "/health/ready",
        timeoutMs,
        transport: answering(() => new Response("x".repeat(PRODUCT_RESPONSE_BYTE_LIMIT + 1))),
      }),
    ).toStrictEqual({ failure: "response-too-large", httpStatus: 200 });
    const declared = answering(
      () => new Response("{}", { status: 503, headers: { "content-length": String(PRODUCT_RESPONSE_BYTE_LIMIT + 1) } }),
    );
    expect(await requestProductHost({ path: "/health/ready", timeoutMs, transport: declared })).toStrictEqual({
      failure: "response-too-large",
      httpStatus: 503,
    });
  });

  it("ends hung headers and an endless body within the same one deadline", async () => {
    vi.useFakeTimers();
    const hung = vi.fn(() => new Promise(() => {}));
    const slow = vi.fn(endlessBody);
    const headers = requestProductHost({ path: "/health/ready", timeoutMs, transport: hung });
    const body = requestProductHost({ path: "/health/ready", timeoutMs, transport: slow });
    await vi.advanceTimersByTimeAsync(timeoutMs + 100);
    expect(await Promise.race([headers, Promise.resolve("pending")])).toStrictEqual({
      failure: "request-timeout",
      httpStatus: null,
    });
    expect(await Promise.race([body, Promise.resolve("pending")])).toStrictEqual({
      failure: "request-timeout",
      httpStatus: 200,
    });
    expect(hung.mock.calls[0][1].signal.aborted).toBe(true);
    expect(slow.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("reports a transport failure without its message", async () => {
    const result = await requestProductHost({ path: "/health/ready", timeoutMs, transport: answering(failing) });
    expect(result).toStrictEqual({ failure: "request-failed", httpStatus: null });
  });

  it.each([
    ["another origin", { path: "https://elsewhere.example/health/ready" }],
    ["a protocol-relative path", { path: "//elsewhere.example/health/ready" }],
    ["a backslash path", { path: "/\\elsewhere.example/health/ready" }],
    ["a userinfo path", { path: "@elsewhere.example/health/ready" }],
    ["a query", { path: "/health/ready?full=1" }],
    ["a fragment", { path: "/health/ready#top" }],
    ["a dot segment", { path: "/api/../health/ready" }],
    ["another method", { path: "/health/ready", method: "PUT" }],
    ["a GET body", { path: "/health/ready", body: "{}" }],
    ["a timeout under one second", { path: "/health/ready", timeoutMs: 999 }],
    ["a timeout over one minute", { path: "/health/ready", timeoutMs: 60_001 }],
    ["a fractional timeout", { path: "/health/ready", timeoutMs: 1000.5 }],
    ["no transport", { path: "/health/ready", transport: "synthetic" }],
  ])("refuses %s before sending anything", async (_case, overrides) => {
    const transport = answering(() => reply({}));
    await expect(requestProductHost({ timeoutMs, transport, ...overrides })).rejects.toThrow(TypeError);
    expect(transport).not.toHaveBeenCalled();
  });
});
