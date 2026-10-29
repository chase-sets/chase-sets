// Lists the product from the item page's "List this product" form in a browser, against the real
// platform API, as marketplace's seed seller (who has the ship-from setup). It checks:
// - the form lists at the typed price: the post answers 303 to the item with the listing chosen
//   and the write's receipt, and the page shows it as the seller's own, with Manage listing, once
//   Discovery has caught up (the page reads again until then);
// - the same form sent again (its answer lost) is the same listing, not a refusal;
// - how long the API's reads take with the receipt, and what a timeout says was pending, so a slow
//   page after a listing can be told apart from a slow pilot;
// - at 390 px the fold does not scroll sideways and its controls are at least 40 px tall.
// Prices stay below 250.00, where marketplace asks for photo evidence, and every listing the smoke
// creates is withdrawn again.
// Usage: node scripts/smoke-market-item-list.mjs [pilot-url] [seller-state] [api-url] [slug]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7793",
  sellerState = "../../artifacts/corten-pilot/marketplace-state.json",
  api = "http://localhost:7762",
  slug = "charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp",
] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const seller = JSON.parse(readFileSync(sellerState, "utf8"))
  .cookies.filter((c) => c.name === "chase_sets_session")
  .map((c) => `${c.name}=${c.value}`)
  .join("; ");
const marketplace = {
  cookie: seller,
  "content-type": "application/json",
  "chase-sets-read-target-context": "marketplace",
};
const withdraw = async (id) =>
  (
    await fetch(`${api}/api/marketplace/account/listings/${id}/withdraw`, {
      method: "POST",
      headers: marketplace,
      body: "{}",
    })
  ).status;
/** A Discovery read with the receipt: its status, time and, on a timeout, what was pending. */
async function probe(what, receipt) {
  const started = performance.now();
  const res = await fetch(`${api}/api/marketplace/items/${slug}${what}`, {
    headers: {
      cookie: seller,
      "chase-sets-read-target-context": "discovery",
      "chase-sets-read-after-write": encodeURIComponent(receipt),
    },
  });
  const ms = Math.round(performance.now() - started);
  const body = await res.json().catch(() => ({}));
  const pending = (body.error?.pending ?? []).map(
    (p) => `${p.projectionName} ${p.lastGlobalPosition}/${p.requiredGlobalPosition} ${p.state}`,
  );
  return { status: res.status, ms, pending };
}

const price = (200 + Math.floor(Math.random() * 4000) / 100).toFixed(2);
const shown = `$${price}`;
const browser = await chromium.launch();
const created = new Set();
const sellPage = `${base}/items/${slug}?market=sell`;
const rail = (page) => page.locator('[aria-labelledby="rail-title"]');
const fold = (page) =>
  rail(page)
    .locator("details")
    .filter({ hasText: /^\s*List this product/ });

