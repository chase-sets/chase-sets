import { afterEach, expect, it, vi } from "vitest";
import { openBootstrapPage } from "./bootstrap.mjs";
import { nativeControls } from "./native-controls.mjs";
import { nativeDiagnosticControls } from "./native-diagnostics.mjs";

const pages = [];
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
  vi.useRealTimers();
});

async function open() {
  const callbacks = {};
  const page = { setContent: vi.fn(), addScriptTag: vi.fn() };
  const context = {
    routeWebSocket: vi.fn(async (_pattern, callback) => {
      callbacks.socket = callback;
    }),
    route: vi.fn(async (_pattern, callback) => {
      callbacks.route = callback;
    }),
    exposeBinding: vi.fn(async (_name, callback) => {
      callbacks.denied = callback;
    }),
    addInitScript: vi.fn(),
    on: vi.fn(),
    newPage: vi.fn(async () => page),
  };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn() };
  const send = vi.fn(async () => new Response("SYNTHETIC_MEMORY_BOOTSTRAP"));
  const bootstrap = await openBootstrapPage({ browser, send, expiresAt: new Date(Date.now() + 1000).toISOString() });
  pages.push(bootstrap);
  return { bootstrap, browser, context, callbacks, page, send };
}

it("parent bootstrap is in memory and every child route, including the loader URL, is denied", async () => {
  const { bootstrap, callbacks, page, send } = await open();
  expect(page.addScriptTag).toHaveBeenCalledWith({ content: "SYNTHETIC_MEMORY_BOOTSTRAP" });
  const abort = vi.fn();
  const proceed = vi.fn();
  await callbacks.route({
    request: () => ({ method: () => "GET", url: () => "https://connect-js.stripe.com/v1.0/connect.js" }),
    abort,
    continue: proceed,
  });
  expect(abort).toHaveBeenCalledWith("blockedbyclient");
  expect(proceed).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  expect(bootstrap.snapshot()).toEqual({
    attempts: 2,
    denials: [{ method: "GET", origin: "connect-js", path: "bootstrap", count: 1 }],
  });
});

it("unsupported transports and beacon refusals consume the same atomic attempt budget", async () => {
  const { bootstrap, callbacks, send } = await open();
  for (const name of ["WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection", "SharedWorker", "beacon"]) {
    await callbacks.denied({}, name, "https://api.stripe.com/SYNTHETIC_PRIVATE");
  }
  expect(bootstrap.snapshot().attempts).toBe(6);
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(bootstrap.snapshot())).not.toContain("SYNTHETIC_PRIVATE");
});

it("deadline closes the owned browser even with no further child requests", async () => {
  vi.useFakeTimers();
  const { browser, bootstrap } = await open();
  await vi.advanceTimersByTimeAsync(1000);
  expect(browser.close).toHaveBeenCalledTimes(1);
  expect(bootstrap.snapshot().attempts).toBe(1);
  await bootstrap.close();
  expect(browser.close).toHaveBeenCalledTimes(1);
});

it("unsupported routing refuses and drains before calling any sender", async () => {
  const browser = { newContext: vi.fn(async () => ({})), close: vi.fn() };
  const send = vi.fn();
  await expect(
    openBootstrapPage({ browser, send, expiresAt: new Date(Date.now() + 1000).toISOString() }),
  ).rejects.toThrow("browser-bootstrap-unavailable");
  expect(send).not.toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalledTimes(1);
});

it("native control modules are inert on import; execution is owned by hosted controls", () => {
  expect(typeof nativeControls).toBe("function");
  expect(typeof nativeDiagnosticControls).toBe("function");
});
