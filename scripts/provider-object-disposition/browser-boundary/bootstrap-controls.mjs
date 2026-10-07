import assert from "node:assert/strict";
import { openConfinedBrowser } from "../test-window-browser.mjs";
import { BROWSER_BOOTSTRAP, createBrowserBudget, createBrowserBootstrapTransport } from "../test-window-policy.mjs";
import { openBootstrapPage } from "./bootstrap.mjs";

const form = { url: BROWSER_BOOTSTRAP, method: "GET", headers: {}, body: null };
const pass = (id) => console.log(`installed-boundary control B2-${id}: PASS`);

export async function bootstrapControls(stage = () => {}) {
  let sends = 0;
  const budget = createBrowserBudget({ expiresAt: new Date(Date.now() + 5000).toISOString(), stop: () => {} });
  const transport = createBrowserBootstrapTransport({
    budget,
    send: async (url, options) => {
      sends++;
      assert.equal(url, BROWSER_BOOTSTRAP);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "manual");
      assert.deepEqual(options.headers, { Accept: "*/*" });
      return new Response("SYNTHETIC");
    },
  });
  try {
    assert.equal((await transport(form)).outcome, "loaded");
    assert.equal(sends, 1);
    pass("bootstrap-send1");
    const forbidden = [
      ...["?", "#", "?private=SYNTHETIC_PRIVATE", "/"].map((suffix) => ({ ...form, url: BROWSER_BOOTSTRAP + suffix })),
      ...[
        "https://connect-js.stripe.com:443/v1.0/connect.js",
        "https://connect-js.stripe.com/v1.0/%63onnect.js",
        "https://user@connect-js.stripe.com/v1.0/connect.js",
        "https://api.stripe.com/v1/accounts",
        "https://api.stripe.com/v1/accounts/search",
        "https://merchant-ui-api.stripe.com/accounts",
        "https://js.stripe.com/v3",
        "http://127.0.0.1/",
        "file:///etc/passwd",
        "wss://example.invalid/",
      ].map((url) => ({ ...form, url })),
      ...["HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT"].map((method) => ({ ...form, method })),
      ...["Authorization", "Cookie", "Referer", "Referrer", "Upgrade", "X-Api-Key"].map((name) => ({
        ...form,
        headers: { [name]: "SYNTHETIC_PRIVATE" },
      })),
      { ...form, body: "" },
      { ...form, body: "SYNTHETIC_PRIVATE" },
    ];
    for (const request of forbidden) assert.equal((await transport(request)).outcome, "policy-blocked");
    assert.equal(sends, 1);
    assert.equal(budget.snapshot().attempts, 1 + forbidden.length);
    assert.ok(!JSON.stringify(budget.snapshot()).includes("SYNTHETIC_PRIVATE"));
    pass("forbidden-forms-headers-api-send0");
    for (const status of [301, 302, 303, 307, 308]) {
      let redirectSends = 0;
      const redirect = createBrowserBootstrapTransport({
        budget,
        send: async () => {
          redirectSends++;
          return new Response(null, { status, headers: { Location: BROWSER_BOOTSTRAP } });
        },
      });
      assert.equal((await redirect(form)).outcome, "error");
      assert.equal(redirectSends, 1);
    }
    pass("redirect-target-send0");
  } finally {
    await budget.close();
  }

  stage("open-browser");
  const browser = await openConfinedBrowser();
  let bootstrap;
  sends = 0;
  try {
    stage("open-bootstrap-page");
    bootstrap = await openBootstrapPage({
      browser,
      expiresAt: new Date(Date.now() + 15000).toISOString(),
      send: async () => {
        sends++;
        return new Response("globalThis.__syntheticBootstrap = true;");
      },
    });
    stage("bootstrap-executed");
    assert.equal(await bootstrap.page.evaluate(() => globalThis.__syntheticBootstrap), true);
    assert.equal(sends, 1);
    // Deliberately permissive CSP is the adversary, never the permission source.
    stage("hostile-page");
    const hostile = await bootstrap.context.newPage();
    await hostile.setContent(
      "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src * data: blob: 'unsafe-inline'; connect-src *; script-src * blob: 'unsafe-inline'\"><title>SYNTHETIC</title>",
    );
    for (const kind of ["fetch", "xhr", "script", "image", "frame", "worker", "popup", "form", "beacon", "websocket"]) {
      stage(`child-${kind}`);
      const before = bootstrap.snapshot().attempts;
      await hostile.evaluate(async (kind) => {
        const url = "https://example.invalid/SYNTHETIC_PRIVATE";
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
          const done = () => resolve();
          if (kind === "fetch") void fetch(url).then(done, done);
          if (kind === "xhr") {
            const x = new XMLHttpRequest();
            x.onerror = done;
            x.open("GET", url);
            x.send();
          }
          if (["script", "image", "frame"].includes(kind)) {
            const element = document.createElement({ script: "script", image: "img", frame: "iframe" }[kind]);
            element.onerror = done;
            element.onload = done;
            element.src = url;
            document.body.appendChild(element);
          }
          if (kind === "worker") {
            const source = URL.createObjectURL(
              new Blob([`fetch(${JSON.stringify(url)}).catch(() => {});`], { type: "text/javascript" }),
            );
            const worker = new Worker(source);
            worker.onerror = done;
            setTimeout(() => {
              worker.terminate();
              URL.revokeObjectURL(source);
              done();
            }, 200);
          }
          if (kind === "popup") window.open(url);
          if (kind === "form") {
            const frame = document.createElement("iframe");
            frame.name = "synthetic-form";
            document.body.appendChild(frame);
            const form = document.createElement("form");
            form.target = frame.name;
            form.action = url;
            form.method = "POST";
            document.body.appendChild(form);
            form.submit();
          }
          if (kind === "beacon") navigator.sendBeacon(url, "SYNTHETIC_PRIVATE");
          if (kind === "websocket") {
            const socket = new WebSocket("wss://example.invalid/SYNTHETIC_PRIVATE");
            socket.onerror = done;
          }
        });
      }, kind);
      console.log(
        `installed-boundary child-client:${JSON.stringify({ kind, before, after: bootstrap.snapshot().attempts, sends })}`,
      );
      assert.ok(bootstrap.snapshot().attempts > before, `alternate-client-${kind}`);
      assert.equal(sends, 1);
      pass(`child-${kind}-send0`);
    }
    assert.ok(!JSON.stringify(bootstrap.snapshot()).includes("SYNTHETIC_PRIVATE"));
    pass("permissive-csp-does-not-authorize");
    for (const name of ["WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection", "SharedWorker"]) {
      stage(`unsupported-${name}`);
      const before = bootstrap.snapshot().attempts;
      assert.equal(
        await hostile.evaluate((name) => {
          try {
            new globalThis[name]("https://example.invalid/SYNTHETIC_PRIVATE");
            return false;
          } catch (error) {
            return error.message === "browser-policy-blocked";
          }
        }, name),
        true,
      );
      assert.ok(bootstrap.snapshot().attempts > before);
      assert.equal(sends, 1);
      pass(`unsupported-${name}-send0`);
    }
    stage("atomic-cap");
    await hostile
      .evaluate(async () => {
        await Promise.allSettled(Array.from({ length: 140 }, () => fetch("https://example.invalid/SYNTHETIC_PRIVATE")));
      })
      .catch(() => {});
    console.log(
      `installed-boundary atomic-cap:${JSON.stringify({
        attempts: bootstrap.snapshot().attempts,
        sends,
        closing: bootstrap.closed() !== undefined,
        pageClosed: bootstrap.page.isClosed(),
      })}`,
    );
    assert.equal(bootstrap.snapshot().attempts, 128);
    assert.equal(sends, 1);
    assert.ok(bootstrap.closed());
    await bootstrap.closed();
    assert.equal(bootstrap.page.isClosed(), true);
    pass("atomic-cap-destroys-child");
  } finally {
    await (bootstrap ? bootstrap.close() : browser.close());
  }
}
