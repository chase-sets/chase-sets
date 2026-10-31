// Uses the item page's buy forms in a browser, against the real platform API: as the auth seed's
// collector with JavaScript and without it, and as a guest without it. It adds a listing and a
// product to the buy cart, buys the best match (the pilot's cart, after the write), is refused a
// quantity the lowest listing does not have, buys a listing now (the pilot's checkout session),
// and as a guest adds to a guest cart (marketplace's cart reads it) and goes to guest checkout.
// The forms are on a product the collector's cart does not hold; the lines it adds are removed
// at the end, so the cart is left as it was found. At 390 px the forms do not scroll sideways
// and every control, the quantity and the folded product and offer forms included, is at least 40 px tall.
// It writes: cart lines (removed again), a guest cart line (removed again) and one checkout
// session (left open; nothing is reserved until payment starts).
// Usage: node scripts/smoke-market-item-buy.mjs [pilot-url] [state-file] [marketplace-url] [api-url] [slug]
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7793",
  stateFile = "../../artifacts/corten-pilot/collector-state.json",
  web = "http://localhost:7753",
  api = "http://localhost:7762",
  slug = "charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp",
] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const state = JSON.parse(readFileSync(stateFile, "utf8"));
const session = state.cookies
  .filter((c) => c.name === "chase_sets_session")
  .map((c) => `${c.name}=${c.value}`)
  .join("; ");
const checkout = (cookie, extra = {}) => ({ cookie, "chase-sets-read-target-context": "checkout", ...extra });
const cart = async () =>
  (await (await fetch(`${api}/api/marketplace/account/cart`, { headers: checkout(session) })).json()).items;
const before = await cart();
const read = await (
  await fetch(`${api}/api/marketplace/items/${slug}`, { headers: { "chase-sets-read-target-context": "discovery" } })
).json();
const held = new Set(before.map((l) => l.product_id));
// A product with one buyable listing that the cart does not hold.
const listing = read.market_listings.find(
  (l) => !held.has(l.product_id) && Number(l.visible_quantity ?? 0) === 1 && l.status === "active",
);
check(Boolean(listing), `a listing of a product the cart does not hold (${listing?.listing_id})`);
const productLines = async () => (await cart()).filter((l) => l.product_id === listing.product_id);
// The smoke reads the API without the write's receipt, so a read may not have the write yet.
async function eventually(read, done) {
  let value = await read();
  for (let i = 0; i < 25 && !done(value); i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    value = await read();
  }
  return value;
}
const units = (lines) => lines.reduce((n, l) => n + l.quantity, 0);
/** The page has `text` once it has loaded (a swap, or a read that waits for a write); else what it says. */
async function shows(page, text, { reload = false } = {}) {
  for (let i = 0; i < 30; i += 1) {
    if ((await page.locator("body").innerText()).includes(text)) return true;
    await page.waitForTimeout(500);
    // Without JavaScript, a page still catching up says to refresh it. A page that reads itself
    // again (the checkout's two-second re-read) may already be navigating, so a reload it aborts
    // is not a failure.
    if (reload && i % 4 === 3)
      await page.reload().catch((e) => {
        if (!/ERR_ABORTED|detached/.test(String(e))) throw e;
      });
  }
  console.log(`     (${page.url()}: ${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 400)})`);
  return false;
}

