// Measures a ported screen in the React app and in the pilot the same way, signed in as the same
// user: admin's postage policies (the list and a policy's sheet), admin's catalog dimensions (the
// list and a dimension, `screen=catalog`), admin's operations attention queue (`screen=attention`), marketplace's storage locations
// (`screen=marketplace`), its cart (`screen=cart`), an item page (`screen=item`), search (`screen=search`, `/search?q=` and `/search`) the home page (`screen=home`, `/`) a set's page (`screen=set`, `/sets/{set}`) or a listing's (`screen=listing`, `/listings/{listing}`), as the auth seed's collector, cold-cache loads on desktop and on a
// Lighthouse-style mobile profile (4x CPU, 150 ms RTT, 1.6 Mbps down), the bytes each load
// transfers by kind, and the server's time for the document. Modeled on Corten's
// bench/fullstack/browser.mjs. Interactive means the page's scripts ran: admin-web's
// `data-admin-web-hydrated`, the first element marketplace's React hydrated (its own e2e tests'
// check, polled every 10 ms), and the pilot's `__hydratedAt` (static/app.js).
// Usage: node scripts/measure.mjs name=url [name=url ...] [screen=admin|catalog|attention|marketplace|cart|item|search|home|set|listing] [q=search words] [runs=7] [state=..] [policy=id]
//        [dimension=id] [slug=item slug] [set=set slug] [listing=listing slug] [profiles=desktop,mobile] [out=file]
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const named = Object.fromEntries(process.argv.slice(2).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
const screen = named.screen ?? "admin";
const login = { marketplace: "marketplace", cart: "collector", item: "collector", search: "collector", home: "collector", set: "collector", listing: "collector" }[screen] ?? "admin";
const {
  screen: _screen,
  runs: runsText = "7",
  state = `../../artifacts/corten-pilot/${login}-state.json`,
  policy = "opp_seed_default",
  dimension = "",
  profiles: only,
  slug: _slug,
  q: _q,
  set: _set,
  listing: _listing,
  out,
  ...apps
} = named;
const runs = Number(runsText);
const profiles = {
  desktop: { cpu: 1, network: null },
  mobile: { cpu: 4, network: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 } },
};
const screens = {
  admin: { list: "/commerce/postage-policies", sheet: `/commerce/postage-policies?policy=${policy}` },
  catalog: { list: "/catalog/dimensions", ...(dimension ? { detail: `/catalog/dimensions/${dimension}` } : {}) },
  attention: { queue: "/platform/operations-attention" },
  marketplace: { list: "/account/inventory/locations" },
  cart: { list: "/account/cart" },
  search: { results: `/search?q=${encodeURIComponent(named.q ?? "charizard")}`, browse: "/search" },
  home: { home: "/" },
  set: { page: `/sets/${named.set ?? "base-set"}` },
  listing: {
    page: `/listings/${named.listing ?? "lugia-neo-genesis-9-111-holo-rare-form-graded-grading-company-bgs-grade-mint-9-5-lugia-neo-genesis-bgs-95-og22h"}`,
  },
  item: { page: `/items/${named.slug ?? "charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp"}` },
};
for (const name of only ? Object.keys(profiles).filter((p) => !only.split(",").includes(p)) : []) delete profiles[name];
const pages = screens[screen];
if (!pages) throw new Error(`unknown screen ${screen}: admin, catalog, attention, marketplace, cart, item, search, home, set or listing`);

// Each load starts on a page from another site, as in Corten's benchmark.
const startPage = createServer((_, res) => res.end("<!DOCTYPE html><title>start</title><p>start</p>"));
await new Promise((resolve) => startPage.listen(0, "127.0.0.1", resolve));
const startUrl = `http://127.0.0.1:${/** @type {any} */ (startPage.address()).port}/`;

