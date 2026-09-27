import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { BROWSER_BOOTSTRAP, createBrowserBootstrapTransport } from "./test-window-policy.mjs";

const COMPONENTS = Object.freeze({
  "connect-setup": "account-onboarding",
  "connect-manage": "account-management",
  "connect-notification": "notification-banner",
});

/**
 * The browser has no external network namespace. All permitted bytes arrive via
 * the automation pipe after the parent applies the one-resource policy. Routing
 * alone does not confine WebRTC, background clients or Chromium's network service.
 */
export async function openConfinedBrowser() {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() === 0)
    throw new Error("browser-mediation-unavailable");
  const { chromium } = await import("@playwright/test");
  const root = await realpath(tmpdir());
  const profile = await mkdtemp(join(root, "provider-window-browser-"));
  const removeProfile = async () => {
    const actual = await realpath(profile);
    const child = relative(root, actual);
    if (
      actual !== profile ||
      child.startsWith("..") ||
      isAbsolute(child) ||
      !child.startsWith("provider-window-browser-")
    )
      throw new Error("browser-cleanup-unavailable");
    await rm(actual, { recursive: true });
  };
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: "/usr/bin/unshare",
      ignoreDefaultArgs: true,
      args: [
        "--user",
        "--map-current-user",
        "--net",
        "--",
        chromium.executablePath(),
        "--headless",
        "--remote-debugging-pipe",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-quic",
        "--disable-extensions",
        "--disable-default-apps",
      ],
      chromiumSandbox: true,
    });
  } catch {
    await removeProfile();
    throw new Error("browser-mediation-unavailable");
  }
  let closing;
  return {
    newContext: (options) => browser.newContext(options),
    close: () => {
      closing ??= (async () => {
        try {
          await browser.close();
        } finally {
          await removeProfile();
        }
      })();
      return closing;
    },
  };
}

