// The account's reviews (`/account/reviews`, `/received`, `/written`) in a browser, against the real
// platform API, as the auth seed's collector. Only reads: Report review is tested against the
// stand-in API (marketplace/src/tests.rs), so the sandbox's moderation queue is left alone.
// - Summary: the account's name, both ratings, and each of its ten newest revealed reviews.
// - Lists: each review Reputation lists, a card or the words for a withdrawn, paused or pending
//   one; Report review only on an active, revealed review that is not held; the role filter keeps
//   the role and marks it current.
// - A review's own page, for each review listed: the review or its stand-in words, the order and
//   back links, Report review only where it may be sent, and Respond to this review only for the
//   account reviewed, once, on an active, revealed review not held; a review that is not the
//   account's is not found. Open review leads there.
// - Report review's dialog opens and closes without sending anything.
// - At 390 px nothing scrolls sideways and every control is at least 44 px tall; without
//   JavaScript the same pages; a visitor is sent to sign in; no console errors.
// Usage: node scripts/smoke-reviews.mjs [pilot-url] [collector-state] [api-url]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  state = "../../artifacts/corten-pilot/collector-state.json",
  api = "http://localhost:7762",
] = process.argv.slice(2);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const cookie = JSON.parse(readFileSync(state, "utf8"))
  .cookies.filter((c) => c.name === "chase_sets_session")
  .map((c) => `${c.name}=${c.value}`)
  .join("; ");
const read = async (path) => (await fetch(`${api}${path}`, { headers: { cookie } })).json();
const { accountId } = (await read("/api/auth/session")).actor;
const summary = await read(`/api/marketplace/accounts/${accountId}/review-summary`);
const newest = (await read(`/api/marketplace/accounts/${accountId}/reviews?limit=10&offset=0`)).items ?? [];
const lists = {
  received: (await read("/api/marketplace/reviews/received?limit=100&offset=0")).items ?? [],
  written: (await read("/api/marketplace/reviews/written?limit=100&offset=0")).items ?? [],
  "received?role=seller": (await read("/api/marketplace/reviews/received?limit=100&offset=0&role=seller")).items ?? [],
};
console.log(`Reputation: ${newest.length} newest, ${lists.received.length} received, ${lists.written.length} written`);
const reportable = (r) => r.status === "active" && r.revealed_at !== null && !r.held;
const details = {};
for (const r of [...lists.received, ...lists.written])
  details[r.review_id] = await read(`/api/marketplace/reviews/${r.review_id}`);

async function detail(page, label, id) {
  const r = details[id];
  const res = await page.goto(`${base}/account/reviews/${id}`);
  check(res?.status() === 200, `${label} ${id}: its page answers 200 (${res?.status()})`);
  check((await text(page, "main h1")) === "Review details", `${label} ${id}: the heading is Review details`);
  const owns = r.author_account_id === accountId;
  const role = owns ? r.author_role : r.author_role === "buyer" ? "seller" : "buyer";
  const order = `/account/${role === "buyer" ? "purchases" : "sales"}/${r.order_id}`;
  const back = `/account/reviews/${owns ? "written" : "received"}?role=${role}`;
  const links = await page.$$eval("main header a", (els) => els.map((e) => e.getAttribute("href")));
  check(
    links.includes(order) && links.includes(back),
    `${label} ${id}: View order outcome and Back (${links.join(", ")})`,
  );
  const main = await text(page, "main");
  if (r.status === "withdrawn") check(main.includes("Review withdrawn"), `${label} ${id}: says it was withdrawn`);
  else if (r.rating === null)
    check(main.includes(r.held ? "Review paused" : "A review is pending"), `${label} ${id}: stands in`);
  else check(main.includes(r.author_display_name ?? r.author_account_id), `${label} ${id}: names its author`);
  const mayReport = r.rating !== null && reportable(r) && r.feedback_redacted_at === null;
  check(
    (await page.locator(`#report-review-dialog-${id}`).count()) === (mayReport ? 1 : 0),
    `${label} ${id}: Report review only where it may be sent (${mayReport})`,
  );
  const mayReply = r.subject_account_id === accountId && reportable(r) && r.reply_id === null;
  check(
    (await page.locator("#reply-feedback").count()) === (mayReply ? 1 : 0),
    `${label} ${id}: Respond only for the account reviewed, once (${mayReply})`,
  );
}

const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 }, signedIn = true } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, ...(signedIn ? { storageState: state } : {}) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  const problems = [];
  // The not-found check asks for a 404 on purpose; the browser logs that load as an error.
  page.on(
    "console",
    (m) => m.type() === "error" && !m.location().url.endsWith("/rev_not_this_accounts") && problems.push(m.text()),
  );
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}
const text = (page, selector) =>
  page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim() ?? "", selector);
const anchors = (page) =>
  page.$$eval('li[id^="review-anchor-"]', (els) => els.map((e) => e.id.slice("review-anchor-".length)));
