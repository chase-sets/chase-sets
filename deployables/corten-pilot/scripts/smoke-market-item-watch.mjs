// Uses the item page's Watch forms in a browser, against the real platform API.
// - As a guest, without JavaScript: Watch is the pilot's own tab, Set listing alert saves an intent,
//   keeps its owner in marketplace's cookie, and lands on marketplace's registration with the claim
//   in its return address.
// - As the auth seed's collector, with JavaScript: Set offer alert saves the account's alert with
//   the catalog's words, the page comes back on its Watch tab saying so, and Manage alerts opens
//   the pilot's notification center at the alerts, read after the write, with the new alert.
// - A threshold with a third decimal is held by the field's step, and the server refuses one too.
// - At 390 px with both folds open, nothing scrolls sideways and every control is at least 40 px.
// It writes a guest intent (which expires on its own) and an account alert, which it deletes.
// Usage: node scripts/smoke-market-item-watch.mjs [pilot-url] [collector-state] [marketplace-url] [api-url] [slug]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7793",
  collectorState = "../../artifacts/corten-pilot/collector-state.json",
  web = "http://localhost:7753",
  api = "http://localhost:7762",
  slug = "charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp",
] = process.argv.slice(2);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const collector = JSON.parse(readFileSync(collectorState, "utf8"))
  .cookies.filter((c) => c.name === "chase_sets_session")
  .map((c) => `${c.name}=${c.value}`)
  .join("; ");
const alertsApi = `${api}/api/marketplace/account/product-alerts`;
const writes = { cookie: collector, "content-type": "application/json", origin: web };
const alerts = async () => (await (await fetch(alertsApi, { headers: { cookie: collector } })).json()).items ?? [];
async function eventually(read, done) {
  let value = await read();
  for (let i = 0; i < 30 && !done(value); i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    value = await read();
  }
  return value;
}

const read = await (
  await fetch(`${api}/api/marketplace/items/${slug}`, { headers: { "chase-sets-read-target-context": "discovery" } })
).json();
// Raw and Near Mint: a product with listings and an offer in the seed.
const choice = "dimension.dim_seed_form=chc_seed_form_raw&dimension.dim_seed_condition=chc_seed_condition_near_mint";
const watchPage = `${base}/items/${slug}?market=watch&${choice}`;

