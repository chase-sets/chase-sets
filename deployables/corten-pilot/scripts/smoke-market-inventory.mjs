// Uses the inventory list pilot in a browser as marketplace's seed seller, with JavaScript and
// without it, against the real platform API: the items as the API lists them, the catalog picker
// (find, choose, the product options), Create inventory item (one unit at the first open location,
// which redirects to marketplace's item page), then Record sale of that unit, so the item it
// created is left with nothing available. Without JavaScript: the picker as GET forms, the sale
// dialog drawn open, and a sale the pilot refuses (nothing is sent). Then the page at 390 px.
// Usage: node scripts/smoke-market-inventory.mjs [pilot-url] [state-file] [api-url]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";
import { randomUUID } from "node:crypto";

const [
  base = "http://localhost:7794",
  stateFile = "../../artifacts/corten-pilot/marketplace-state.json",
  api = "http://localhost:7762",
] = process.argv.slice(2);
const list = `${base}/account/inventory`;
const text = {
  ready: "Inventory changes are ready.",
  choose: "Choose the catalog item from the visible search results.",
};
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

/** After a navigation: Corten swaps the page in after the URL changes. */
async function settled(page) {
  await page.waitForLoadState();
  await page.waitForFunction(() => !(/** @type {any} */ (window).navigation?.transition));
}
const browser = await chromium.launch();

