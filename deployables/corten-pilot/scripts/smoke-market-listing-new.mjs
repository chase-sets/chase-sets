// Creates listings in a browser, against the real platform API, as the auth seed's demo seller.
// WRITES: each run creates draft listings from the seller's Twilight Masquerade Elite Trainer Box
// inventory at synthetic prices (970-979 USD), then withdraws every draft it created.
// - At 390 px nothing scrolls sideways and every control is at least 40 px tall.
// - With JavaScript: typing in Search catalog finds the item without a page load, and Choose
//   draws it chosen; choosing the inventory and Preview fees draws the fee preview in place; a
//   file that is not a picture is refused with the form kept as typed; Save as draft with a PNG
//   goes to the pilot's listing page with `evidenceEvent=upload_completed`, and the API has
//   the draft with one photo.
// - Without JavaScript: Save as draft from the inventory's address goes to the listing.
// - No console errors.
// Usage: node scripts/smoke-market-listing-new.mjs [pilot-url] [seller-state] [api-url]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  state = "../../artifacts/corten-pilot/marketplace-state.json",
  api = "http://localhost:7762",
] = process.argv.slice(2);
const ITEM = "inv_seed_twilight_masquerade_elite_trainer_box";
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const cookie = JSON.parse(readFileSync(state, "utf8"))
  .cookies.filter((c) => c.name === "chase_sets_session")
  .map((c) => `${c.name}=${c.value}`)
  .join("; ");
const created = [];
/** The listing as the API reads it, once its read has caught up with the create (up to 20 s). */
async function listing(id) {
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`${api}/api/marketplace/account/listings/${id}`, { headers: { cookie } });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1000));
  }
  return {};
}
const idFrom = (url) => new URL(url).pathname.split("/").pop();
const price = (n) => `${970 + n}.00`;

const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 } } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, storageState: state });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  // The refusal this smoke asks for is a 422, which Chrome logs as a failed load; marketplace's
  // listing page, where a create goes, has its own smoke.
  page.on(
    "console",
    (m) =>
      m.type() === "error" &&
      !m.text().includes("status of 422") &&
      page.url().startsWith(base) &&
      problems.push(m.text()),
  );
  page.on("pageerror", (e) => page.url().startsWith(base) && problems.push(String(e)));
  return { ctx, page, problems };
}
const main = (page) => page.evaluate(() => document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "");

// A real picture the API can decode: a screenshot, 900 px square.
const picture = await (async () => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await ctx.newPage();
  await page.setContent(
    '<body style="margin:0;background:linear-gradient(135deg,#4f46e5,#f59e0b)"><h1 style="font:bold 96px sans-serif;color:white;padding:80px">Pilot smoke</h1></body>',
  );
  const png = await page.screenshot({ type: "png" });
  await ctx.close();
  return png;
})();

// The layout on a phone.
{
  const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
  const res = await page.goto(
    `${base}/account/listings/new?inventoryItemId=${ITEM}&priceAmount=${price(0)}&priceCurrencyCode=USD&preview=1`,
  );
  check(res?.status() === 200, `the page answers 200 (${res?.status()})`);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(wide <= 0, `nothing scrolls sideways at 390 px (${wide})`);
  const short = await page.evaluate(() =>
    [...document.querySelectorAll("main input, main select, main button, main summary")]
      .filter(
        (e) => e.offsetParent !== null && e.type !== "hidden" && e.type !== "file" && !e.closest("[aria-hidden=true]"),
      )
      .filter((e) => e.getBoundingClientRect().height < 40)
      .map((e) => e.textContent?.trim() || e.getAttribute("name")),
  );
  check(short.length === 0, `every control is at least 40 px tall (${short.join(", ") || "all"})`);
  check((await main(page)).includes("Listing fee preview"), "the fee preview is drawn on a phone");
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

// With JavaScript.
{
  const { ctx, page, problems } = await context();
  await page.goto(`${base}/account/listings/new`);
  let loads = 0;
  page.on("load", () => (loads += 1));
  await page.getByLabel("Search catalog").pressSequentially("twilight masq", { delay: 30 });
  await page.getByRole("button", { name: "Choose", exact: true }).first().waitFor();
  check(loads === 0, "typing in Search catalog finds items without a page load");
  await page.getByRole("button", { name: "Choose", exact: true }).first().click();
  await page.getByRole("button", { name: "Choose another item" }).waitFor();
  check(loads === 0 && (await main(page)).includes("Twilight Masquerade"), "Choose draws the item chosen, in place");

  await page.getByRole("button", { name: "Choose another item" }).click();
  await page.getByLabel("Search catalog").waitFor();
  await page.goto(`${base}/account/listings/new?inventoryItemId=${ITEM}`);
  loads = 0;
  await page.getByLabel("Price", { exact: true }).fill(price(1));
  await page.getByLabel("Price currency code").fill("USD");
  await page.getByRole("button", { name: "Preview fees" }).click();
  await page.getByText("Listing fee preview").first().waitFor();
  check(loads === 0 && (await main(page)).includes(`$${price(1)}`), "Preview fees draws the preview in place");

  // Not a picture: refused, and nothing created.
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "notes.png", mimeType: "image/png", buffer: Buffer.from("not a picture") });
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.getByText("Each photo must be a JPEG, PNG or WebP image.").waitFor();
  check(
    (await page.getByLabel("Price", { exact: true }).inputValue()) === price(1),
    "a file that is not a picture is refused with the form as typed",
  );
  const input = page.locator("input[type=file]");
  const kept = await input.evaluate((el) => ({
    invalid: el.getAttribute("aria-invalid"),
    files: Array.from(el.files ?? []).map((f) => f.name),
    described: (el.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" "),
  }));
  check(
    kept.invalid === "true" && kept.files.join() === "notes.png" && kept.described.includes("JPEG, PNG or WebP"),
    `the refused photo input is marked invalid, keeps its file and names its message (${JSON.stringify(kept)})`,
  );

  await page.locator("input[type=file]").setInputFiles({ name: "front.png", mimeType: "image/png", buffer: picture });
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.waitForURL(/\/account\/listings\/lst_/, { waitUntil: "commit", timeout: 150_000 });
  const to = page.url();
  created.push(idFrom(to));
  check(
    to.includes("evidenceEvent=upload_completed") && to.includes("afterWrite="),
    `Save as draft goes to the listing (${to})`,
  );
  const read = await listing(created.at(-1));
  const photos = (read.evidence ?? []).filter((p) => p.status === "active").map((p) => p.originalFilename);
  check(
    read.status === "draft" && read.price_amount === price(1),
    `the API has the draft at ${price(1)} (${read.status}, ${read.price_amount})`,
  );
  check(photos.length === 1 && photos[0] === "front.png", `with its one photo (${photos.join(", ")})`);
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

// Without JavaScript.
{
  const { ctx, page, problems } = await context({ javaScriptEnabled: false });
  await page.goto(`${base}/account/listings/new?inventoryItemId=${ITEM}`);
  await page.getByLabel("Price", { exact: true }).fill(price(2));
  await page.getByLabel("Price currency code").fill("USD");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.waitForURL(/\/account\/listings\/lst_/, { waitUntil: "commit" });
  created.push(idFrom(page.url()));
  check(page.url().includes("afterWrite="), `without JavaScript, Save as draft goes to the listing (${page.url()})`);
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

// Withdraw what this run created.
for (const id of created) {
  const res = await fetch(`${api}/api/marketplace/account/listings/${id}/withdraw`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  check(res.ok, `${id} is withdrawn (${res.status})`);
}

await browser.close();
console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
