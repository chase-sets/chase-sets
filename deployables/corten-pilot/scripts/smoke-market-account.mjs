// Uses an account's public page in a browser, against the real platform API, beside marketplace's.
// - Without JavaScript, as a visitor: the account's name, badges, feedback and listings as
//   marketplace shows them; an unknown account is a 404 kept out of search engines (marketplace
//   answers 200); the account's id moves to its slug; the role links
//   read the reviews again.
// - A report with no reason is refused by the pilot before anything is sent, with the review's
//   dialog drawn open (no write).
// - As the platform admin (neither the review's author nor the account): Report review opens a
//   modal dialog, and the report is received once; every later run is told it was sent already
//   (one write, the first time only).
// - At 1280 px the ratings side by side and the listings two by two; at 390 px one column,
//   nothing scrolls sideways and every control is at least 40 px tall.
// Usage: node scripts/smoke-market-account.mjs [pilot-url] [marketplace-url] [reporter-state]
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7793",
  market = "http://localhost:7753",
  state = "../../artifacts/corten-pilot/admin-state.json",
] = process.argv.slice(2);
const SLUG = "chase-sets-acc-seed-demo-account-1mltldk";
const ID = "acc_seed_demo_account";
const REVIEW = "rev_seed_buyer_to_seller_active";
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
    // Marketplace names the account in an h2 and has no h1.
    title: document.querySelector("main h1, main h2")?.textContent?.trim(),
    h1: document.querySelectorAll("h1").length,
    text: document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "",
    // Marketplace writes the value before its label.
    since: (document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "")
      .match(/Member since ([A-Z][a-z]+ \d{4})|([A-Z][a-z]+ \d{4}) Member since/)
      ?.slice(1)
      .find(Boolean),
    listings: document.querySelectorAll('main a[href^="/listings/"]').length,
    reviews: [...document.querySelectorAll('main [id^="review-"]')].map((r) => r.id),
  }));

// No script, as a visitor, beside marketplace.
{
  const { ctx, page } = await context({ javaScriptEnabled: false });
  await page.goto(`${market}/accounts/${SLUG}`);
  const theirs = await facts(page);
  theirs.listings = await page.locator('main a[href*="/listings/"]').count();
  await page.goto(`${base}/accounts/${SLUG}`);
  const ours = await facts(page);
  check(ours.title && ours.title === theirs.title, `the name: ${ours.title} (marketplace ${theirs.title})`);
  check(ours.h1 === 1, `one h1, the account's name (${ours.h1}; marketplace has ${theirs.h1})`);
  for (const words of [
    "Verified account",
    "Trusted seller",
    "Member since",
    "Feedback",
    "As seller",
    "As buyer",
    "Collector Zero",
    "Order confidence",
  ]) {
    check(
      ours.text.includes(words) === theirs.text.includes(words),
      `${words}: ${ours.text.includes(words)} (marketplace ${theirs.text.includes(words)})`,
    );
  }
  check(ours.since && ours.since === theirs.since, `member since: ${ours.since} (marketplace ${theirs.since})`);
  check(
    ours.listings > 0 && ours.listings === theirs.listings,
    `listing links: ${ours.listings} (marketplace ${theirs.listings})`,
  );
  check(ours.reviews.includes(`review-${REVIEW}`), `the review's card is #review-${REVIEW}`);
  const missing = await page.request.get(`${base}/accounts/no-such-account-${Date.now()}`);
  check(
    missing.status() === 404 && missing.headers()["x-robots-tag"] === "noindex",
    `an unknown account is a 404, noindex (${missing.status()})`,
  );
  const moved = await page.request.get(`${base}/accounts/${ID}?role=buyer`, { maxRedirects: 0 });
  check(
    moved.status() === 301 && moved.headers().location === `/accounts/${SLUG}?role=buyer`,
    `the account's id moves to its slug (${moved.status()} ${moved.headers().location})`,
  );
  await page.getByRole("link", { name: "As buyer", exact: true }).click();
  await page.waitForLoadState();
  const url = new URL(page.url());
  check(
    url.searchParams.get("role") === "buyer" && url.hash === "#feedback",
    `As buyer reads the buyer's reviews at the feedback: ${url.search}${url.hash}`,
  );
  check(
    (await page.locator('a[aria-current="page"]', { hasText: "As buyer" }).count()) === 1,
    "and marks As buyer current",
  );
  await ctx.close();
}

