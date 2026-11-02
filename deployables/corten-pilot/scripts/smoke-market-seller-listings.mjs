// The seller's list of listings in a browser, against the real platform API, as the auth seed's
// demo seller. WRITES, each put back before it ends: the order capacity (set, then back to what it
// was), an away window (scheduled, then cancelled), listings turned off and on again, and the seed
// draft's quantity cap (changed through the API, then back) to see the list redraw live. Bulk
// Pause is tried on withdrawn listings only, which the API refuses one by one, so nothing changes.
// - At 390 px nothing scrolls sideways and every control is at least 40 px tall (a box's label).
// - With JavaScript: the bar shows once a listing is checked, with the count; Set capacity, Remove
//   cap, Schedule away window (its instant is the start of the day where the browser is), Cancel,
//   Turn off listings (with its automatic return) and Turn on listings each come back to the list
//   saying what was set; Pause selected shows each listing's outcome; a change to a listing redraws
//   its row without a reload.
// - Without JavaScript: the filters are a GET form with chips; an away window is scheduled from
//   the start of its day in the zone the account chose in Identity (the browser's is unknown), then
//   cancelled.
// - No console errors.
// Usage: node scripts/smoke-market-seller-listings.mjs [pilot-url] [seller-state] [api-url]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
  state = "../../artifacts/corten-pilot/marketplace-state.json",
  api = "http://localhost:7762",
] = process.argv.slice(2);
const DRAFT = "lst_seed_lugia_neo_genesis_draft";
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const cookie = JSON.parse(readFileSync(state, "utf8"))
  .cookies.filter((c) => c.name === "chase_sets_session")
  .map((c) => `${c.name}=${c.value}`)
  .join("; ");
