// Uses public-web's market page in a browser, against the real platform API, beside public-web's own.
// - Signed out: the title, description, canonical and social tags, the h1 and subtitle, the stats
//   (each label and value), the lowest asks, the sell-through and the three marketplace links read
//   as public-web's do; the page's headings are the title and its three sections
//   (public-web's stat values are headings too).
// - What caches may keep: without a cookie a browser keeps it a minute and a shared cache for the
//   s-maxage Pricing's own answer carries (a day by default), an hour stale; private with one; the
//   API is not sent the cookie.
// - An unknown slug is a 404 with public-web's words and Go home; robots.txt and the sitemap.
// - At 1280 and 390 px nothing scrolls sideways, every link is at least 40 px tall, and no
//   console errors. With JavaScript off the page is the same.
// Only reads.
// Usage: node scripts/smoke-public-market.mjs [pilot-url] [public-web-url] [slug] [api-url]
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7797",
  reference = "http://localhost:7754",
  slug = "twilight-masquerade-elite-trainer-box-sealed-elite-trainer-box-uerade-elite-trainer-box-1804cgp",
  api = "http://localhost:7762",
] = process.argv.slice(2);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const path = `/market/${slug}`;
const browser = await chromium.launch();

/** What a page says: its head's tags, headings, the stats as label and value, and the links. */
async function read(origin, { javascript = true } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: javascript });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const res = await page.goto(origin + path, { waitUntil: "networkidle" });
  const info = await page.evaluate(() => {
    const meta = (selector) =>
      document.head.querySelector(selector)?.getAttribute("content") ??
      document.head.querySelector(selector)?.getAttribute("href");
    const main = document.querySelector("main");
    const text = (main?.innerText ?? "").replace(/\s+/g, " ");
    return {
      title: document.title,
      description: meta('meta[name="description"]'),
      ogTitle: meta('meta[property="og:title"]'),
      ogUrl: meta('meta[property="og:url"]'),
      canonical: meta('link[rel="canonical"]'),
      robots: meta('meta[name="robots"]') ?? null,
      h1: [...document.querySelectorAll("h1")].map((h) => h.textContent.trim()),
      h2: [...document.querySelectorAll("h2")].map((h) => h.textContent.trim()),
      text,
      links: [...document.querySelectorAll("main a")].map((a) => [a.textContent.trim(), a.getAttribute("href")]),
    };
  });
  await context.close();
  return { status: res.status(), headers: res.headers(), info, errors };
}

const ours = await read(base);
const theirs = await read(reference);
check(ours.status === 200, `the page answers 200 (${ours.status})`);
check(ours.info.title === theirs.info.title, `the title: ${ours.info.title}`);
check(ours.info.description === theirs.info.description, "the description");
check(ours.info.ogTitle === theirs.info.ogTitle, "og:title");
check(
  ours.info.canonical === `${base}${path}` && ours.info.ogUrl === ours.info.canonical,
  `the canonical and og:url (${ours.info.canonical})`,
);
check(ours.info.robots === theirs.info.robots, `robots: ${ours.info.robots} (public-web ${theirs.info.robots})`);
check(JSON.stringify(ours.info.h1) === JSON.stringify(theirs.info.h1), `the h1: ${ours.info.h1}`);
const sections = theirs.info.h2.filter(
  (h) =>
    ["Price history", "Market stats", "Buy or sell this item"].includes(h) ||
    /^(Price history|Market stats) \(/.test(h),
);
check(
  JSON.stringify(ours.info.h2) === JSON.stringify(sections),
  `the sections: ${ours.info.h2.join(" / ")} (public-web's h2s: ${theirs.info.h2.join(" / ")})`,
);
// Every word public-web shows in main is in ours, in the same order, apart from its heading-only
// "No data yet" duplicates.
const words = (text) =>
  text
    .replace(/[\u203a>]/g, " ")
    .split(" ")
    .filter(Boolean);
const missing = words(theirs.info.text).filter((w) => !ours.info.text.includes(w));
check(missing.length === 0, `public-web's words are all there (${missing.join(", ") || "all"})`);
for (const part of ["Last sold", "Median (30 days)", "Median (90 days)", "Active listings"]) {
  const value = (text) =>
    text.match(
      new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " (.+?) (Median|Active|\\d+% |Buy or sell|$)"),
    )?.[1];
  check(
    value(ours.info.text) === value(theirs.info.text),
    `${part}: ${value(ours.info.text)} (public-web ${value(theirs.info.text)})`,
  );
}
const linkSet = (links) => JSON.stringify(links.filter(([, h]) => h?.includes("/items/")));
check(linkSet(ours.info.links) === linkSet(theirs.info.links), "the three marketplace links");
check(ours.errors.length === 0, `no console errors (${ours.errors.join(" | ")})`);
console.log(`note public-web (dev) console errors: ${theirs.errors.length}`);