const dialogs = (page) =>
  page.$$eval('dialog[id^="report-review-dialog-"]', (els) =>
    els.map((e) => e.id.slice("report-review-dialog-".length)),
  );
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function pages(page, label) {
  let res = await page.goto(`${base}/account/reviews`);
  check(res?.status() === 200, `${label}: the summary answers 200 (${res?.status()})`);
  const name = summary.account_display_name ?? "Your reviews";
  check((await text(page, "main h1")) === name, `${label}: the heading is the account's name (${name})`);
  const main = await text(page, "main");
  check(main.includes("As seller") && main.includes("As buyer"), `${label}: both ratings`);
  const seller = summary.average_rating_as_seller;
  if (seller) check(main.includes(Number.parseFloat(seller).toFixed(1)), `${label}: the seller average ${seller}`);
  const rated = newest.filter((r) => r.rating !== null).map((r) => r.review_id);
  check(same(await anchors(page), rated), `${label}: each newest revealed review (${rated.length})`);
  check(
    same(
      await dialogs(page),
      newest.filter((r) => r.rating !== null && reportable(r)).map((r) => r.review_id),
    ),
    `${label}: Report review only where it may be sent`,
  );

  for (const which of ["received", "written", "received?role=seller"]) {
    res = await page.goto(`${base}/account/reviews/${which}`);
    check(res?.status() === 200, `${label} ${which}: answers 200 (${res?.status()})`);
    const items = lists[which];
    check(
      same(
        await anchors(page),
        items.map((r) => r.review_id),
      ),
      `${label} ${which}: each review Reputation lists (${items.length})`,
    );
    check(
      same(
        await dialogs(page),
        items.filter((r) => r.rating !== null && reportable(r)).map((r) => r.review_id),
      ),
      `${label} ${which}: Report review only where it may be sent`,
    );
    const body = await text(page, "main");
    for (const r of items) {
      if (r.status === "withdrawn")
        check(body.includes("Review withdrawn"), `${label} ${which}: ${r.review_id} says it was withdrawn`);
      else if (r.rating === null)
        check(
          body.includes(r.held ? "Review paused" : "A review is pending"),
          `${label} ${which}: ${r.review_id} stands in`,
        );
    }
    if (items.length === 0)
      check(
        body.includes(which.startsWith("received") ? "No received reviews yet" : "No written reviews yet"),
        `${label} ${which}: none says so`,
      );
    const current = await text(page, 'main a[aria-current="page"]');
    check(
      current === (which.includes("role=seller") ? "As seller" : "All"),
      `${label} ${which}: the current role is marked (${current})`,
    );
  }
  for (const id of Object.keys(details)) await detail(page, label, id);
  const missing = await page.goto(`${base}/account/reviews/rev_not_this_accounts`);
  check(missing?.status() === 404, `${label}: a review that is not the account's is not found (${missing?.status()})`);
}

try {
  {
    const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
    await pages(page, "390 px");
    const opened = lists.received.find((r) => r.rating !== null) ?? lists.written.find((r) => r.rating !== null);
    for (const path of [
      "/account/reviews",
      "/account/reviews/received",
      ...(opened ? [`/account/reviews/${opened.review_id}`] : []),
    ]) {
      await page.goto(`${base}${path}`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check(overflow <= 0, `${path}: nothing scrolls sideways at 390 px (${overflow})`);
      const small = await page.$$eval("main button, main a[class]", (els) =>
        els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 60)),
      );
      check(small.length === 0, `${path}: every control is at least 44 px tall (${small.join(" | ")})`);
    }
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }
  {
    const { ctx, page, problems } = await context();
    await pages(page, "1280 px");
    const where = ["received", "written"].find((w) => lists[w].some((r) => r.rating !== null && reportable(r)));
    const target = where && lists[where].find((r) => r.rating !== null && reportable(r));
    if (target) {
      await page.goto(`${base}/account/reviews/${where}`);
      const dialog = page.locator(`#report-review-dialog-${target.review_id}`);
      await page.locator(`[commandfor="report-review-dialog-${target.review_id}"]`).first().click();
      check(await dialog.evaluate((d) => d.open), "Report review opens its dialog");
      check((await dialog.locator("select option").count()) === 5, "the dialog offers the five reasons");
      await dialog.locator('button[command="close"]').click();
      check(!(await dialog.evaluate((d) => d.open)), "Close shuts it without sending");
    } else {
      console.log("skip: no review here may be reported");
    }
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }
  {
    const { ctx, page } = await context({ javaScriptEnabled: false });
    await pages(page, "without a script");
    await ctx.close();
  }
  {
    const { ctx, page } = await context({ signedIn: false });
    await page.goto(`${base}/account/reviews/written`);
    check(new URL(page.url()).pathname.startsWith("/sign-in"), `a visitor is sent to sign in (${page.url()})`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