async function read(path) {
  const res = await fetch(`${api}/api/marketplace/account${path}`, { headers: { cookie } });
  return res.ok ? res.json() : null;
}
async function send(method, path, body) {
  const headers = { cookie, "content-type": "application/json", "chase-sets-read-target-context": "marketplace" };
  const res = await fetch(`${api}/api/marketplace/account${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
}
/** `read(path)` once `ready` holds (up to 20 s). */
async function until(path, ready) {
  let last = null;
  for (let i = 0; i < 20; i += 1) {
    last = await read(path);
    if (last && ready(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}
const day = (days) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The start of `date` (YYYY-MM-DD) in the IANA zone `zone`, in ms since the epoch. */
function startOfDayIn(date, zone) {
  const parts = (at) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(at)
        .map((p) => [p.type, p.value]),
    );
  const offset = (at) => {
    const p = parts(at);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at;
  };
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const guess = midnight - offset(midnight);
  return midnight - offset(guess);
}

const before = { availability: await read("/listing-availability"), capacity: await read("/order-capacity") };
const draftBefore = await read(`/listings/${DRAFT}`);
check(before.availability && before.capacity, "the seller's settings are readable before the run");

const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 }, refusals = false } = options;
  // A zone far from the machine's, so a day read where the server is would not pass for the browser's.
  const ctx = await browser.newContext({
    javaScriptEnabled,
    viewport,
    storageState: state,
    timezoneId: "Pacific/Auckland",
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  // A refusal this smoke asks for is a 422, which Chrome logs as a failed load.
  const expected = (text) => refusals && text.includes("status of 422");
  page.on(
    "console",
    (m) => m.type() === "error" && !expected(m.text()) && page.url().startsWith(base) && problems.push(m.text()),
  );
  page.on("pageerror", (e) => page.url().startsWith(base) && problems.push(String(e)));
  return { ctx, page, problems };
}
const main = (page) => page.evaluate(() => document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "");
async function submit(page, button) {
  await Promise.all([page.waitForNavigation(), button.click()]);
}

try {
  // On a phone.
  {
    const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
    const res = await page.goto(`${base}/account/listings`);
    check(res?.status() === 200, `the page answers 200 (${res?.status()})`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(wide <= 0, `nothing scrolls sideways at 390 px (${wide})`);
    const short = await page.evaluate(() =>
      [...document.querySelectorAll("main input, main select, main button, main summary, main a")]
        .filter((e) => e.offsetParent !== null && e.type !== "hidden")
        .map((e) => (e.type === "checkbox" ? (e.closest("label") ?? e) : e))
        .filter((e) => e.getBoundingClientRect().height < 40)
        .map((e) => e.textContent?.trim() || e.getAttribute("name") || e.tagName),
    );
    check(short.length === 0, `every control is at least 40 px tall (${short.join(", ") || "all"})`);
    const text = await main(page);
    check(
      ["Time away & order capacity", "Listing health", "Current Listings", "Fee Lock Report"].every((w) =>
        text.includes(w),
      ),
      "every part is drawn on a phone",
    );
    const bar = page.locator("form[data-picked] output").first();
    check(
      (await page.locator("form[data-picked='0']").count()) === 1 && !(await bar.isVisible()),
      "the bulk bar waits for a checked listing",
    );
    await page.locator("main input[name=listingIds]").first().check();
    await page.getByText("1 selected").waitFor();
    check(
      await page.getByRole("button", { name: "Pause selected" }).isVisible(),
      "checking one shows the bar with its count",
    );
    await page.getByRole("button", { name: "Clear selection" }).click();
    await page.locator("form[data-picked='0']").waitFor();
    check(true, "Clear selection unchecks them and hides the bar");
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // The settings, with JavaScript.
  {
    const { ctx, page, problems } = await context();
    await page.goto(`${base}/account/listings`);
    await page.getByLabel("Maximum open orders").fill("37");
    await submit(page, page.getByRole("button", { name: "Set capacity" }));
    check(
      page.url().includes("settingsAction=set-order-capacity") &&
        (await main(page)).includes("Current cap: 37 open orders"),
      "Set capacity comes back saying the cap",
    );
    check(
      (await until("/order-capacity", (c) => c.max_open_orders === 37))?.max_open_orders === 37,
      "the API has the cap",
    );
    await submit(page, page.getByRole("button", { name: "Remove cap" }));
    check((await main(page)).includes("No cap set"), "Remove cap comes back with none");

    if (before.availability?.status === "available" && !before.availability.away_window_starts_at) {
      const [starts, ends] = [day(30), day(32)];
      await page.locator("#away-reason").selectOption("travel");
      await page.locator("#away-starts").fill(starts);
      await page.locator("#away-ends").fill(ends);
      await submit(page, page.getByRole("button", { name: "Schedule away window" }));
      const instant = await page.evaluate((d) => new Date(`${d}T00:00:00`).toISOString(), starts);
      check(
        (await main(page)).includes("Scheduled away for Travel"),
        "Schedule away window comes back with the window",
      );
      const window = await until("/listing-availability", (a) => Boolean(a.away_window_starts_at));
      check(
        window && Date.parse(window.away_window_starts_at) === Date.parse(instant),
        `it starts at the start of that day where the browser is, Auckland (${window?.away_window_starts_at} = ${instant})`,
      );
      await submit(page, page.getByRole("button", { name: "Cancel scheduled away window" }));
      check((await main(page)).includes("Book time off in advance."), "Cancel comes back with the form");

      await page.locator("form#disable-form-id select, form [name=reasonCategory]").first().selectOption("audit");
      await page.locator("#available-again-on").fill(day(3));
      await submit(page, page.getByRole("button", { name: "Turn off listings" }));
      const off = await main(page);
      check(
        off.includes("Listings unavailable") && off.includes("Automatic return"),
        "Turn off listings comes back with the automatic return",
      );
      await submit(page, page.getByRole("button", { name: "Turn on listings" }));
      check((await main(page)).includes("Listings available"), "Turn on listings comes back available");
    } else {
      check(true, "skipped the away settings: the seller was away or had a window before the run");
    }

    // Pause selected on withdrawn listings: the API refuses each, so nothing changes.
    await page.goto(`${base}/account/listings?status=withdrawn`);
    const boxes = page.locator("main input[name=listingIds]");
    if ((await boxes.count()) >= 2) {
      await boxes.nth(0).check();
      await boxes.nth(1).check();
      await page.getByText("2 selected").waitFor();
      await submit(page, page.getByRole("button", { name: "Pause selected" }));
      const after = await main(page);
      check(
        after.includes("0 succeeded, 2 failed"),
        `Pause selected shows each listing's outcome (${after.match(/\d+ succeeded, \d+ failed/)?.[0]})`,
      );
      check(page.url().includes("status=withdrawn"), "and keeps the filter");
    }

    // A change to a listing draws its row again without a reload.
    if (draftBefore) {
      await page.goto(`${base}/account/listings?status=draft`);
      await page
        .waitForFunction(() => document.querySelector("corten-live")?.getAttribute("status") === "live", null, {
          timeout: 15_000,
        })
        .catch(() => {});
      const loads = [];
      page.on("load", () => loads.push(1));
      const cap = draftBefore.quantity_cap === 3 ? 4 : 3;
      const changed = await send("POST", `/listings/${DRAFT}/quantity-cap`, {
        quantityCap: cap,
        feeQuoteFingerprint: draftBefore.fee_quote_fingerprint,
      });
      check(changed === 200, `the draft's cap is changed through the API (${changed})`);
      const row = page.locator("li", { has: page.locator(`input[value="${DRAFT}"]`) });
      await row
        .getByText(new RegExp(`Cap\\s*${cap}`))
        .waitFor({ timeout: 20_000 })
        .then(
          () => check(loads.length === 0, "its row is drawn again live, without a reload"),
          () => check(false, "its row is drawn again live, without a reload (it was not)"),
        );
      await send("POST", `/listings/${DRAFT}/quantity-cap`, {
        quantityCap: draftBefore.quantity_cap,
        feeQuoteFingerprint: draftBefore.fee_quote_fingerprint,
      });
    }
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // Without JavaScript.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: false, refusals: true });
    await page.goto(`${base}/account/listings`);
    await page.getByLabel("Status").selectOption("draft");
    await submit(page, page.getByRole("button", { name: "Apply filters" }));
    check(
      page.url().includes("status=draft") && (await main(page)).includes("Status: Draft"),
      "the filters are a GET form with chips",
    );
    if (before.availability?.status === "available" && !before.availability.away_window_starts_at) {
      await page.goto(`${base}/account/listings`);
      await page.locator("#away-reason").selectOption("travel");
      await page.locator("#away-starts").fill(day(30));
      await submit(page, page.getByRole("button", { name: "Schedule away window" }));
      const preferences = await fetch(`${api}/api/identity/preferences`, { headers: { cookie } }).then((r) =>
        r.ok ? r.json() : {},
      );
      const zone = preferences?.timeZone ?? "UTC";
      const scheduled = (await until("/listing-availability", (a) => a.away_window_starts_at != null))
        ?.away_window_starts_at;
      check(
        scheduled != null && new Date(scheduled).valueOf() === startOfDayIn(day(30), zone),
        `without a script the window starts at the day's start in the account's zone, ${zone} (${scheduled})`,
      );
      check(page.url().includes("settingsAction=schedule-away-window"), "and the list says what was set");
      if (scheduled) await send("DELETE", "/listing-availability/away-window");
    }
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }
} finally {
  // Put back what the run changed.
  const now = { availability: await read("/listing-availability"), capacity: await read("/order-capacity") };
  if (before.availability?.status === "available" && now.availability?.status !== "available")
    await send("POST", "/listing-availability/enable", {});
  if (!before.availability?.away_window_starts_at && now.availability?.away_window_starts_at)
    await send("DELETE", "/listing-availability/away-window");
  if (before.capacity?.max_open_orders !== now.capacity?.max_open_orders) {
    if (before.capacity?.max_open_orders == null) await send("DELETE", "/order-capacity");
    else await send("POST", "/order-capacity", { maxOpenOrders: before.capacity.max_open_orders });
  }
  const draftNow = draftBefore && (await read(`/listings/${DRAFT}`));
  if (draftNow && draftNow.quantity_cap !== draftBefore.quantity_cap)
    await send("POST", `/listings/${DRAFT}/quantity-cap`, {
      quantityCap: draftBefore.quantity_cap,
      feeQuoteFingerprint: draftBefore.fee_quote_fingerprint,
    });
  // Each read waits (up to 20 s) for what was put back: a cancel or a cap's removal is projected a moment later.
  const after = {
    availability: await until(
      "/listing-availability",
      (a) =>
        a.status === before.availability?.status &&
        a.away_window_starts_at === before.availability?.away_window_starts_at,
    ),
    capacity: await until("/order-capacity", (c) => c.max_open_orders === before.capacity?.max_open_orders),
  };
  check(
    after.availability?.status === before.availability?.status &&
      after.availability?.away_window_starts_at === before.availability?.away_window_starts_at &&
      after.capacity?.max_open_orders === before.capacity?.max_open_orders,
    "the seller's settings are as they were before the run",
  );
  await browser.close();
}
console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
