// Uses the inventory list and item pilots in a browser as marketplace's seed seller, with
// JavaScript and without it, against the real platform API: the items as the API lists them, the
// catalog picker (find, choose, the product options), Create inventory item (one unit at the first
// open location, which redirects to the pilot's item page and confirms the attempt there). On the
// item page: Adjust Quantity +1, Create Hold and Release it, the ledger filter, and Record sale of
// one unit; then Record sale of the last unit from the list, so the item it created is left with
// nothing available. Without JavaScript: the picker as GET forms, the sale dialog drawn open, a
// sale and an adjustment the pilot refuses (nothing is sent). Then both pages at 390 px.
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
  confirmed: "The original Inventory change is confirmed.",
  unverified: "Inventory item update could not be verified.",
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
  const ctx = await browser.newContext({
    storageState: stateFile,
    javaScriptEnabled,
    ...(viewport ? { viewport } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  // The pilot's own pages only.
  const ours = () => page.url().startsWith(base);
  // A 409 document is the page that says a write could not be verified (the read after its
  // receipt timed out); Chromium logs each as a failed load.
  page.on("console", (m) => {
    if (m.type() !== "error" || !ours()) return;
    if (/status of 409 \(Conflict\)/.test(m.text()) && m.location().url.startsWith(`${base}/account/inventory`)) return;
    problems.push(m.text());
  });
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
/** The item once the API has caught up to `ok` (up to 20 s). */
async function until(page, id, ok) {
  let now = await item(page, id);
  for (let i = 0; i < 80 && !(now && ok(now)); i += 1) {
    await page.waitForTimeout(250);
    now = await item(page, id);
  }
  return now;
}
/**
 * The item page after a write the pilot redirected to: it confirms the attempt and reads the item
 * after the write's receipt. When the API times that read out the
 * page says it could not verify the update; then the smoke asks the API with the same receipt, and
 * checks the page again without it once the API has caught up (`ok`).
 */
async function landed(page, family, id, ok) {
  await settled(page);
  const to = new URL(page.url());
  if (family)
    check(
      to.searchParams.get("family") === family && to.searchParams.has("after_write"),
      `${family} goes back to the item page with its receipt`,
    );
  const body = (await page.locator("main").textContent()) ?? "";
  if (body.includes(text.unverified)) {
    const receipt = to.searchParams.get("after_write") ?? "";
    const again = await page.request.get(`${api}/api/inventory/items/${encodeURIComponent(id)}`, {
      headers: { "chase-sets-read-after-write": encodeURIComponent(receipt) },
    });
    const code = again.ok() ? null : (await again.json()).error?.code;
    // The page's read waited and failed; by the time the smoke asks, the API may have caught up.
    const timedOut = again.status() === 503 && code === "projection_freshness_timeout";
    check(
      timedOut || again.ok(),
      `unverified only after the API timed out the receipt (now ${again.status()} ${code ?? "caught up"}, chase-sets/chase-sets#10672)`,
    );
    await until(page, id, ok);
    to.searchParams.delete("after_write");
    await page.goto(to.href);
    await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  }
  if (family)
    check((await page.getByText(text.confirmed).count()) === 1, `the item page confirms the ${family} attempt`);
  const now = await until(page, id, ok);
  check(now !== null && ok(now), `the API has the ${family ?? "sale"}`);
  return now;
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
  // A raw card, so the run needs no grading company or grade (a graded one's are worked out from
  // its options), and an item's schema can start on Graded. Then each option still open, one at a time, since a choice
  // can change what the next offers.
  const formOption = form
    .locator('select[name^="option."]')
    .filter({ has: page.locator("option", { hasText: /^\s*Raw\s*$/ }) });
  if ((await formOption.count()) > 0) {
    const raw = await formOption
      .first()
      .locator("option", { hasText: /^\s*Raw\s*$/ })
      .getAttribute("value");
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
  check(
    (await form.locator('select[name^="option."] option[value=""]:checked').count()) === 0,
    "every product option is chosen",
  );
  await form.locator('select[name="storageLocationId"]').selectOption(data.locations[0].storage_location_id);
  await form.locator('input[name="totalQuantity"]').fill("1");
  const create = form.locator('button[type="submit"]:not([name])');
  // The options' redraw is in flight for a moment after the last choice; the button waits for it.
  for (let i = 0; i < 20 && !(await create.isEnabled()); i += 1) await page.waitForTimeout(250);
  check(await create.isEnabled(), "Create inventory item is enabled once the item is ready");
  await Promise.all([page.waitForURL(/\/account\/inventory\/items\/[^/?]+/, { waitUntil: "commit" }), create.click()]);
  const created = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  const fresh = await landed(page, "item-create", created, (i) => i.total_quantity === 1);
  check(
    fresh?.storage_location_id === data.locations[0].storage_location_id,
    `created ${created}: one unit at the chosen location`,
  );
  check(((await page.locator("h1").textContent()) ?? "").trim() === catalogTitle, "the item page names the item");
  check(
    base + "/account/inventory/items/" + encodeURIComponent(created) === page.url().split("?")[0],
    "the item page is the pilot's",
  );

  // Adjust Quantity: one more unit found.
  const adjust = page.locator('form[action$="/adjustments"]');
  await adjust.locator('input[name="quantityDelta"]').fill("1");
  await adjust.locator('select[name="reasonCode"]').selectOption("found");
  await adjust.locator('input[name="reason"]').fill("Corten pilot smoke");
  await Promise.all([page.waitForURL(/family=item-adjust/), adjust.locator('button[type="submit"]').click()]);
  await landed(page, "item-adjust", created, (i) => i.total_quantity === 2);
  // Create Hold, then Release it.
  const holdForm = page.locator('form[action$="/holds"]');
  await holdForm.locator('input[name="quantity"]').fill("1");
  await holdForm.locator('input[name="reason"]').fill("Corten pilot smoke hold");
  await Promise.all([page.waitForURL(/family=hold-create/), holdForm.locator('button[type="submit"]').click()]);
  const held = await landed(page, "hold-create", created, (i) => i.held_quantity === 1);
  check(held?.available_quantity === 1, "the hold takes a unit from what is available");
  const release = page.locator('form[action*="/holds/"][action$="/release"]');
  for (let i = 0; i < 40 && (await release.count()) === 0; i += 1) {
    await page.waitForTimeout(250);
    await page.reload();
  }
  check((await release.count()) === 1, "the active manual hold has Release hold");
  await Promise.all([page.waitForURL(/family=hold-release/), release.locator('button[type="submit"]').click()]);
  await landed(page, "hold-release", created, (i) => i.held_quantity === 0);
  // The ledger, filtered to the adjustment.
  const ledger = page.locator('section[aria-labelledby="item-ledger-title"]');
  const filter = ledger.locator('nav a[href*="ledgerKind=adjusted"]');
  for (let i = 0; i < 40 && (await filter.count()) === 0; i += 1) {
    await page.waitForTimeout(250);
    await page.reload();
  }
  await Promise.all([page.waitForURL(/ledgerKind=adjusted/), filter.click()]);
  await settled(page);
  check(
    (await ledger.locator('nav a[aria-current="page"]').textContent())?.trim() === "Adjusted",
    "the filter is selected",
  );
  const steps = await ledger.locator("ol > li > p:first-child").allTextContents();
  check(
    steps.length > 0 && steps.every((s) => s.trim() === "Adjusted"),
    `only adjustments are listed (${steps.length})`,
  );
  // Record sale of one unit from the item page.
  const pageSale = page.locator('form[action$="/sale"]');
  await pageSale.locator('input[name="quantity"]').fill("1");
  await pageSale.locator('select[name="channel"]').selectOption("other");
  await Promise.all([page.waitForURL(/applied=/), pageSale.locator('button[type="submit"]').click()]);
  check(new URL(page.url()).searchParams.get("applied") === "1", "a sale goes back to the item page with what it did");
  await landed(page, null, created, (i) => i.available_quantity === 1 && i.total_quantity === 1);
  const pageSaid = page
    .locator('[role="status"], [role="alert"]')
    .filter({ hasText: /recorded as sold|could not be verified/ });
  await pageSaid.first().waitFor();
  check(
    (await pageSaid.count()) > 0,
    `the item page says what the sale did (${(await pageSaid.first().textContent())?.trim().slice(0, 80)})`,
  );

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
  // ~30 s while other Inventory projections catch up, longer than a
  // receipt is kept (30 s, as marketplace keeps it); then the page says it could not verify the
  // result, as marketplace does. That is right only while the API refuses the read itself, so ask
  // it at once with the same receipt.
  const said = page
    .locator('[role="status"], [role="alert"]')
    .filter({ hasText: /recorded as sold|could not be verified/ });
  await said.first().waitFor();
  const message = (await said.first().textContent()) ?? "";
  if (message.includes("recorded as sold")) {
    check(
      message.includes("Completed: 1 units recorded as sold. Authoritative available quantity: 0."),
      "the list says what the sale did, read again after it",
    );
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
    form: {
      idempotencyKey: key ?? randomUUID(),
      quantity: "0",
      salePriceAmount: "3.999",
      channel: "",
      collisionMode: "protect-orders",
    },
    maxRedirects: 0,
  });
  const body = await refused.text();
  check(refused.status() === 422, `a sale the pilot refuses is the dialog again (${refused.status()})`);
  check(
    body.includes("Enter a whole number of 1 or more.") && body.includes("Enter a price like 12.50."),
    "with what is wrong with each field",
  );
  // The item page: its writes are plain forms, and a refused adjustment is the page again.
  await page.goto(`${base}/account/inventory/items/${encodeURIComponent(firstId)}`);
  check(
    (await page.locator('form[action$="/adjustments"]').count()) === 1,
    "the item page draws Adjust Quantity without a script",
  );
  const attempt = await page
    .locator('form[action$="/adjustments"] input[name="inventoryMutationAttemptId"]')
    .getAttribute("value");
  const adjusted = await page.request.post(
    `${base}/account/inventory/items/${encodeURIComponent(firstId)}/adjustments`,
    {
      form: {
        inventoryMutationAttemptId: attempt || randomUUID(),
        quantityDelta: "0",
        reasonCode: "found",
        reason: "",
      },
      maxRedirects: 0,
    },
  );
  const adjustedBody = await adjusted.text();
  check(adjusted.status() === 422, `an adjustment the pilot refuses is the page again (${adjusted.status()})`);
  check(
    adjustedBody.includes("Enter a whole number other than 0, like -1 or 5.") &&
      adjustedBody.includes("Enter a value."),
    "with what is wrong",
  );
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

// A phone.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(list);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow === 0, `nothing scrolls sideways at 390 px (${overflow})`);
  const display = await page
    .locator("table tbody tr")
    .first()
    .evaluate((row) => getComputedStyle(row).display);
  check(display !== "table-row", `each item is a card on a phone (${display})`);
  await page.goto(`${list}?sale=${encodeURIComponent(firstId)}`);
  const box = await page.locator("dialog[open]").boundingBox();
  check(box !== null && box.x >= 0 && box.x + box.width <= 390, "the sale dialog fits the screen");
  await page.goto(`${base}/account/inventory/items/${encodeURIComponent(firstId)}`);
  await page.waitForFunction(() => /** @type {any} */ (window).__hydratedAt > 0);
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(sideways === 0, `the item page does not scroll sideways at 390 px (${sideways})`);
  const summary = await page.locator('section[aria-labelledby="item-summary-title"]').boundingBox();
  const writes = await page.locator('section[aria-labelledby="item-adjust-title"]').boundingBox();
  check(
    summary !== null && writes !== null && writes.y > summary.y && Math.abs(writes.x - summary.x) < 2,
    "the writes stack under the item on a phone",
  );
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