const observe = () => {
  window.__lcp = 0;
  window.__longTasks = [];
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__longTasks.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true });
  // admin-web marks <html data-admin-web-hydrated="true"> when React has hydrated.
  new MutationObserver((_, o) => {
    if (document.documentElement.dataset.adminWebHydrated === "true" && window.__hydratedAt === undefined) {
      window.__hydratedAt = performance.now();
      o.disconnect();
    }
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-admin-web-hydrated"] });
  // marketplace marks nothing; React has hydrated once an element carries its props.
  const poll = setInterval(() => {
    if (window.__hydratedAt !== undefined) return clearInterval(poll);
    const link = document.querySelector("main a, header a");
    if (link && Object.keys(link).some((k) => k.startsWith("__reactProps$"))) {
      window.__hydratedAt = performance.now();
      clearInterval(poll);
    }
  }, 10);
};

async function load(browser, profile, url) {
  const context = await browser.newContext({ storageState: state });
  await context.addInitScript(observe);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (profile.network) await cdp.send("Network.emulateNetworkConditions", profile.network);
  if (profile.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  try {
    await page.goto(startUrl);
    const res = await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    if (res?.status() !== 200) throw new Error(`${url} answered ${res?.status()}`);
    await page.waitForFunction(() => typeof window.__hydratedAt === "number", null, { timeout: 120_000 });
    await page.waitForTimeout(300);
    return await page.evaluate(() => {
      const nav = /** @type {PerformanceNavigationTiming} */ (performance.getEntriesByType("navigation")[0]);
      const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
      const bytes = { html: nav.transferSize, js: 0, css: 0, font: 0, data: 0 };
      const decoded = { html: nav.decodedBodySize, js: 0, css: 0 };
      // Each stylesheet by its name past the asset version (`components.css`, `sections/catalog.css`).
      const stylesheets = {};
      let requests = 1;
      for (const r of /** @type {PerformanceResourceTiming[]} */ (performance.getEntriesByType("resource"))) {
        requests += 1;
        const kind = /\.m?js(\?|$)/.test(r.name) ? "js" : /\.css(\?|$)/.test(r.name) ? "css" : /\.woff2?(\?|$)/.test(r.name) ? "font" : "data";
        bytes[kind] += r.transferSize;
        if (kind in decoded) decoded[kind] += r.decodedBodySize;
        if (kind === "css") {
          const name = new URL(r.name).pathname.replace(/^\/assets\/[0-9a-f]+\//, "");
          stylesheets[name] = { transfer: r.transferSize, decoded: r.decodedBodySize };
        }
      }
      const hydratedAt = window.__hydratedAt;
      const tbt = window.__longTasks.filter(([s]) => s < hydratedAt).reduce((sum, [, d]) => sum + Math.max(0, d - 50), 0);
      return {
        ttfb: nav.responseStart,
        serverMs: nav.responseStart - nav.requestStart,
        fcp,
        lcp: window.__lcp,
        interactive: hydratedAt,
        tbt,
        bytes,
        decoded,
        stylesheets,
        requests,
      };
    });
  } finally {
    await context.close();
  }
}

/** A load whose page navigated mid-measure (a dev server reloading itself) is loaded again, twice at most. */
async function loadAgain(browser, profile, url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await load(browser, profile, url);
    } catch (error) {
      if (attempt >= 3 || !/Execution context was destroyed/.test(String(error))) throw error;
      console.log(`again ${url}: the page navigated while it was measured`);
    }
  }
}

const median = (xs) => {
  const s = xs.filter((x) => x !== null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

function summarize(samples) {
  const pick = (f) => median(samples.map(f));
  return {
    runs: samples.length,
    ttfbMs: pick((s) => s.ttfb),
    serverMs: pick((s) => s.serverMs),
    fcpMs: pick((s) => s.fcp),
    lcpMs: pick((s) => s.lcp),
    interactiveMs: pick((s) => s.interactive),
    tbtMs: pick((s) => s.tbt),
    transferBytes: Object.fromEntries(Object.keys(samples[0].bytes).map((k) => [k, pick((s) => s.bytes[k])])),
    decodedBytes: Object.fromEntries(Object.keys(samples[0].decoded).map((k) => [k, pick((s) => s.decoded[k])])),
    requests: pick((s) => s.requests),
    stylesheets: Object.fromEntries(
      Object.keys(samples[0].stylesheets).map((k) => [
        k,
        { transfer: pick((s) => s.stylesheets[k]?.transfer ?? null), decoded: pick((s) => s.stylesheets[k]?.decoded ?? null) },
      ]),
    ),
  };
}

const browser = await chromium.launch({ headless: true });
const results = { measuredAt: new Date().toISOString(), screen, runs, policy, dimension, apps: {} };
for (const [name, base] of Object.entries(apps)) {
  results.apps[name] = { base };
  for (const [pageName, path] of Object.entries(pages)) {
    for (const [profileName, profile] of Object.entries(profiles)) {
      const samples = [];
      await loadAgain(browser, profile, `${base}${path}`); // warm the server, not the browser
      for (let i = 0; i < runs; i += 1) samples.push(await loadAgain(browser, profile, `${base}${path}`));
      const summary = summarize(samples);
      results.apps[name][`${pageName}/${profileName}`] = summary;
      console.log(
        `${name.padEnd(10)} ${pageName.padEnd(6)} ${profileName.padEnd(8)} interactive ${Math.round(summary.interactiveMs)} ms, ` +
          `LCP ${Math.round(summary.lcpMs)} ms, server ${Math.round(summary.serverMs)} ms, JS ${summary.transferBytes.js} B ` +
          `(${summary.decodedBytes.js} B decoded), HTML ${summary.transferBytes.html} B, CSS ${summary.transferBytes.css} B, ${summary.requests} requests`,
      );
    }
  }
}
await browser.close();
startPage.close();
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
}