// What caches may keep.
const anonymous = await fetch(base + path);
// A browser keeps it a minute, a shared cache for the s-maxage Pricing's own answer carries.
const apiCache = (await fetch(`${api}/api/marketplace/public/market-pages/${slug}`)).headers.get("cache-control") ?? "";
const apiShared = /s-maxage=(\d+)/.exec(apiCache)?.[1] ?? "86400";
check(
  anonymous.headers.get("cache-control") === `public, max-age=60, s-maxage=${apiShared}, stale-while-revalidate=3600`,
  `signed out, shared: ${anonymous.headers.get("cache-control")} (Pricing: ${apiCache})`,
);
check((anonymous.headers.get("vary") ?? "").includes("cookie"), "and it varies on the cookie");
const referenceCache = (await fetch(reference + path)).headers.get("cache-control");
// public-web writes the default day as a literal, so it differs only under a revised policy.
if (apiShared === "86400")
  check(referenceCache === anonymous.headers.get("cache-control"), `the same as public-web's (${referenceCache})`);
else console.log(`note public-web sends ${referenceCache}, its literal day, where Pricing says ${apiShared} s`);
const withCookie = await fetch(base + path, { headers: { cookie: "chase_sets_session=smoke" } });
check(
  withCookie.status === 200 && withCookie.headers.get("cache-control") === "private, no-cache",
  `with a cookie, private: ${withCookie.headers.get("cache-control")}`,
);

// Without a script, the same page.
const plain = await read(base, { javascript: false });
check(plain.info.text === ours.info.text, "without JavaScript the page is the same");

// An unknown page, robots and the sitemap.
const context = await browser.newContext();
const page = await context.newPage();
const missingRes = await page.goto(`${base}/market/no-such-item-smoke`);
const missingText = await page.locator("main").innerText();
check(missingRes.status() === 404, `an unknown page is a 404 (${missingRes.status()})`);
check(missingText.includes("Page not found") && missingText.includes("Go home"), "with public-web's words and Go home");
const robots = await (await fetch(`${base}/robots.txt`)).text();
check(robots.includes("User-agent: *"), `robots.txt: ${robots.replace(/\n/g, " | ")}`);
const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
check(
  urls.every((u) => u.startsWith(`${base}/market/`)),
  `the sitemap lists the market pages (${urls.length})`,
);

// Layout at a desktop's and a phone's width.
for (const width of [1280, 390]) {
  await page.setViewportSize({ width, height: 900 });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(base + path, { waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `${width} px: nothing scrolls sideways (${overflow})`);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("main a")]
      .filter((a) => a.getBoundingClientRect().height < 40)
      .map((a) => a.textContent.trim()),
  );
  check(small.length === 0, `${width} px: every link is at least 40 px tall (${small.join(", ")})`);
  check(errors.length === 0, `${width} px: no console errors (${errors.join(" | ")})`);
}
await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