try {
  const ctx = await browser.newContext({ javaScriptEnabled: true, storageState: sellerState });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && page.url().startsWith(base) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on(
    "response",
    (r) => r.url().startsWith(base) && r.status() >= 500 && problems.push(`${r.status()} ${r.url()}`),
  );

  // At 390 px, with the form open.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(sellPage);
  const own = (await fold(page).innerText()).includes("Your active listing is");
  await fold(page).locator("summary").click();
  const { wide, small } = await page.evaluate(() => ({
    wide: document.documentElement.scrollWidth > window.innerWidth,
    small: Array.from(
      document.querySelectorAll(
        '[aria-labelledby="rail-title"] details[open] :is(a, button, input:not([type="hidden"]), select, summary)',
      ),
    )
      .filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 40)
      .map(
        (e) => `${e.tagName} "${e.textContent.trim().slice(0, 20)}" ${Math.round(e.getBoundingClientRect().height)}px`,
      ),
  }));
  check(!wide, "390 px: nothing scrolls sideways");
  check(small.length === 0, `390 px: every control in the open fold is at least 40 px (${small.join(", ")})`);
  await page.screenshot({ path: "../../artifacts/corten-pilot/item-list-390.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(sellPage);
  check(!own, "the seller has no active listing of the product yet");
  if (own) throw new Error("withdraw the seller's listing of the product first");
  await fold(page).locator("summary").click();
  const form = fold(page)
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Create listing" }) });
  check(
    await form.getByRole("button", { name: "Create listing" }).isEnabled(),
    "Create listing is enabled (the seller has the ship-from setup)",
  );
  await form.locator('input[name="price"]').fill(price);
  await form.locator('input[name="quantity"]').fill("1");
  const fields = await form.evaluate((f) => [...new FormData(f)].map(([k, v]) => [k, String(v)]));
  const body = new URLSearchParams(fields).toString();

  // The post, without following it, so the API's reads with its receipt can be timed alone.
  const started = performance.now();
  const post = await ctx.request.post(`${base}/items/${slug}/list`, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    data: body,
    maxRedirects: 0,
  });
  const postMs = Math.round(performance.now() - started);
  const to = post.headers()["location"] ?? "";
  const listing = new URL(to, base).searchParams.get("listing");
  if (listing) created.add(listing);
  check(
    post.status() === 303 && Boolean(listing?.startsWith("lst_")),
    `the post answers 303 with the listing (${post.status()}, ${listing}, ${postMs} ms)`,
  );
  const receipt = new URL(to, base).searchParams.get("after_write") ?? "";
  check(receipt.includes("commitPosition"), "and the write's receipt");

  // The page straight after, as the browser would follow the redirect.
  const loaded = performance.now();
  const res = await page.goto(new URL(to, base).href);
  const pageMs = Math.round(performance.now() - loaded);
  const first = (await fold(page).innerText()).replace(/\s+/g, " ");
  const pending = first.includes("Listing published");
  console.log(
    `     the page after it: ${res.status()} in ${pageMs} ms, ${pending ? "the listing still catching up" : "caught up"}`,
  );
  if (pending) {
    check(
      await fold(page).evaluate((d) => d.open),
      "while it catches up the fold is open and says the listing was published",
    );
    check(!first.includes("Create listing"), "and offers no second listing");
  }
  // The API's reads with the same receipt, now: how long each waits, and what a timeout waited on.
  const [item, overlay] = await Promise.all([probe("", receipt), probe("/seller-overlay", receipt)]);
  console.log(`     the API's item read with the receipt: ${item.status} in ${item.ms} ms ${item.pending.join(", ")}`);
  console.log(
    `     the API's seller overlay with the receipt: ${overlay.status} in ${overlay.ms} ms ${overlay.pending.join(", ")}`,
  );
  let caught = false;
  for (let i = 0; i < 20 && !caught; i += 1) {
    caught = (
      await fold(page)
        .innerText()
        .catch(() => "")
    ).includes(`Your active listing is ${shown}.`);
    if (!caught) await page.waitForTimeout(750);
  }
  check(caught, `the page shows the listing as the seller's own (${shown}), the fold open`);
  check(await fold(page).evaluate((d) => d.open), "the fold is open on it");
  const manage = await fold(page).getByRole("link", { name: "Manage listing" }).getAttribute("href");
  check(Boolean(manage?.endsWith(`/account/listings/${listing}`)), `Manage listing goes to the listing (${manage})`);

  // The same form again, as if its answer were lost: the same listing, already published.
  const again = await ctx.request.post(`${base}/items/${slug}/list`, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    data: body,
    maxRedirects: 0,
  });
  const againListing = new URL(again.headers()["location"] ?? "/", base).searchParams.get("listing");
  check(
    again.status() === 303 && againListing === listing,
    `the same form again is the same listing (${again.status()}, ${againListing})`,
  );

  check(problems.length === 0, `no console errors (${problems.join("; ")})`);
  await ctx.close();
} finally {
  for (const id of created) {
    const status = await withdraw(id);
    check(status === 200, `the listing ${id} is withdrawn again (${status})`);
  }
  await browser.close();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