const browser = await chromium.launch();
async function context({ javaScriptEnabled, signedIn, viewport }) {
  const ctx = await browser.newContext({
    javaScriptEnabled,
    ...(signedIn ? { storageState: stateFile } : {}),
    ...(viewport ? { viewport } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  // The console's "Failed to load resource" names no URL.
  page.on("response", (r) => r.status() === 404 && problems.push(`404 ${r.request().method()} ${r.url()}`));
  return { ctx, page, problems };
}
const rail = (page) => page.locator('[aria-labelledby="rail-title"]');
const listingForm = (page) =>
  rail(page)
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add listing to Buy Cart" }) });
const productForm = (page) =>
  rail(page)
    .locator("details")
    .filter({ hasText: /^\s*Selected product/ })
    .locator("form");
const offerForm = (page) =>
  rail(page)
    .locator("details")
    .filter({ hasText: /^\s*Make an offer/ })
    .locator("form");

try {
  // The collector, with JavaScript: the listing, then the product, then Buy best match.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: true, signedIn: true });
    await page.goto(`${base}/items/${slug}?listing=${listing.listing_id}`);
    check((await rail(page).locator("h2").textContent()) === "Selected listing", "the listing chosen is the rail's");
    await listingForm(page).getByRole("button", { name: "Add listing to Buy Cart" }).click();
    await page.waitForURL(/added=/);
    check(
      await rail(page).getByText("Added to buy cart").isVisible(),
      "Add listing to Buy Cart: the page says it was added",
    );
    const locked = await eventually(productLines, (lines) => lines.length > 0);
    check(
      locked.length === 1 && locked[0].locked_listing_id === listing.listing_id && locked[0].quantity === 1,
      `the cart has the line, locked to the listing (${JSON.stringify(locked.map((l) => [l.locked_listing_id, l.quantity]))})`,
    );
    check(
      locked[0]?.selected_listing_snapshot_source === "discovery.item-detail.add-to-cart" &&
        locked[0]?.item_image_loading_url === read.image_fallback.url,
      "with marketplace's snapshot source and the card back to load with",
    );
    const view = await rail(page).getByRole("link", { name: "View buy cart" }).getAttribute("href");
    check(
      view.startsWith("/account/cart?after_write="),
      `View buy cart is the pilot's cart, after the write (${view.slice(0, 40)})`,
    );

    await page.goto(`${base}/items/${slug}?listing=${listing.listing_id}`);
    await rail(page)
      .locator("summary", { hasText: /^\s*Selected product/ })
      .click();
    await productForm(page).getByRole("button", { name: "Add product to Buy Cart" }).click();
    await page.waitForURL(/added=/);
    check(await rail(page).getByText("Added to buy cart").isVisible(), "Add product to Buy Cart: added");
    const lines = await eventually(productLines, (lines) => units(lines) >= 2);
    check(
      units(lines) === 2,
      `the product is in the cart twice over (${JSON.stringify(lines.map((l) => [l.fulfillment_mode, l.locked_listing_id, l.quantity]))})`,
    );

    // More than the lowest listing has: refused, nothing sent.
    await page.goto(`${base}/items/${slug}?listing=${listing.listing_id}`);
    await rail(page)
      .locator("summary", { hasText: /^\s*Selected product/ })
      .click();
    await productForm(page).locator('input[name="quantity"]').fill("5");
    await productForm(page).getByRole("button", { name: "Buy best match" }).click();
    await rail(page).getByRole("alert").waitFor();
    check(
      (await rail(page).getByRole("alert").textContent()).startsWith("Only 1 available from this listing."),
      "Buy best match for 5 of 1: refused with the listing's count",
    );
    check(units(await productLines()) === 2, "and nothing was added");
    await productForm(page).locator('input[name="quantity"]').fill("1");
    await productForm(page).getByRole("button", { name: "Buy best match" }).click();
    await page.waitForURL(/\/account\/cart\?after_write=/);
    check(await shows(page, read.title), "Buy best match opens the pilot's cart, read after the write");
    // The refused form's answer is a 422, which the browser logs as a failed load.
    const unexpected = problems.filter((p) => !p.includes("status of 422"));
    check(unexpected.length === 0, `no other console errors (${unexpected.join("; ")})`);
    check(units(await eventually(productLines, (lines) => units(lines) >= 3)) === 3, "Buy best match added the third");
    await ctx.close();
  }

  // The collector without JavaScript: Buy this listing starts a checkout session, the pilot's
  // checkout (ported in bed5ccc448) read after the write.
  {
    const { ctx, page } = await context({ javaScriptEnabled: false, signedIn: true });
    await page.goto(`${base}/items/${slug}?listing=${listing.listing_id}`);
    await listingForm(page).getByRole("button", { name: "Buy this listing" }).click();
    await page.waitForURL(/\/checkout\/buy\/session\//);
    const at = new URL(page.url());
    check(
      at.origin === new URL(base).origin && at.searchParams.has("afterWrite"),
      `Buy this listing: the pilot's checkout session, with the write's receipt (${at.origin}${at.pathname})`,
    );
    check(
      await shows(page, read.subtitle, { reload: true }),
      "the checkout shows the item (once it has caught up, by itself or refreshed)",
    );

    // Make an offer: a good price goes to
    // marketplace's offer checkout with the product and the offer (nothing is written).
    await page.goto(`${base}/items/${slug}?listing=${listing.listing_id}`);
    await rail(page)
      .locator("summary", { hasText: /^\s*Make an offer/ })
      .click();
    // The browser itself holds a price with a third decimal (the server refuses one too).
    await offerForm(page).locator('input[name="price"]').fill("1.234");
    check(
      await offerForm(page)
        .locator('input[name="price"]')
        .evaluate((e) => e.validity.stepMismatch),
      "an offer of 1.234 does not pass the field's step",
    );
    await offerForm(page).locator('input[name="price"]').fill("10");
    await offerForm(page).locator('input[name="quantity"]').fill("2");
    await offerForm(page).getByRole("button", { name: "Make offer" }).click();
    await page.waitForURL(/source=offer-intent/);
    const offer = new URL(page.url()).searchParams;
    check(
      offer.get("productId") === listing.product_id &&
        offer.get("offerPriceAmount") === "10.00" &&
        offer.get("offerPriceCurrencyCode") === "USD" &&
        offer.get("quantity") === "2",
      `Make offer: marketplace's offer checkout for the product, $10.00 x 2 (${offer.get("offerPriceAmount")} ${offer.get("offerPriceCurrencyCode")} x ${offer.get("quantity")})`,
    );
    check(await shows(page, read.subtitle), "which shows the item");
    await ctx.close();
  }

  // A guest without JavaScript: a guest cart marketplace reads, and guest checkout.
  {
    const { ctx, page } = await context({ javaScriptEnabled: false });
    await page.goto(`${base}/items/${slug}?listing=${listing.listing_id}`);
    await listingForm(page).getByRole("button", { name: "Add listing to Buy Cart" }).click();
    await page.waitForURL(/added=/);
    const guest = (await ctx.cookies()).find((c) => c.name === "chase_sets_anonymous_cart");
    check(
      guest?.value.startsWith("anon_") && guest.httpOnly,
      `the guest's cart id is kept in marketplace's cookie (${guest?.value.slice(0, 9)}...)`,
    );
    const view = await rail(page).getByRole("link", { name: "View buy cart" }).getAttribute("href");
    check(view.startsWith(`${web}/account/cart?afterWrite=`), "a guest's View buy cart is marketplace's cart");
    const guestRead = async () =>
      await (
        await fetch(`${api}/api/marketplace/guest/cart`, {
          headers: checkout("", { "x-checkout-anonymous-cart-id": guest.value }),
        })
      ).json();
    const guestCart = await eventually(guestRead, (c) => c.items.length > 0);
    if (!guestCart.items.length) console.log(`     (guest ${guest.value}: ${JSON.stringify(guestCart).slice(0, 300)})`);
    check(
      guestCart.items.length === 1 && guestCart.items[0].locked_listing_id === listing.listing_id,
      "the guest cart has the line",
    );
    await page.goto(view);
    check((await page.locator("body").innerText()).includes(read.title), "marketplace's cart shows the guest's line");
    await page.goto(`${base}/items/${slug}?listing=${listing.listing_id}`);
    await listingForm(page).getByRole("button", { name: "Buy this listing" }).click();
    await page.waitForURL(/\/checkout\/buy\/readiness\?/);
    const at = new URL(page.url());
    check(
      at.searchParams.get("source") === "buy-now" && at.searchParams.get("listingId") === listing.listing_id,
      "a guest's Buy this listing is marketplace's guest checkout for the listing",
    );
    check((await page.locator("body").innerText()).includes(read.title), "which shows the item");
    const removed = await fetch(`${api}/api/marketplace/guest/cart/commands`, {
      method: "POST",
      headers: { ...checkout("", { "x-checkout-anonymous-cart-id": guest.value }), "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: randomUUID(),
        commands: guestCart.items.map((l) => ({ type: "remove", lineId: l.line_id })),
      }),
    });
    check(removed.ok, `the guest's line is removed again (${removed.status})`);
    await ctx.close();
  }

  // At 390 px, with the forms: nothing scrolls sideways, every control is at least 40 px.
  for (const address of ["", `?listing=${listing.listing_id}`]) {
    const { ctx, page } = await context({
      javaScriptEnabled: true,
      signedIn: true,
      viewport: { width: 390, height: 844 },
    });
    await page.goto(`${base}/items/${slug}${address}`);
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
    check(!wide, `390 px ${address || "(nothing chosen)"}: nothing scrolls sideways`);
    check(
      small.length === 0,
      `390 px ${address || "(nothing chosen)"}: every buy control is at least 40 px (${small.join(", ")})`,
    );
    await page.screenshot({
      path: `../../artifacts/corten-pilot/item-buy-390${address ? "-listing" : ""}.png`,
      fullPage: true,
    });
    await ctx.close();
  }
} finally {
  // Leave the cart as it was found: remove the lines added, put back any quantity changed.
  const kept = new Map(before.map((l) => [l.line_id, l.quantity]));
  const commands = (await cart()).flatMap((l) =>
    !kept.has(l.line_id)
      ? [{ type: "remove", lineId: l.line_id }]
      : kept.get(l.line_id) !== l.quantity
        ? [{ type: "quantity", lineId: l.line_id, quantity: kept.get(l.line_id) }]
        : [],
  );
  if (commands.length) {
    const res = await fetch(`${api}/api/marketplace/account/cart/commands`, {
      method: "POST",
      headers: { ...checkout(session), "content-type": "application/json" },
      body: JSON.stringify({ attemptId: randomUUID(), commands }),
    });
    check(res.ok, `the cart's added lines are removed again (${commands.length} commands, ${res.status})`);
  }
  const after = await eventually(cart, (lines) => lines.length === before.length);
  check(
    JSON.stringify(after.map((l) => [l.line_id, l.quantity])) ===
      JSON.stringify(before.map((l) => [l.line_id, l.quantity])),
    "the cart is as it was found",
  );
  await browser.close();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