async function context(javaScriptEnabled, viewport) {
  const ctx = await browser.newContext({ storageState: stateFile, javaScriptEnabled, ...(viewport ? { viewport } : {}) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  // The pilot's own pages only: Create inventory item goes on to marketplace's item page.
  const ours = () => page.url().startsWith(base);
  page.on("console", (m) => m.type() === "error" && ours() && problems.push(m.text()));
  page.on("pageerror", (e) => ours() && problems.push(String(e)));
  return { ctx, page, problems };
}

/** The list as the page's data client reads it. */
async function screen(page) {
  const answer = await page.request.get(list, { headers: { accept: "application/json" } });
  return (await answer.json()).data;
}
/** An item as the Inventory API reads it, with the seller's cookies. */
async function item(page, id) {
  const answer = await page.request.get(`${api}/api/inventory/items/${encodeURIComponent(id)}`);
  return answer.ok() ? answer.json() : null;
}

let firstId;
let catalogTitle;
// With JavaScript.
{
  const { ctx, page, problems } = await context(true);
  await page.goto(list);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  check((await page.locator("h1").textContent()) === "Inventory", "the page renders in the shell");
  check((await page.getByText(text.ready).count()) === 1, "nothing to confirm on a fresh page");
  const data = await screen(page);
  const rows = page.locator("table tbody tr");
  check(data.items.items.length > 0, `the API has items (${data.items.total})`);
  check((await rows.count()) === Math.min(data.items.items.length, 100), "a row for each item the API listed");
  check(data.locations.length > 0, `the open storage locations are offered (${data.locations.length})`);
  firstId = data.items.items[0].item_id;
  catalogTitle = data.items.items[0].item_title;
  const catalogId = data.items.items[0].catalog_catalog_item_id;

  // The picker: with a script, typing finds (Find is for a page without one); words find
  // matches, and pasting an id finds that item.
  // Create inventory item's form: the search leaves it once an item is chosen.
  const form = page.locator('form:has(select[name="storageLocationId"])');
  await form.locator('input[name="q"]').fill(catalogTitle);
  await page.getByText(text.choose).waitFor();
  await page.waitForLoadState("networkidle");
  const matches = form.locator('button[name="choose"]');
  check((await matches.count()) > 0, `typing "${catalogTitle}" finds catalog items (${await matches.count()})`);
  // Chosen at once, before typing settles: the search it would have sent must not draw over it.
  await form.locator('input[name="q"]').fill(catalogId);
  await form.locator(`button[name="choose"][value="${catalogId}"]`).click();
  await settled(page);
  await page.locator(`input[name="catalogItemId"][value="${catalogId}"]`).waitFor({ state: "attached" });
  check(true, "choosing a match shows the chosen item");
  // A raw card: the form cannot send a graded card's details (chase-sets/chase-sets#10671), and an
  // item's schema can start on Graded. Then each option still open, one at a time, since a choice
  // can change what the next offers.
  const formOption = form.locator('select[name^="option."]').filter({ has: page.locator("option", { hasText: /^\s*Raw\s*$/ }) });
  if ((await formOption.count()) > 0) {
    const raw = await formOption.first().locator("option", { hasText: /^\s*Raw\s*$/ }).getAttribute("value");
    if ((await formOption.first().inputValue()) !== raw) {
      await formOption.first().selectOption(raw);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    const open = form.locator('select[name^="option."]').filter({ has: page.locator('option[value=""]:checked') });
    if ((await open.count()) === 0) break;
    const select = open.first();
    const value = await select.locator('option:not([value=""])').first().getAttribute("value");
    await select.selectOption(value);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
  }
  check((await form.locator('select[name^="option."] option[value=""]:checked').count()) === 0, "every product option is chosen");
  await form.locator('select[name="storageLocationId"]').selectOption(data.locations[0].storage_location_id);
  await form.locator('input[name="totalQuantity"]').fill("1");
  const create = form.locator('button[type="submit"]:not([name])');
  check(await create.isEnabled(), "Create inventory item is enabled once the item is ready");
  await Promise.all([page.waitForURL(/\/account\/inventory\/items\/[^/?]+/, { waitUntil: "commit" }), create.click()]);
  const to = new URL(page.url());
  const created = decodeURIComponent(to.pathname.split("/").pop());
  check(to.searchParams.has("afterWrite"), `created ${created}, to its page with the write's receipt`);
  // The create answers before Inventory's read model has the item: wait for it (the redirect's
  // receipt is what lets marketplace's item page wait; the smoke reads the API).
  let fresh = null;
  for (let i = 0; i < 40 && !fresh; i += 1) {
    fresh = await item(page, created);
    if (!fresh) await page.waitForTimeout(250);
  }
  check(fresh?.total_quantity === 1 && fresh?.storage_location_id === data.locations[0].storage_location_id, "the API has the item: one unit at the chosen location");

  // Record sale of that unit, from the list: as on marketplace, the dialog is for an item the
  // list shows, and the list's read model takes a moment to have the new one.
  for (let i = 0; i < 40; i += 1) {
    if ((await screen(page)).items.items.some((row) => row.item_id === created)) break;
    await page.waitForTimeout(250);
  }
  await page.goto(`${list}?sale=${encodeURIComponent(created)}`);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const dialog = page.locator("dialog[open]");
  check((await dialog.count()) === 1, "Record sale opens as a dialog over the list");
  await dialog.locator('input[name="quantity"]').fill("1");
  await dialog.locator('select[name="channel"]').selectOption("other");
  await dialog.locator('textarea[name="note"]').fill(`Corten pilot smoke ${randomUUID().slice(0, 8)}`);
  await Promise.all([page.waitForURL(/offlineSaleItemId=/), dialog.locator('button[type="submit"]').click()]);
  await settled(page);
  // The list reads the item again after the sale's receipt. The API can time that read out for
  // ~30 s while other Inventory projections catch up (chase-sets/chase-sets#10672), longer than a
  // receipt is kept (30 s, as marketplace keeps it); then the page says it could not verify the
  // result, as marketplace does. That is right only while the API refuses the read itself, so ask
  // it at once with the same receipt.
  const said = page.locator('[role="status"], [role="alert"]').filter({ hasText: /recorded as sold|could not be verified/ });
  await said.first().waitFor();
  const message = (await said.first().textContent()) ?? "";
  if (message.includes("recorded as sold")) {
    check(message.includes("Completed: 1 units recorded as sold. Authoritative available quantity: 0."), "the list says what the sale did, read again after it");
  } else {
    const receipt = new URL(page.url()).searchParams.get("after_write") ?? "";
    const again = await page.request.get(`${api}/api/inventory/items/${encodeURIComponent(created)}`, {
      headers: { "chase-sets-read-after-write": encodeURIComponent(receipt) },
    });
    const code = again.ok() ? null : (await again.json()).error?.code;
    check(
      receipt !== "" && again.status() === 503 && code === "projection_freshness_timeout",
      `the list says it could not verify the sale while the API times out its receipt (${again.status()} ${code}, chase-sets/chase-sets#10672)`,
    );
  }
  check((await page.locator("dialog[open]").count()) === 0, "the dialog is closed");
  let sold = await item(page, created);
  for (let i = 0; i < 80 && sold?.available_quantity !== 0; i += 1) {
    await page.waitForTimeout(250);
    sold = await item(page, created);
  }
  check(sold?.available_quantity === 0, "the API has nothing available on the item it created");
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

// Without JavaScript.
{
  const { ctx, page, problems } = await context(false);
  await page.goto(list);
  const form = page.locator("form").filter({ has: page.locator('input[name="q"]') });
  await form.locator('input[name="q"]').fill(catalogTitle);
  await form.locator('button[name="redraw"]').click();
  await page.waitForLoadState();
  check(new URL(page.url()).searchParams.get("q") === catalogTitle, "Find is a GET of the page with the words");
  check((await page.locator('button[name="choose"]').count()) > 0, "the matches are drawn without a script");
  await page.goto(`${list}?sale=${encodeURIComponent(firstId)}`);
  check((await page.locator("dialog[open]").count()) === 1, "the sale dialog is drawn open without a script");
  const close = await page.locator("dialog[open] a").first().getAttribute("href");
  check(close?.startsWith("/account/inventory") && !close.includes("sale="), `Close goes back to the list (${close})`);
  const action = await page.locator("dialog[open] form").getAttribute("action");
  const key = await page.locator('dialog[open] input[name="idempotencyKey"]').getAttribute("value");
  const refused = await page.request.post(new URL(action, base).href, {
    form: { idempotencyKey: key ?? randomUUID(), quantity: "0", salePriceAmount: "3.999", channel: "", collisionMode: "protect-orders" },
    maxRedirects: 0,
  });
  const body = await refused.text();
  check(refused.status() === 422, `a sale the pilot refuses is the dialog again (${refused.status()})`);
  check(body.includes("Enter a whole number of 1 or more.") && body.includes("Enter a price like 12.50."), "with what is wrong with each field");
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

// A phone.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(list);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow === 0, `nothing scrolls sideways at 390 px (${overflow})`);
  const display = await page.locator("table tbody tr").first().evaluate((row) => getComputedStyle(row).display);
  check(display !== "table-row", `each item is a card on a phone (${display})`);
  await page.goto(`${list}?sale=${encodeURIComponent(firstId)}`);
  const box = await page.locator("dialog[open]").boundingBox();
  check(box !== null && box.x >= 0 && box.x + box.width <= 390, "the sale dialog fits the screen");
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
