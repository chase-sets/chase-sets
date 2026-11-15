// Uses a set's page in a browser, against the real platform API, as a visitor, beside
// marketplace's own (reads only).
// - Without JavaScript: the set's name, what is known of it and its cards, in marketplace's order
//   and with its links; an unknown set is a 404 kept out of search engines (marketplace answers
//   200).
// - At 1280 px two columns of cards; at 390 px one, nothing scrolls sideways and every control is
//   at least 40 px tall.
// Usage: node scripts/smoke-market-set.mjs [pilot-url] [marketplace-url] [set slug]
import { chromium } from "@playwright/test";

const [base = "http://localhost:7793", market = "http://localhost:7753", slug = "base-set"] = process.argv.slice(2);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch();
async function context({ javaScriptEnabled = true, viewport = { width: 1280, height: 900 } } = {}) {
  const ctx = await browser.newContext({ javaScriptEnabled, viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}
const cards = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("main a")]
      .filter((a) => /^View card$/.test(a.textContent.trim()))
      .map((a) => new URL(a.href).pathname),
  );

// No script, beside marketplace.
{
  const { ctx, page } = await context({ javaScriptEnabled: false });
  await page.goto(`${market}/sets/${slug}`);
  const theirs = { name: (await page.locator("main h1").first().textContent())?.trim(), cards: await cards(page) };
  await page.goto(`${base}/sets/${slug}`);
  const ours = { name: (await page.locator("main h1").first().textContent())?.trim(), cards: await cards(page) };
  check(ours.name === theirs.name && ours.name, `the set's name: ${ours.name} (marketplace ${theirs.name})`);
  check(
    ours.cards.length > 0 && JSON.stringify(ours.cards) === JSON.stringify(theirs.cards),
    `its cards, in marketplace's order: ${ours.cards.length} (marketplace ${theirs.cards.length})`,
  );
  const facts = await page.locator("main header p").first().textContent();
  check(/Cataloged items: \d+/.test(facts ?? ""), `what is known of it: ${facts}`);
  check((await page.title()).endsWith("card list | Marketplace"), `the title: ${await page.title()}`);
  const missing = await page.request.get(`${base}/sets/no-such-set-${Date.now()}`);
  check(
    missing.status() === 404 && missing.headers()["x-robots-tag"] === "noindex",
    `an unknown set is a 404, noindex (${missing.status()})`,
  );
  await ctx.close();
}

// Columns, 1280 and 390 px.
const layoutAt = (page) =>
  page.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll("main a, main button, main input, main select")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || el.getAttribute("aria-hidden") === "true") continue;
      if (r.height < 40)
        small.push(`${el.tagName} ${(el.textContent || "").trim().slice(0, 30)} ${Math.round(r.height)}`);
    }
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, small };
  });
const columns = (page) =>
  page.evaluate(() => getComputedStyle(document.querySelector("main ol")).gridTemplateColumns.split(" ").length);
for (const [width, height, expected] of [
  [1280, 900, 2],
  [390, 844, 1],
]) {
  const { ctx, page, problems } = await context({ viewport: { width, height } });
  await page.goto(`${base}/sets/${slug}`);
  await page.waitForFunction(() => window.__hydratedAt);
  check((await columns(page)) === expected, `${expected} column(s) of cards at ${width} px`);
  const layout = await layoutAt(page);
  check(layout.overflow <= 0, `nothing scrolls sideways at ${width} px (${layout.overflow})`);
  check(
    layout.small.length === 0,
    `every control is at least 40 px tall at ${width} px${layout.small.length ? `: ${layout.small.join(", ")}` : ""}`,
  );
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