export async function observeConnectComponent({
  browser,
  mapper,
  publishableKey,
  clientSecret,
  expiresAt,
  deadlineAt,
  budget,
  send,
  signal,
}) {
  const component = COMPONENTS[mapper];
  const result = {
    component,
    attempted: false,
    outcome: "unknown",
    usability: "unknown",
    callbackInvocations: 0,
    loaderStarted: false,
    created: false,
    mounted: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMilliseconds: 0,
  };
  const start = performance.now();
  let context;
  let blocked = false;
  let failed = false;
  const deadline = Math.min(Date.parse(deadlineAt), Date.parse(expiresAt));
  if (!component || !Number.isFinite(deadline) || deadline <= Date.now()) return result;
  const session = new AbortController();
  const transport = createBrowserBootstrapTransport({
    budget,
    send,
    signal: signal ? AbortSignal.any([signal, session.signal]) : session.signal,
  });
  try {
    const sdkRoot = new URL("../../bounded-contexts/settlement/node_modules/@stripe/connect-js/", import.meta.url);
    const sdkPackage = JSON.parse(await readFile(new URL("package.json", sdkRoot), "utf8"));
    if (sdkPackage.version !== "3.4.5") throw new Error("browser-mediation-unavailable");
    const sdk = await readFile(new URL("dist/pure.js", sdkRoot), "utf8");
    context = await browser.newContext({
      serviceWorkers: "block",
      offline: true,
      acceptDownloads: false,
      permissions: [],
    });
    const close = () => {
      session.abort();
      void context.close().catch(() => {});
    };
    signal?.addEventListener("abort", close, { once: true });
    try {
      await context.routeWebSocket(/.*/, (socket) => {
        try {
          budget.take("browser");
          budget.deny({ method: "GET", url: socket.url() });
          blocked = true;
        } catch {
          close();
        } finally {
          socket.close();
        }
      });
      await context.route(/.*/, async (route) => {
        const request = route.request();
        if (request.isNavigationRequest()) {
          try {
            budget.take("browser");
            budget.deny({ method: request.method(), url: request.url() });
            blocked = true;
            await route.abort("blockedbyclient");
          } catch {
            close();
          }
          return;
        }
        try {
          const response = await transport(async () => {
            const form = { url: request.url(), method: request.method(), headers: {}, body: null };
            if (form.url !== BROWSER_BOOTSTRAP || form.method !== "GET") return form;
            // Reserve before asynchronous metadata retrieval. Forbidden bodies
            // are never requested from the child; negotiation headers are dropped.
            const headers = await request.allHeaders();
            form.headers = Object.fromEntries(
              Object.entries(headers).filter(([name]) =>
                ["authorization", "cookie", "referer", "referrer"].includes(name),
              ),
            );
            form.body = request.postData();
            return form;
          });
          if (response.outcome === "loaded") {
            await route.fulfill({ status: 200, contentType: "application/javascript", body: response.bytes });
          } else {
            blocked ||= response.outcome === "policy-blocked";
            failed ||= response.outcome === "error";
            await route.abort("blockedbyclient");
          }
        } catch {
          close();
        }
      });
      context.on("page", (page) => {
        page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
        page.on("download", (download) => void download.cancel().catch(() => {}));
      });
      const page = await context.newPage();
      await page.setContent('<!doctype html><meta name="referrer" content="no-referrer"><main id="component"></main>');
      await page.addScriptTag({
        content: `{ const exports = {}; ${sdk}\nwindow.__captureInitialize = exports.loadConnectAndInitialize; }`,
      });
      const remaining = Math.max(1, deadline - Date.now());
      page.setDefaultTimeout(remaining);
      result.attempted = true;
      const timer = setTimeout(close, remaining);
      try {
        // This is the Connect loader's real initialize/create/mount integration,
        // not the application's loader-start visibility flag as a readiness test.
        await page.evaluate(
          async ({ component, publishableKey, clientSecret }) => {
            const state = {
              callbackInvocations: 0,
              loaderStarted: false,
              created: false,
              mounted: false,
              error: false,
            };
            window.__captureState = state;
            const connect = window.__captureInitialize({
              publishableKey,
              fetchClientSecret: async () => {
                state.callbackInvocations++;
                if (state.callbackInvocations !== 1) throw new Error("session-consumed");
                return clientSecret;
              },
            });
            const element = connect.create(component);
            state.created = true;
            element.setOnLoaderStart(() => {
              state.loaderStarted = true;
            });
            element.setOnLoadError(() => {
              state.error = true;
            });
            document.getElementById("component").appendChild(element);
            state.mounted = true;
          },
          { component, publishableKey, clientSecret },
        );
        do {
          const state = await page.evaluate(() => {
            const state = window.__captureState;
            return {
              callbackInvocations: Number.isSafeInteger(state.callbackInvocations)
                ? Math.max(0, Math.min(2, state.callbackInvocations))
                : 0,
              loaderStarted: state.loaderStarted === true,
              created: state.created === true,
              mounted: state.mounted === true,
              error: state.error === true,
            };
          });
          result.callbackInvocations = state.callbackInvocations;
          result.loaderStarted = state.loaderStarted;
          result.created = state.created;
          result.mounted = state.mounted;
          failed ||= state.error;
          await page.waitForTimeout(Math.max(0, Math.min(20, deadline - Date.now() - 10)));
        } while (Date.now() + 10 < deadline);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      signal?.removeEventListener("abort", close);
    }
  } catch {
    failed = true;
  } finally {
    session.abort();
    await context?.close().catch(() => {});
    result.finishedAt = new Date().toISOString();
    result.elapsedMilliseconds = Math.max(0, Math.floor(performance.now() - start));
    result.outcome = Date.now() >= deadline ? "deadline" : failed ? "error" : blocked ? "policy-blocked" : "unknown";
  }
  // SDK 3.4.5 has no sufficient common provider-ready predicate for these three
  // integrations. No actual provider-rendered readiness is inferred from creation,
  // mounting, loader callbacks, an empty denial list, or private page content.
  return result;
}
