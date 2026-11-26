// Packs a shipment in a browser, against the real platform API, as the auth seed's seller.
// - Read-only packing slips: one copy of each sheet, local format and canonical URL, CSS paper size
//   in the printed PDF for both formats, and the server-rendered GET fallback.
// - Read, on a shipment awaiting its package: the shipment's page offers Start packing as
//   marketplace's does, and the packing page says Ready to start; at 390 px nothing scrolls
//   sideways and every control is at least 40 px tall.
// - The rest WRITES and cannot be undone, using up the sandbox's shipments that await their
//   package. Start packing, with JavaScript, applies; checking the line, unchecking it and
//   scanning its title change the line, the progress and Finish in place with no navigation;
//   Finish records one package and loads the shipment's page. Without JavaScript, on another
//   shipment, the same as pages. At 390 px Finish stays on screen. No console errors.
// Usage: node scripts/smoke-market-packing.mjs [pilot-url] [marketplace-url] [seller-state] [api-url] [--slips-only]
// To use a read-only fixture instead of the API's shipment list, pass --slips-only --shipment-ids=id1,id2.
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const slipsOnly = args.includes("--slips-only");
const fixedIds = args.find((arg) => arg.startsWith("--shipment-ids="))?.slice("--shipment-ids=".length);
if (fixedIds !== undefined && !slipsOnly) throw new Error("--shipment-ids requires --slips-only");
const [
  base = "http://localhost:7794",
  market = "http://localhost:7753",
  state = "../../artifacts/corten-pilot/marketplace-state.json",
  api = "http://localhost:7762",
] = args.filter((arg) => arg !== "--slips-only" && !arg.startsWith("--shipment-ids="));
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const cookie = JSON.parse(readFileSync(state, "utf8"))
  .cookies.filter((c) => c.name === "chase_sets_session")
  .map((c) => `${c.name}=${c.value}`)
  .join("; ");
const shipments = `${api}/api/marketplace/account/sales/shipments`;
const read = async (path) => {
  const res = await fetch(`${shipments}${path}`, { headers: { cookie } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};

const list =
  fixedIds === undefined
    ? (await read("?limit=100&offset=0")).items
    : fixedIds
        .split(",")
        .filter(Boolean)
        .map((shipment_id) => ({ shipment_id }));
const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 } } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, storageState: state });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  // The pilot's errors only: marketplace's dev server has its own (504 Outdated Optimize Dep).
  page.on("console", (m) => m.type() === "error" && !m.location().url.startsWith(market) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}
const main = (page) => page.evaluate(() => document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "");
const progress = (page) =>
  page
    .locator("#packing-progress")
    .innerText()
    .then((t) => t.replace(/\s+/g, " ").trim());
const finish = (page) => page.getByRole("button", { name: "Finish packing" });

async function checkSlips() {
  const ids = list.slice(0, 2).map((shipment) => shipment.shipment_id);
  check(ids.length > 0, "the sandbox has a shipment to print");
  if (!ids.length) return;
  const path = "/account/sales/shipments/packing-slips";
  const initial = new URLSearchParams({ shipmentIds: ids.join(", "), format: "letter" });
  initial.append("shipmentIds", ids[0]);
  const initialUrl = `${base}${path}?${initial}`;
  const paper = (page) => page.getByRole("combobox", { name: "Format" });
  const sheets = (page) => page.locator("[data-packing-slip-page]");
  const isFormat = (url, format) =>
    url.pathname === path &&
    url.searchParams.get("format") === format &&
    JSON.stringify(url.searchParams.getAll("shipmentIds")) === JSON.stringify(ids);

  const { ctx, page, problems } = await context();
  const requests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === path) requests.push(request);
  });
  await page.goto(initialUrl);
  await page.getByRole("button", { name: "Print", exact: true }).waitFor();
  check((await sheets(page).count()) === ids.length, "the document draws each requested shipment once");
  const firstSheet = await sheets(page).first().elementHandle();
  const historyLength = await page.evaluate(() => history.length);
  const printSize = async (width, height, name) => {
    // Chromium serializes the page boundaries in PDF points (72 per inch).
    const pdf = await page.pdf({ preferCSSPageSize: true });
    const boxes = [...pdf.toString("latin1").matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)];
    check(
      boxes.length === ids.length &&
        boxes.every(([, w, h]) => Math.abs(Number(w) - width) < 1 && Math.abs(Number(h) - height) < 1),
      `${name} PDF has ${ids.length} ${width} × ${height} pt sheets (got ${boxes.map(([, w, h]) => `${w} × ${h}`).join(", ")})`,
    );
  };
  await printSize(612, 792, "Letter");
  await paper(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForURL((url) => isFormat(url, "thermal-4x6"));
  await page.locator('[data-format="thermal-4x6"]').waitFor();
  check(
    await paper(page).evaluate((control) => document.activeElement === control),
    "keyboard format change keeps focus",
  );
  check(
    await firstSheet?.evaluate((sheet) => sheet === document.querySelector("[data-packing-slip-page]")),
    "changing paper does not replace or duplicate the shipment markup",
  );
  await printSize(288, 432, "Thermal");
  await paper(page).selectOption("letter");
  await page.waitForURL((url) => isFormat(url, "letter"));
  await page.locator('[data-format="letter"]').waitFor();
  await printSize(612, 792, "Switched-back letter");
  check(requests.length === 1, "both local switches make no additional packing-slip request");
  check((await page.evaluate(() => history.length)) === historyLength, "local switches do not add history entries");
  check(problems.length === 0, `no packing-slip console errors ${problems.join(" | ")}`);
  await ctx.close();

  const fallback = await context({ javaScriptEnabled: false });
  await fallback.page.goto(initialUrl);
  await paper(fallback.page).selectOption("thermal-4x6");
  check(
    !isFormat(new URL(fallback.page.url()), "thermal-4x6"),
    "without JavaScript, selecting paper does not navigate",
  );
  await fallback.page.getByRole("button", { name: "Change format" }).click();
  await fallback.page.waitForURL((url) => isFormat(url, "thermal-4x6"));
  await fallback.page.locator('[data-format="thermal-4x6"]').waitFor();
  check((await sheets(fallback.page).count()) === ids.length, "the no-JavaScript GET draws the thermal slips");
  await fallback.ctx.close();
}

