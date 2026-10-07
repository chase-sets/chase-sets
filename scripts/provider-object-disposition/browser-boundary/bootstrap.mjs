import { BROWSER_BOOTSTRAP, createBrowserBudget, createBrowserBootstrapTransport } from "../test-window-policy.mjs";

export async function openBootstrapPage({ browser, expiresAt, send, signal }) {
  const budget = createBrowserBudget({ expiresAt, signal, stop: () => browser.close() });
  try {
    budget.assert();
    const context = await browser.newContext();
    if (typeof context.routeWebSocket !== "function") throw new Error("browser-transport-unavailable");
    const unsupported = ["WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection", "SharedWorker"];
    await context.exposeBinding("__providerBoundaryDenied", (_source, name) => {
      try {
        budget.take();
        budget.deny({ method: "other", url: undefined });
        if (!unsupported.includes(name)) void budget.close();
      } catch {
        void budget.close();
      }
    });
    await context.addInitScript((names) => {
      const deny = globalThis.__providerBoundaryDenied;
      for (const name of names) {
        Object.defineProperty(globalThis, name, {
          configurable: false,
          writable: false,
          value: function () {
            void deny(name).catch(() => {});
            throw new Error("browser-policy-blocked");
          },
        });
      }
    }, unsupported);
    await context.routeWebSocket(/.*/, (socket) => {
      try {
        budget.take();
        budget.deny({ method: "GET", url: socket.url() });
      } catch {
        void budget.close();
      } finally {
        socket.close();
      }
    });
    await context.route(/.*/, async (route) => {
      try {
        budget.take();
        const request = route.request();
        budget.deny({ method: request.method(), url: request.url() });
        await route.abort("blockedbyclient");
      } catch {
        void budget.close();
      }
    });
    context.on("page", (page) => {
      page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
      page.on("download", (download) => void download.cancel().catch(() => {}));
    });
    const page = await context.newPage();
    await page.setContent(
      "<!doctype html><meta name=\"referrer\" content=\"no-referrer\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'\"><main id=\"component\"></main>",
    );
    const transport = createBrowserBootstrapTransport({ budget, send });
    const response = await transport({ url: BROWSER_BOOTSTRAP, method: "GET", headers: {}, body: null });
    if (response.outcome !== "loaded") throw new Error("browser-bootstrap-unavailable");
    budget.assert();
    await page.addScriptTag({ content: response.bytes.toString("utf8") });
    budget.assert();
    return { page, context, close: budget.close, snapshot: budget.snapshot };
  } catch {
    await budget.close();
    throw new Error("browser-bootstrap-unavailable");
  }
}
