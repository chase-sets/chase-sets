// The seller's listing page in a browser, against the real platform API, as the auth seed's demo
// seller. WRITES: each run creates one draft from the seller's Twilight Masquerade Elite Trainer
// Box inventory at synthetic prices (980-989 USD) through the pilot's Create listing, changes it
// on its page, then withdraws it (through the page's Withdraw, or the API if that failed).
// - Create listing's Save as draft lands on the pilot's listing page, which reads after the write.
// - At 390 px nothing scrolls sideways and every control is at least 40 px tall.
// - With JavaScript: Preview fees draws the preview; Save price, the quantity cap and the
//   purchase limits are written as the API then reads them (a write that changes nothing has no
//   receipt, and goes back to the page without one); Upload evidence adds a photo, Save
//   view gives it a description, Move later reorders two, Replace replaces one and Remove removes
//   one; Withdraw asks in a modal dialog first, then withdraws.
// - Without JavaScript: Save quantity cap writes and comes back to the page.
// - No console errors.
// Usage: node scripts/smoke-market-seller-listing.mjs [pilot-url] [seller-state] [api-url]
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
/** The listing as the API reads it, once `ready` holds (up to 20 s). */
async function listing(id, ready = () => true) {
  let last = {};
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`${api}/api/marketplace/account/listings/${id}`, { headers: { cookie } });
    if (res.ok) {
      last = await res.json();
      if (ready(last)) return last;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}
const active = (l) => (l.evidence ?? []).filter((p) => p.status === "active").sort((a, b) => a.sortOrder - b.sortOrder);
const price = (n) => `${980 + n}.00`;

const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 } } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, storageState: state });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && page.url().startsWith(base) && problems.push(m.text()));
  page.on("pageerror", (e) => page.url().startsWith(base) && problems.push(String(e)));
  return { ctx, page, problems };
}
const main = (page) => page.evaluate(() => document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "");
/** Clicks `button` and waits for the write: the page after it (at its receipt, once its read has
 * caught up; a write that changed nothing has none), or the page drawn again with what was
 * refused (printed, and a failure). */
async function write(page, button) {
  await Promise.all([page.waitForNavigation({ timeout: 150_000 }), button.click()]);
  const refused = page.locator("[data-tone=danger]").first();
  if (await refused.isVisible()) {
    const said = (await refused.innerText()).replace(/\s+/g, " ");
    check(false, `the write was refused: ${said}`);
    return;
  }
  await page
    .getByRole("heading", { level: 1, name: "Preparing listing" })
    .waitFor({ state: "detached", timeout: 60_000 });
  await page.getByRole("heading", { name: "Update Listing" }).waitFor();
}

// A real picture the API can decode: a screenshot, 900 px square, in two colors.
async function picture(color) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await ctx.newPage();
  await page.setContent(
    `<body style="margin:0;background:${color}"><h1 style="font:bold 96px sans-serif;color:white;padding:80px">Pilot smoke</h1></body>`,
  );
  const png = await page.screenshot({ type: "png" });
  await ctx.close();
  return png;
}
const pictures = [await picture("#4f46e5"), await picture("#0f766e"), await picture("#b45309")];

// A draft, through the pilot's Create listing without JavaScript.
let id;
{
  const { ctx, page, problems } = await context({ javaScriptEnabled: false });
  await page.goto(`${base}/account/listings/new?inventoryItemId=${ITEM}`);
  await page.getByLabel("Price", { exact: true }).fill(price(0));
  await page.getByLabel("Price currency code").fill("USD");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.waitForURL(/\/account\/listings\/lst_/, { waitUntil: "commit" });
  const to = new URL(page.url());
  id = to.pathname.split("/").pop();
  check(
    to.origin === base && to.searchParams.has("afterWrite"),
    `Save as draft lands on the pilot's listing page (${to.pathname}${to.search.slice(0, 30)}...)`,
  );
  check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
  await ctx.close();
}