await checkSlips();
const open = list.filter((s) => s.status === "packing").concat(list.filter((s) => s.status === "awaiting-package"));
if (!slipsOnly)
  console.log(`shipments to pack: ${open.map((s) => `${s.shipment_id} (${s.status})`).join(", ") || "none"}`);
if (slipsOnly || open.length === 0) {
  if (!slipsOnly) console.log("SKIP the sandbox has no shipment awaiting its package; reseed to run the writes");
  await browser.close();
  console.log(failures === 0 ? "all passed" : `${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Start packing from the shipment's page (or resume it, as the API says it stands), and wait
 * for the packing page: packing, or saying it could not confirm the start. */
async function begin(page, shipment) {
  const { status } = await read(`/${shipment.shipment_id}`);
  await page.goto(`${base}/account/sales/shipments/${shipment.shipment_id}`);
  if (status === "awaiting-package") {
    await page.getByRole("button", { name: "Start packing" }).click();
  } else {
    await page.getByRole("link", { name: "Resume packing" }).click();
  }
  await page.waitForURL(/\/packing/);
  await page
    .getByText("Order changes locked while packing")
    .or(page.getByText("We could not confirm your last packing change"))
    .waitFor();
}

// Read only: Start packing as marketplace offers it, Ready to start, and the layout on a phone.
{
  const shipment = open.find((s) => s.status === "awaiting-package") ?? open[0];
  const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
  await page.goto(`${market}/account/sales/shipments/${shipment.shipment_id}`, { timeout: 120_000 });
  const theirs =
    (await page.getByRole("button", { name: "Start packing" }).count()) +
    (await page.getByRole("link", { name: "Resume packing" }).count());
  await page.goto(`${base}/account/sales/shipments/${shipment.shipment_id}`);
  const ours =
    (await page.getByRole("button", { name: "Start packing" }).count()) +
    (await page.getByRole("link", { name: "Resume packing" }).count());
  check(ours === 1 && ours === theirs, `the shipment's page offers Start or Resume packing (marketplace: ${theirs})`);
  await page.goto(`${base}/account/sales/shipments/${shipment.shipment_id}/packing`);
  const text = await main(page);
  check(/Ready to start|Order changes locked while packing/.test(text), "the packing page says where packing stands");
  const layout = await page.evaluate(() => {
    const small = [...document.querySelectorAll("main button, main a, main input:not([type=hidden])")]
      .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height < 40)
      .map((el) => el.outerHTML.slice(0, 80));
    return { wide: document.documentElement.scrollWidth > innerWidth, small };
  });
  check(!layout.wide, "at 390 px nothing scrolls sideways");
  check(layout.small.length === 0, `every control is at least 40 px tall ${layout.small.join(" | ")}`);
  check(problems.length === 0, `no console errors ${problems.join(" | ")}`);
  await ctx.close();
}