// A report with no reason, refused here: the dialog drawn open, nothing sent.
{
  const { ctx, page } = await context({ storageState: state });
  await page.goto(`${base}/accounts/${SLUG}`);
  const answer = await page.request.post(`${base}/accounts/${SLUG}/reviews/${REVIEW}/report`, {
    form: { reason: "", details: "kept" },
    maxRedirects: 0,
  });
  check(answer.status() === 422, `a report with no reason is refused (${answer.status()})`);
  const html = await answer.text();
  check(
    /<dialog id="report-dialog-[^"]+"[^>]* open/.test(html) && html.includes(">kept</textarea>"),
    "with its dialog open and the explanation kept",
  );
  await ctx.close();
}

// Report review as the platform admin: a modal, then received once or sent already.
{
  const { ctx, page, problems } = await context({ storageState: state });
  await page.goto(`${base}/accounts/${SLUG}`);
  await page.waitForFunction(() => window.__hydratedAt);
  const card = page.locator(`#review-${REVIEW}`);
  const button = card.getByRole("button", { name: /Report/ });
  if (await button.isDisabled()) {
    check(true, "the review was reported already on this page");
  } else {
    await button.click();
    const dialog = page.locator(`#report-dialog-${REVIEW}`);
    check(await dialog.evaluate((d) => d.open && d.matches(":modal")), "Report review opens a modal dialog");
    await dialog.getByRole("button", { name: "Close" }).click();
    check(!(await dialog.evaluate((d) => d.open)), "Close closes it");
    await button.click();
    await dialog.getByLabel(/^Reason/).selectOption("other");
    const [answer] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/report")),
      dialog.getByRole("button", { name: "Submit report" }).click(),
    ]);
    await page.waitForLoadState();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    const status = await card
      .getByRole("status")
      .innerText()
      .catch(() => "");
    check(
      [204, 303, 409].includes(answer.status()) && /Report (already )?submitted/.test(status),
      `the report: ${answer.status()}, "${status.split("\n")[0]}"`,
    );
    const at = new URL(page.url());
    if (answer.status() !== 409) {
      check(
        at.hash === `#review-${REVIEW}` && at.searchParams.get("reported") === REVIEW,
        `back at the review: ${at.search}${at.hash}`,
      );
    }
  }
  // A repeat report is a 409 page, which the browser logs as a failed load.
  const unexpected = problems.filter((p) => !p.includes("status of 409"));
  check(unexpected.length === 0, `no console errors${unexpected.length ? `: ${unexpected.join(" | ")}` : ""}`);
  await ctx.close();
}

// Layout.
for (const [width, height, sides, listings] of [
  [1280, 900, 2, 2],
  [390, 844, 1, 1],
]) {
  const { ctx, page, problems } = await context({ viewport: { width, height } });
  await page.goto(`${base}/accounts/${SLUG}`);
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
    const count = (selector) => {
      const el = document.querySelector(selector);
      return el ? getComputedStyle(el).gridTemplateColumns.split(" ").length : 0;
    };
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      small,
      sides: count('main [class*="__sides"]'),
      listings: count('main [class*="__listings"]'),
    };
  });
  check(layout.sides === sides, `the ratings in ${sides} column(s) at ${width} px (${layout.sides})`);
  check(layout.listings === listings, `the listings in ${listings} column(s) at ${width} px (${layout.listings})`);
  check(layout.overflow <= 0, `nothing scrolls sideways at ${width} px (${layout.overflow})`);
  check(
    layout.small.length === 0,
    `every control is at least 40 px tall at ${width} px${layout.small.length ? `: ${layout.small.join(", ")}` : ""}`,
  );
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await page.screenshot({ path: `${process.env.TEMP}/pilot-account-${width}.png`, fullPage: true });
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
