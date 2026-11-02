// Uses the item page's sell forms in a browser, against the real platform API. As a guest, without
// JavaScript, it checks four things:
// - the Sell rail shows the best offer's total and what accepting it pays under the public standard
//   terms, as the Marketplace API quotes them;
// - Add offer to Sell List shows the API's refusal;
// - Add product to Sell List saves the product to a guest sell list and lands on marketplace's sell
//   list, which shows it;
// - the line has the catalog's words.
// As marketplace's seed seller, with JavaScript, Accept offer is the seller's (`sell-now`) and shows the
// same refusal, and a product add goes to the account's sell list (only when the product is not on it
// already, since an add would merge into that line). As the auth seed's collector, who may not manage
// offers, Accept offer is forbidden. At 390 px the forms do not scroll sideways and every control is at
// least 40 px tall.
// It writes guest and account sell-list lines and removes them again.
// Usage: node scripts/smoke-market-item-sell.mjs [pilot-url] [seller-state] [collector-state] [marketplace-url] [api-url] [slug]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7793",
  sellerState = "../../artifacts/corten-pilot/marketplace-state.json",
  collectorState = "../../artifacts/corten-pilot/collector-state.json",
  web = "http://localhost:7753",
  api = "http://localhost:7762",
  slug = "charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp",
] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const sessionOf = (file) =>
  JSON.parse(readFileSync(file, "utf8"))
    .cookies.filter((c) => c.name === "chase_sets_session")
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
const seller = sessionOf(sellerState);
const checkout = (extra = {}) => ({
  "chase-sets-read-target-context": "checkout",
  "content-type": "application/json",
  ...extra,
});
const guestHeaders = (id) => checkout({ "x-checkout-anonymous-sell-list-id": id });
const sellList = async (headers, owner) =>
  (await (await fetch(`${api}/api/marketplace/${owner}/sell-list`, { headers })).json()).items ?? [];
const remove = async (headers, owner, line) =>
  (await fetch(`${api}/api/marketplace/${owner}/sell-list/${line}/remove`, { method: "POST", headers, body: "{}" }))
    .status;
async function eventually(read, done) {
  let value = await read();
  for (let i = 0; i < 25 && !done(value); i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    value = await read();
  }
  return value;
}
async function shows(page, text) {
  for (let i = 0; i < 30; i += 1) {
    if ((await page.locator("body").innerText()).includes(text)) return true;
    await page.waitForTimeout(500);
    if (i % 4 === 3) await page.reload();
  }
  console.log(`     (${page.url()}: ${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 400)})`);
  return false;
}

const read = await (
  await fetch(`${api}/api/marketplace/items/${slug}`, { headers: { "chase-sets-read-target-context": "discovery" } })
).json();
const offer = read.offer_demand_matches.find(
  (o) => o.status === "submitted" && o.catalog_catalog_item_id === read.catalog_item_id,
);
check(
  Boolean(offer),
  `the item has an offer for sellers (${offer?.offer_id}, ${offer?.price_amount} x ${offer?.quantity_requested})`,
);
const usd = (cents) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: offer.price_currency_code ?? "USD" }).format(
    cents / 100,
  );