try {
  // The layout on a phone.
  {
    const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
    await listing(id);
    const res = await page.goto(
      `${base}/account/listings/${id}?preview=1&priceAmount=${price(1)}&priceCurrencyCode=USD`,
    );
    check(res?.status() === 200, `the page answers 200 (${res?.status()})`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(wide <= 0, `nothing scrolls sideways at 390 px (${wide})`);
    const short = await page.evaluate(() =>
      [...document.querySelectorAll("main input, main select, main button, main summary, main a")]
        .filter(
          (e) =>
            e.offsetParent !== null && e.type !== "hidden" && e.type !== "file" && !e.closest("dialog:not([open])"),
        )
        .filter((e) => e.getBoundingClientRect().height < 40)
        .map((e) => e.textContent?.trim() || e.getAttribute("name")),
    );
    check(short.length === 0, `every control is at least 40 px tall (${short.join(", ") || "all"})`);
    const text = await main(page);
    check(
      text.includes("Updated fee preview") && text.includes("Draft"),
      "the draft and its fee preview are drawn on a phone",
    );
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // With JavaScript.
  {
    const { ctx, page, problems } = await context();
    await page.goto(`${base}/account/listings/${id}`);
    await page.getByLabel("Price", { exact: true }).fill(price(2));
    await page.getByRole("button", { name: "Preview fees" }).click();
    await page.getByText("Updated fee preview").waitFor();
    check(
      page.url().includes("preview=1") && (await main(page)).includes(`$${price(2)}`),
      "Preview fees draws the preview",
    );

    await write(page, page.getByRole("button", { name: "Save price" }));
    let read = await listing(id, (l) => l.price_amount === price(2));
    check(read.price_amount === price(2), `Save price writes ${price(2)} (${read.price_amount})`);
    check((await main(page)).includes(`$${price(2)}`), "and the page shows it");

    await page.getByLabel("Quantity cap", { exact: true }).fill("2");
    await write(page, page.getByRole("button", { name: "Save quantity cap" }));
    read = await listing(id, (l) => l.quantity_cap === 2);
    check(read.quantity_cap === 2, `Save quantity cap writes 2 (${read.quantity_cap})`);
    check(new URL(page.url()).searchParams.has("afterWrite"), "and the page reads after its receipt");

    await page.locator("summary", { hasText: "Purchase limits control" }).click();
    await page.getByLabel("Limit per order").fill("2");
    await write(page, page.getByRole("button", { name: "Save purchase limits" }));
    read = await listing(id, (l) => l.max_units_per_order === 2);
    check(read.max_units_per_order === 2, `Save purchase limits writes 2 per order (${read.max_units_per_order})`);

    // Photos: add two, describe, reorder, replace and remove.
    for (const [n, png] of pictures.slice(0, 2).entries()) {
      await page
        .getByLabel("Add seller-supplied evidence")
        .setInputFiles({ name: `photo-${n}.png`, mimeType: "image/png", buffer: png });
      await write(page, page.getByRole("button", { name: "Upload evidence" }));
    }
    read = await listing(id, (l) => active(l).length === 2);
    check(active(read).length === 2, `Upload evidence adds two photos (${active(read).length})`);
    check(
      new URL(page.url()).searchParams.get("evidenceEvent") === "upload_completed",
      "with evidenceEvent=upload_completed",
    );

    const [first, second] = active(read).map((p) => p.photoId);
    await page.getByLabel("Image description").first().fill("Pilot smoke front");
    await write(page, page.getByRole("button", { name: "Save view" }).first());
    read = await listing(id, (l) => active(l).some((p) => p.altText === "Pilot smoke front"));
    check(
      active(read).find((p) => p.photoId === first)?.altText === "Pilot smoke front",
      "Save view writes the description",
    );

    await write(page, page.getByRole("button", { name: "Move photo 1 later" }));
    read = await listing(id, (l) => active(l)[0]?.photoId === second);
    check(
      active(read)
        .map((p) => p.photoId)
        .join() === [second, first].join(),
      `Move later reorders the photos (${active(read)
        .map((p) => p.photoId)
        .join()})`,
    );

    await page
      .getByLabel("Replace this image")
      .first()
      .setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: pictures[2] });
    await write(page, page.getByRole("button", { name: "Replace", exact: true }).first());
    read = await listing(id, (l) => !active(l).some((p) => p.photoId === second));
    check(
      active(read).length === 2 && !active(read).some((p) => p.photoId === second),
      "Replace replaces the first photo",
    );

    await write(page, page.getByRole("button", { name: "Remove photo 2" }));
    read = await listing(id, (l) => active(l).length === 1);
    check(active(read).length === 1, `Remove removes one (${active(read).length} left)`);

    // Withdraw asks first, in a modal dialog.
    await page.getByRole("button", { name: "Withdraw listing" }).click();
    const dialog = page.getByRole("dialog", { name: "Withdraw listing" });
    await dialog.waitFor();
    check(await dialog.evaluate((d) => d.matches(":modal")), "Withdraw opens a modal dialog");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    check(true, "Cancel closes it");
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // Without JavaScript.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: false });
    await page.goto(`${base}/account/listings/${id}`);
    await page.getByLabel("Quantity cap", { exact: true }).fill("3");
    await page.getByRole("button", { name: "Save quantity cap" }).click();
    await page.waitForURL(/afterWrite=/, { waitUntil: "commit" });
    const read = await listing(id, (l) => l.quantity_cap === 3);
    check(read.quantity_cap === 3, `without JavaScript, Save quantity cap writes 3 (${read.quantity_cap})`);
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // Withdraw, through the page.
  {
    const { ctx, page, problems } = await context();
    await page.goto(`${base}/account/listings/${id}`);
    await page.getByRole("button", { name: "Withdraw listing" }).click();
    await write(
      page,
      page.getByRole("dialog", { name: "Withdraw listing" }).getByRole("button", { name: "Withdraw listing" }),
    );
    const read = await listing(id, (l) => l.status === "withdrawn");
    check(read.status === "withdrawn", `Withdraw withdraws the listing (${read.status})`);
    check((await main(page)).includes("Withdrawn"), "and the page says so");
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }
} finally {
  const read = await listing(id);
  if (read.status !== "withdrawn") {
    const res = await fetch(`${api}/api/marketplace/account/listings/${id}/withdraw`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    check(res.ok, `${id} is withdrawn through the API (${res.status})`);
  }
  await browser.close();
}
console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
