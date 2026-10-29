// Uses a listing's public page in a browser, against the real platform API, beside marketplace's.
// - Without JavaScript, as a visitor: the listing's title, price, seller and options as
//   marketplace shows them; an unknown listing is a 404 kept out of search engines; Buy this
//   listing goes to marketplace's guest checkout with the listing; a report from a visitor who
//   reported it already says so (the page keeps the visitor `anon_corten_pilot_smoke`, who
//   reported the Lugia listing once, so the smoke adds no report: three reporters unlist a
//   listing).
// - As the collector: Buy this listing starts a checkout session and lands on the pilot's
//   checkout (writes a checkout session).
// - At 1280 px the panel and the seller side by side; at 390 px one column, nothing scrolls
//   sideways and every control is at least 40 px tall.
// Usage: node scripts/smoke-market-listing.mjs [pilot-url] [marketplace-url] [state]
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7793",
  market = "http://localhost:7753",
  state = "../../artifacts/corten-pilot/collector-state.json",
] = process.argv.slice(2);
const LUGIA =
  "lugia-neo-genesis-9-111-holo-rare-form-graded-grading-company-bgs-grade-mint-9-5-lugia-neo-genesis-bgs-95-og22h";
const REPORTER = "anon_corten_pilot_smoke";
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 }, storageState } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, storageState });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}
const facts = (page) =>
  page.evaluate(() => ({
    title: document.querySelector("main h1")?.textContent?.trim(),
    text: document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "",
  }));

// No script, as a visitor, beside marketplace.
{
  const { ctx, page } = await context({ javaScriptEnabled: false });
  await page.goto(`${market}/listings/${LUGIA}`);
  const theirs = await facts(page);
  await page.goto(`${base}/listings/${LUGIA}`);
  const ours = await facts(page);
  check(ours.title && ours.title === theirs.title, `the title: ${ours.title} (marketplace ${theirs.title})`);
  const line = (text) => text.match(/\$[\d,.]+ from [^\s]+( [A-Z][a-z]+)?/)?.[0];
  check(
    line(ours.text) && line(ours.text) === line(theirs.text),
    `the price and seller: ${line(ours.text)} (marketplace ${line(theirs.text)})`,
  );
  for (const words of ["1 available", "Ships from Chicago, IL", "Order protected", "Shipping credit"]) {
    check(
      ours.text.includes(words) === theirs.text.includes(words),
      `${words}: ${ours.text.includes(words)} (marketplace ${theirs.text.includes(words)})`,
    );
  }
  const missing = await page.request.get(`${base}/listings/no-such-listing-${Date.now()}`);
  check(
    missing.status() === 404 && missing.headers()["x-robots-tag"] === "noindex",
    `an unknown listing is a 404, noindex (${missing.status()})`,
  );
  // Buy as a visitor: marketplace's guest checkout, with the listing.
  const [guest] = await Promise.all([
    page.waitForRequest((r) => r.url().startsWith(`${market}/checkout/buy/readiness`)),
    page.getByRole("button", { name: "Buy this listing" }).click(),
  ]);
  const sent = new URL(guest.url()).searchParams;
  check(
    sent.get("source") === "buy-now" && sent.get("lockedListingId")?.startsWith("lst_"),
    `a visitor's Buy goes to guest checkout: ${sent.get("lockedListingId")}`,
  );
  await ctx.close();
}

// The report, as a visitor who reported the listing already.
{
  const { ctx, page } = await context({ javaScriptEnabled: false });
  await ctx.addCookies([{ name: "chase_sets_anonymous_reports", value: REPORTER, url: base }]);
  await page.goto(`${base}/listings/${LUGIA}`);
  await page.getByLabel(/^Reason/).selectOption("counterfeit-concern");
  const [answer] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/report")),
    page.getByRole("button", { name: "Report listing" }).click(),
  ]);
  await page.waitForLoadState();
  check(answer.status() === 409, `a repeat report is a 409, not a 500 (${answer.status()})`);
  check(
    await page.getByRole("status").filter({ hasText: "You have already reported this listing." }).isVisible(),
    "and the page says it was reported already",
  );
  await ctx.close();
}

// Buy as the collector: a checkout session, then the pilot's checkout.
{
  const { ctx, page, problems } = await context({ storageState: state });
  await page.goto(`${base}/listings/${LUGIA}`);
  await page.waitForFunction(() => window.__hydratedAt);
  const [checkout] = await Promise.all([
    page.waitForRequest((r) => r.url().startsWith(`${base}/checkout/buy/session/`)),
    page.getByRole("button", { name: "Buy this listing" }).click(),
  ]);
  check(
    /\/checkout\/buy\/session\/[^/?]+/.test(checkout.url()),
    `the collector's Buy starts a checkout: ${new URL(checkout.url()).pathname}`,
  );
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

// Layout.
for (const [width, height, columns] of [
  [1280, 900, 2],
  [390, 844, 1],
]) {
  const { ctx, page, problems } = await context({ viewport: { width, height } });
  await page.goto(`${base}/listings/${LUGIA}`);
  await page.waitForFunction(() => window.__hydratedAt);
  const layout = await page.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll("main a, main button, main select, main textarea")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.height < 40)
        small.push(
          `${el.tagName} ${(el.textContent || el.getAttribute("name") || "").trim().slice(0, 30)} ${Math.round(r.height)}`,
        );
    }
    const columns = document.querySelector('main [class*="__columns"]');
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      small,
      columns: columns ? getComputedStyle(columns).gridTemplateColumns.split(" ").length : 0,
    };
  });
  check(layout.columns === columns, `${columns} column(s) at ${width} px (${layout.columns})`);
  check(layout.overflow <= 0, `nothing scrolls sideways at ${width} px (${layout.overflow})`);
  check(
    layout.small.length === 0,
    `every control is at least 40 px tall at ${width} px${layout.small.length ? `: ${layout.small.join(", ")}` : ""}`,
  );
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await page.screenshot({ path: `${process.env.TEMP}/pilot-listing-${width}.png`, fullPage: true });
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