const cents = (amount) => Math.round(Number(amount) * 100);
const terms = await (
  await fetch(`${api}/api/marketplace/terms/public-standard/listing-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ priceAmount: offer.price_amount }),
  })
).json();
const quantity = offer.quantity_requested;
const total = cents(offer.price_amount) * quantity;
const expected = {
  total: `${usd(total)} offer`,
  payout: `${usd(cents(terms.seller_net_unit_amount) * quantity)} after ${usd(cents(terms.marketplace_sales_fee_unit_amount) * quantity)} fee`,
  allowance: `${usd(Math.round((total * terms.shipping_allowance_percentage_bps) / 10000))} (${terms.shipping_allowance_percentage_bps / 100}%)`,
};
const refusal = "Selected offer sell-list lines must reference an Offer and exact Listing.";

const browser = await chromium.launch();
async function context({ javaScriptEnabled, state, viewport }) {
  const ctx = await browser.newContext({
    javaScriptEnabled,
    ...(state ? { storageState: state } : {}),
    ...(viewport ? { viewport } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  // Errors on the pilot's pages count; marketplace's own pages' are reported, not counted. The
  // console's 422 is a refusal's answer, which the smoke expects.
  const problems = [];
  const theirs = (text) =>
    !page.url().startsWith(base) && (elsewhere.push(`${page.url().split("?")[0]}: ${text.slice(0, 160)}`), true);
  page.on(
    "console",
    (m) => m.type() === "error" && !m.text().includes("status of 422") && !theirs(m.text()) && problems.push(m.text()),
  );
  page.on("pageerror", (e) => !theirs(String(e)) && problems.push(String(e)));
  page.on("response", (r) => {
    if (r.status() === 404 || r.status() >= 500) {
      const what = `${r.status()} ${r.request().method()} ${r.url()}`;
      if (r.url().startsWith(base)) problems.push(what);
      else elsewhere.push(what);
    }
  });
  return { ctx, page, problems };
}
const rail = (page) => page.locator('[aria-labelledby="rail-title"]');
const productFold = (page) =>
  rail(page)
    .locator("details")
    .filter({ hasText: /^\s*Add product to Sell List/ });
const sellPage = `${base}/items/${slug}?market=sell`;
/** Presses `name` on the rail and answers the status of the pilot's answer to the post. */
async function press(page, name) {
  const answer = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/sell-list"));
  await rail(page).getByRole("button", { name, exact: true }).click();
  const res = await answer;
  await page.waitForLoadState();
  return res.status();
}
const added = [];
const elsewhere = [];

try {
  // A guest, without JavaScript.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: false });
    await page.goto(sellPage);
    const text = (await rail(page).innerText()).replace(/\s+/g, " ");
    check(text.includes(expected.total), `the rail shows the offer's total (${expected.total})`);
    check(
      text.includes(`Seller payout ${expected.payout}`),
      `and what it pays under the standard terms (${expected.payout})`,
    );
    check(
      text.includes(`Shipping allowance ${expected.allowance}`),
      `and the shipping allowance (${expected.allowance})`,
    );
    check(
      (await rail(page).getByRole("button", { name: "Accept offer" }).getAttribute("value")) === "add-to-sell-list",
      "a guest's Accept offer saves the offer",
    );

    const status = await press(page, "Add offer to Sell List");
    check(status === 422, `Add offer to Sell List is refused (${status})`);
    check(
      (await rail(page).getByRole("alert").textContent()) === refusal,
      "with the API's reason, on the rail (chase-sets#8830)",
    );
    check(
      (await ctx.cookies()).every((c) => c.name !== "chase_sets_anonymous_sell_list"),
      "and no guest sell list is kept",
    );

    await page.goto(sellPage);
    await productFold(page)
      .locator("summary")
      .click()
      .catch(() => {});
    await productFold(page).locator('input[name="quantity"]').fill("1");
    await rail(page).getByRole("button", { name: "Add product to Sell List", exact: true }).click();
    await page.waitForURL((u) => u.href.startsWith(`${web}/account/sell-list`));
    check(
      new URL(page.url()).searchParams.has("afterWrite"),
      "Add product to Sell List lands on marketplace's sell list, after the write",
    );
    const id = (await ctx.cookies()).find((c) => c.name === "chase_sets_anonymous_sell_list")?.value;
    check(
      Boolean(id?.startsWith("anon_cmd_")),
      `the guest's sell list is kept in marketplace's cookie (${id?.slice(0, 9)}...)`,
    );
    check(await shows(page, read.title), "marketplace's sell list shows the product");
    const lines = id
      ? await eventually(
          () => sellList(guestHeaders(id), "guest"),
          (l) => l.length > 0,
        )
      : [];
    const line = lines.find((l) => l.product_id === offer.product_id);
    check(
      Boolean(line) && line.quantity === 1 && line.line_type === "product",
      `the guest sell list has the product once (${lines.map((l) => [l.product_id === offer.product_id, l.quantity])})`,
    );
    check(line?.item_title === read.title && line?.item_subtitle === read.subtitle, "with the catalog's words");
    for (const l of lines) added.push({ headers: guestHeaders(id), owner: "guest", line: l.line_id });
    check(problems.length === 0, `no console errors (${problems.join("; ")})`);
    await ctx.close();
  }

  // Marketplace's seed seller, with JavaScript.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: true, state: sellerState });
    await page.goto(sellPage);
    check(
      (await rail(page).innerText()).includes("Fees and terms are calculated before acceptance."),
      "an account's rail does not quote the public terms",
    );
    check(
      (await rail(page).getByRole("button", { name: "Accept offer" }).getAttribute("value")) === "sell-now",
      "a seller's Accept offer is sell-now",
    );
    const status = await press(page, "Accept offer");
    check(
      status === 422 && (await rail(page).getByRole("alert").textContent()) === refusal,
      `Accept offer is refused with the API's reason (${status})`,
    );

    const headers = checkout({ cookie: seller });
    const before = await sellList(headers, "account");
    if (
      before.some((l) => l.line_type === "product" && l.product_id === offer.product_id && l.fallback_mode === "none")
    ) {
      console.log(
        "skip the seller's product add: the product is on their sell list already, and an add would merge into it",
      );
    } else {
      await page.goto(sellPage);
      await productFold(page).locator("summary").click();
      await productFold(page).locator('input[name="quantity"]').fill("2");
      await rail(page).getByRole("button", { name: "Add product to Sell List", exact: true }).click();
      await page.waitForURL((u) => u.href.startsWith(`${web}/account/sell-list`));
      const after = await eventually(
        () => sellList(headers, "account"),
        (l) => l.length > before.length,
      );
      const line = after.find((l) => !before.some((b) => b.line_id === l.line_id));
      check(
        line?.product_id === offer.product_id && line?.quantity === 2,
        `the account's sell list has the product, 2 (${line?.line_id})`,
      );
      if (line) added.push({ headers, owner: "account", line: line.line_id });
      check(await shows(page, read.title), "marketplace's sell list shows it");
    }
    check(problems.length === 0, `no console errors (${problems.join("; ")})`);
    await ctx.close();
  }

  // The collector, who may not manage offers.
  {
    const { ctx, page } = await context({ javaScriptEnabled: false, state: collectorState });
    await page.goto(sellPage);
    const status = await press(page, "Accept offer");
    check(status === 403, `an account that may not manage offers cannot accept one (${status})`);
    await ctx.close();
  }

  // At 390 px, with every fold open.
  for (const state of [undefined, sellerState]) {
    const { ctx, page } = await context({ javaScriptEnabled: true, state, viewport: { width: 390, height: 844 } });
    await page.goto(sellPage);
    const closed = rail(page).locator("details:not([open]) > summary");
    for (let left = await closed.count(); left > 0; left--) await closed.first().click();
    const { wide, small } = await page.evaluate(() => ({
      wide: document.documentElement.scrollWidth > window.innerWidth,
      small: Array.from(
        document.querySelectorAll('[aria-labelledby="rail-title"] :is(a, button, input:not([type="hidden"]), summary)'),
      )
        .filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 40)
        .map(
          (e) =>
            `${e.tagName} "${e.textContent.trim().slice(0, 20)}" ${Math.round(e.getBoundingClientRect().height)}px`,
        ),
    }));
    const who = state ? "seller" : "guest";
    check(!wide, `390 px (${who}): nothing scrolls sideways`);
    check(small.length === 0, `390 px (${who}): every sell control is at least 40 px (${small.join(", ")})`);
    await page.screenshot({ path: `../../artifacts/corten-pilot/item-sell-390-${who}.png`, fullPage: true });
    await ctx.close();
  }
} finally {
  for (const { headers, owner, line } of added) {
    const status = await remove(headers, owner, line);
    check(status === 200, `the ${owner} sell list's added line is removed again (${status})`);
  }
  await browser.close();
}
if (elsewhere.length)
  console.log(
    `note marketplace's own pages logged ${elsewhere.length} errors (not counted):\n     ${[...new Set(elsewhere)].slice(0, 6).join("\n     ")}`,
  );
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