const browser = await chromium.launch();
const elsewhere = [];
async function context({ javaScriptEnabled, state, viewport }) {
  const ctx = await browser.newContext({
    javaScriptEnabled,
    ...(state ? { storageState: state } : {}),
    ...(viewport ? { viewport } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  const theirs = (text) =>
    !page.url().startsWith(base) && (elsewhere.push(`${page.url().split("?")[0]}: ${text.slice(0, 160)}`), true);
  page.on(
    "console",
    (m) => m.type() === "error" && !m.text().includes("status of 422") && !theirs(m.text()) && problems.push(m.text()),
  );
  page.on("pageerror", (e) => !theirs(String(e)) && problems.push(String(e)));
  page.on("response", (r) => {
    if (r.status() === 404 || r.status() >= 500)
      (r.url().startsWith(base) ? problems : elsewhere).push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return { ctx, page, problems };
}
const rail = (page) => page.locator('[aria-labelledby="rail-title"]');
const fold = (page, name) =>
  rail(page)
    .locator("details")
    .filter({ hasText: new RegExp(`^\\s*${name}`) });
const created = [];

try {
  // A guest, without JavaScript.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: false });
    await page.goto(`${base}/items/${slug}?${choice}`);
    const tab = page.getByRole("navigation", { name: "Choose market intent" }).getByRole("link", { name: "Watch" });
    check(new URL(await tab.getAttribute("href"), base).origin === base, "Watch is the pilot's own tab");
    await tab.click();
    check((await rail(page).locator("#rail-title").textContent()) === "Watch", "the rail is the Watch card");
    check(
      (await rail(page).innerText()).includes("Alerts are created after account registration"),
      "a guest is told an alert needs an account",
    );
    const listings = fold(page, "Watch listings");
    check((await listings.getAttribute("open")) !== null, "Watch listings is open");
    check(
      (await listings.locator('input[name="currency"]').inputValue()) === "USD",
      "its currency starts as the listings'",
    );
    await listings.locator('input[name="threshold"]').fill("300");
    await listings.getByRole("button", { name: "Set listing alert" }).click();
    await page.waitForURL((u) => u.href.startsWith(`${web}/register`));
    const back = new URL(new URL(page.url()).searchParams.get("returnTo") ?? "/", web);
    const intent = back.searchParams.get("claimProductAlertIntent");
    check(
      back.pathname === `/items/${slug}` && back.searchParams.get("market") === "watch" && Boolean(intent),
      `it lands on marketplace's registration, back to the Watch tab with the claim (${intent})`,
    );
    const owner = (await ctx.cookies()).find((c) => c.name === "chase_sets_anonymous_product_alerts")?.value;
    check(
      Boolean(owner?.startsWith("anon_cmd_")),
      `the guest's owner is kept in marketplace's cookie (${owner?.slice(0, 9)}...)`,
    );
    check((await page.locator("body").innerText()).length > 0, "marketplace's registration loads");
    check(problems.length === 0, `no errors on the pilot's pages (${problems.join("; ")})`);
    await ctx.close();
  }

  // The collector, with JavaScript.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: true, state: collectorState });
    const before = await alerts();
    await page.goto(watchPage);
    const offers = fold(page, "Watch offers");
    await offers.locator("summary").click();
    // The browser holds a threshold with a third decimal itself; the server refuses one too.
    await offers.locator('input[name="threshold"]').fill("1.234");
    check(
      await offers.locator('input[name="threshold"]').evaluate((e) => e.validity.stepMismatch),
      "a threshold of 1.234 does not pass the field's step",
    );
    const refused = await page.evaluate(async (url) => {
      const form = document.querySelector('[aria-labelledby="rail-title"] form input[name="side"][value="offer"]').form;
      const body = new URLSearchParams(new FormData(form));
      body.set("threshold", "1.234");
      return (
        await fetch(url, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } })
      ).status;
    }, `${base}/items/${slug}/watch`);
    check(refused === 422, `and the server refuses it (${refused})`);
    await offers.locator('input[name="threshold"]').fill("15");
    await offers.getByRole("button", { name: "Set offer alert" }).click();
    await page.waitForURL((u) => u.searchParams.has("watched"));
    await page.waitForFunction(() => !(/** @type {any} */ (window).navigation?.transition));
    const at = new URL(page.url());
    check(at.origin === base && at.searchParams.get("market") === "watch", "the page comes back on its Watch tab");
    const banner = rail(page).getByRole("status");
    check((await banner.innerText()).includes("Watch alert saved"), "and says the alert was saved (chase-sets#10597)");
    const after = await eventually(alerts, (a) => a.length > before.length);
    const alert = after.find((a) => !before.some((b) => b.alert_id === a.alert_id));
    if (alert) created.push(alert.alert_id);
    check(
      alert?.market_side === "offer" && alert?.threshold_amount === "15.00" && alert?.threshold_currency_code === "USD",
      `the account has the offer alert at 15.00 USD (${alert?.alert_id})`,
    );
    check(
      alert?.catalog_catalog_item_id === read.catalog_item_id && alert?.product_summary === "Raw / Near Mint",
      `with the catalog's product and words (${alert?.product_summary})`,
    );
    await banner.getByRole("link", { name: "Manage alerts" }).click();
    await page.waitForURL((u) => u.href.startsWith(`${base}/account/notifications`));
    const settings = new URL(page.url());
    check(
      settings.searchParams.get("section") === "product-alerts" && settings.hash === "#product-alerts",
      `Manage alerts opens the pilot's alert settings at the alerts (${settings.search}${settings.hash})`,
    );
    const listed = await page.locator("#product-alerts").innerText();
    check(
      listed.includes("Raw / Near Mint") && listed.includes("Offers - at or above $15.00"),
      "and lists the new alert",
    );
    check(problems.length === 0, `no errors on the pilot's pages (${problems.join("; ")})`);
    await ctx.close();
  }

  // At 390 px with both folds open, as a guest and as the collector.
  for (const state of [undefined, collectorState]) {
    const { ctx, page } = await context({ javaScriptEnabled: true, state, viewport: { width: 390, height: 844 } });
    await page.goto(watchPage);
    const closed = rail(page).locator("details:not([open]) > summary");
    for (let left = await closed.count(); left > 0; left--) await closed.first().click();
    const { wide, small } = await page.evaluate(() => ({
      wide: document.documentElement.scrollWidth > window.innerWidth,
      small: Array.from(
        document.querySelectorAll(
          '[aria-labelledby="rail-title"] :is(a, button, input:not([type="hidden"]), summary), nav[aria-label="Choose market intent"] a',
        ),
      )
        .filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 40)
        .map(
          (e) =>
            `${e.tagName} "${e.textContent.trim().slice(0, 20)}" ${Math.round(e.getBoundingClientRect().height)}px`,
        ),
    }));
    const who = state ? "collector" : "guest";
    check(!wide, `390 px (${who}): nothing scrolls sideways`);
    check(small.length === 0, `390 px (${who}): every watch control is at least 40 px (${small.join(", ")})`);
    await page.screenshot({ path: `../../artifacts/corten-pilot/item-watch-390-${who}.png`, fullPage: true });
    await ctx.close();
  }
} finally {
  for (const id of created) {
    const status = (await fetch(`${alertsApi}/${id}/delete`, { method: "POST", headers: writes, body: "{}" })).status;
    check(status === 200, `the collector's alert is deleted again (${status})`);
  }
  await browser.close();
}
if (elsewhere.length)
  console.log(
    `note marketplace's own pages logged ${elsewhere.length} errors (not counted):\n     ${[...new Set(elsewhere)].slice(0, 6).join("\n     ")}`,
  );
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