// With JavaScript: Start packing applies, then the whole flow, in place.
{
  const shipment = open.shift();
  const { ctx, page, problems } = await context();
  await begin(page, shipment);
  const detail = await read(`/${shipment.shipment_id}`);
  check(
    detail.status === "packing",
    `Start packing applies: the API says ${shipment.shipment_id} is packing (${detail.status})`,
  );
  const ours = await main(page);
  // Marketplace's packing page for the same shipment, in the same state.
  const theirs = await (async () => {
    const other = await ctx.newPage();
    await other.goto(`${market}/account/sales/shipments/${shipment.shipment_id}/packing`, { timeout: 120_000 });
    await other.getByText("Order changes locked while packing").waitFor({ timeout: 120_000 });
    const text = await main(other);
    await other.close();
    return text;
  })();
  for (const pattern of [
    /Pack shipment/,
    /Order [A-Z0-9-]+ for [^.]+\./,
    /Order changes locked while packing/,
    /\d+ of \d+ items packed/,
  ]) {
    const a = ours.match(pattern)?.[0];
    const b = theirs.match(pattern)?.[0];
    check(a !== undefined && a === b, `says "${a}" as marketplace does ("${b}")`);
  }
  check(
    await page.evaluate(
      () => Object.keys(sessionStorage).filter((k) => k.startsWith("shipment-mutation/")).length === 0,
    ),
    "the browser keeps no record of the settled start",
  );

  const navigations = [];
  page.on("framenavigated", (frame) => frame === page.mainFrame() && navigations.push(frame.url()));
  const line = page.locator("li[data-checked]").first();
  const title = (await line.locator("p").first().innerText()).trim();
  const checked = (value) =>
    page.waitForFunction((v) => document.querySelector("li[data-checked]")?.dataset.checked === v, String(value));
  const box = () => page.locator("li[data-checked]").first().getByRole("checkbox");
  if ((await box().getAttribute("aria-checked")) === "true") {
    await box().click();
    await checked(false);
  }
  await box().click();
  await checked(true);
  check((await progress(page)).startsWith("1 of 1 items packed"), `checking the line: ${await progress(page)}`);
  check(await page.locator("li[data-checked]").first().getByText("Saved").isVisible(), "the line says Saved");
  check(await finish(page).isEnabled(), "Finish is on once every line is packed");
  await box().click();
  await checked(false);
  check(!(await finish(page).isEnabled()), `unchecking it turns Finish off: ${await progress(page)}`);
  await page.getByRole("searchbox").fill(title);
  await page.getByRole("button", { name: "Confirm" }).click();
  await page.getByText(`Added one packed item for ${title}.`).waitFor();
  await checked(true);
  check(await finish(page).isEnabled(), `scanning "${title}" packs it and turns Finish on`);
  check(navigations.length === 0, `all in place, no navigation (${navigations.length})`);
  const after = await read(`/${shipment.shipment_id}`);
  check(
    after.lines[0].packing_confirmed_quantity === 1,
    `the API has the line packed (${after.lines[0].packing_confirmed_quantity})`,
  );
  await finish(page).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/packing"));
  const done = await read(`/${shipment.shipment_id}`);
  check(
    done.status === "awaiting-label" && done.package_count === 1,
    `Finish packs it: ${done.status}, ${done.package_count} package`,
  );
  check(
    new URL(page.url()).pathname === `/account/sales/shipments/${shipment.shipment_id}`,
    `and loads the shipment's page: ${page.url()}`,
  );
  check(problems.length === 0, `no console errors ${problems.join(" | ")}`);
  await ctx.close();
}

// Without JavaScript, on another shipment, and the layout at 390 px.
if (open.length === 0) {
  console.log("SKIP without JavaScript: no second shipment to pack");
} else {
  const shipment = open.shift();
  const { ctx, page } = await context({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  await begin(page, shipment);
  check(
    (await read(`/${shipment.shipment_id}`)).status === "packing",
    "without a script, Start packing is a post and the page",
  );
  // The layout, while it is packing.
  const layout = await page.evaluate(() => {
    const small = [...document.querySelectorAll("main button:not([hidden]), main a, main input:not([type=hidden])")]
      .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height < 40)
      .map((el) => el.outerHTML.slice(0, 80));
    return { wide: document.documentElement.scrollWidth > innerWidth, small };
  });
  check(!layout.wide, "at 390 px nothing scrolls sideways");
  check(layout.small.length === 0, `every control is at least 40 px tall ${layout.small.join(" | ")}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  const footer = await page.locator("#packing-footer").boundingBox();
  check(
    footer !== null && footer.y + footer.height <= 844 + 1,
    `Finish stays on screen at the top of the page (${footer?.y})`,
  );

  const box = page.locator("li[data-checked]").first().getByRole("checkbox");
  if ((await box.getAttribute("aria-checked")) !== "true") {
    await box.click();
    await page.waitForLoadState();
  }
  check(
    new URL(page.url()).hash.startsWith("#packing-line-"),
    `checking the line loads the page at the line: ${new URL(page.url()).hash}`,
  );
  check(
    (await read(`/${shipment.shipment_id}`)).lines.every((l) => l.packing_confirmed_quantity === l.quantity),
    "the API has every line packed",
  );
  if (await finish(page).isEnabled()) {
    await finish(page).click();
    await page.waitForLoadState();
    const done = await read(`/${shipment.shipment_id}`);
    check(done.status === "awaiting-label", `without a script, Finish packs it: ${done.status}`);
    check((await main(page)).includes("Shipment"), "and loads the shipment's page");
  } else {
    check(false, "Finish is on once every line is packed");
  }
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "all passed" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
