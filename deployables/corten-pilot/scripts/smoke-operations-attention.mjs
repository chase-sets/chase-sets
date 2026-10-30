// Uses the Operations Attention queue (/platform/operations-attention) in a browser as a signed-in
// platform admin, with JavaScript and without it, against the real platform API, beside admin-web's
// own page: the same counts, the same items in the same order, each Open answering a page on
// admin-web (admin-web's own links answer 404 until its fix lands), the live
// stream (it ends while the API refuses the topic), and a phone's
// width with no sideways scroll and Open at least 40 px tall. It changes no data.
// Usage: node scripts/smoke-operations-attention.mjs [pilot-url] [admin-web-url] [state-file]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7790",
  adminWeb = "http://localhost:7752",
  stateFile = "../../artifacts/corten-pilot/admin-state.json",
] = process.argv.slice(2);
const PATH = "/platform/operations-attention";
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch();

async function open(url, javaScriptEnabled, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ storageState: stateFile, javaScriptEnabled, viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  const res = await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  return { ctx, page, problems, status: res?.status() };
}

/** The counts and the rows' words, as either page shows them. */
async function read(page) {
  return page.evaluate(() => {
    const stats = [...document.querySelectorAll("main dl dt, main [class*='stat'] [class*='label']")].map((e) =>
      e.textContent.trim().toLowerCase(),
    );
    const values = [...document.querySelectorAll("main dl dd")].map((e) => e.textContent.trim());
    const rows = [...document.querySelectorAll("main table tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent.trim()),
    );
    return { stats, values, rows };
  });
}

// admin-web's page, for what the pilot should match.
const theirs = await open(`${adminWeb}${PATH}`, true);
await theirs.page.waitForSelector("main table tbody tr, main [role='status']");
await theirs.page.waitForTimeout(1_000);
const theirRows = await theirs.page.evaluate(() =>
  [...document.querySelectorAll("main table tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td")].slice(1, 5).map((td) => td.textContent.trim()),
  ),
);
const theirLinks = await theirs.page.evaluate(() =>
  [...document.querySelectorAll("main table tbody tr a")].map((a) => a.getAttribute("href")),
);
await theirs.ctx.close();

for (const javaScriptEnabled of [true, false]) {
  const label = javaScriptEnabled ? "with JavaScript" : "without JavaScript";
  const { ctx, page, problems, status } = await open(`${base}${PATH}`, javaScriptEnabled);
  check(status === 200, `${label}: the page answers 200 (${status})`);
  const mine = await read(page);
  check(mine.values.length === 4, `${label}: four counts (${mine.values.join(", ")})`);
  const rows = mine.rows.map((cells) => cells.slice(1, 5));
  check(
    JSON.stringify(rows) === JSON.stringify(theirRows),
    `${label}: the same ${theirRows.length} rows in the same order as admin-web`,
  );
  if (JSON.stringify(rows) !== JSON.stringify(theirRows)) console.log({ mine: rows, theirs: theirRows });
  check(Number(mine.values[0]) === rows.length, `${label}: the total is the rows' count (${mine.values[0]})`);
  if (javaScriptEnabled) {
    // The stream opens, then ends while the API refuses the topic (or stays live once it does not).
    await page
      .waitForFunction(
        () => ["live", "ended", "closed"].includes(document.querySelector("corten-live")?.getAttribute("status") ?? ""),
        null,
        { timeout: 15_000 },
      )
      .catch(() => {});
    const live = await page.evaluate(() => document.querySelector("corten-live")?.getAttribute("status"));
    check(live === "ended" || live === "live", `the live stream is ${live} (ended while #10607 is open)`);
    check(problems.length === 0, `no console errors (${problems.join("; ")})`);
  }
  const links = await page.evaluate(() => [...document.querySelectorAll("main table tbody tr a")].map((a) => a.href));
  check(links.length === rows.length, `${label}: an Open on each row`);
  for (const href of links.slice(0, 3)) {
    const res = await ctx.request.get(href, { maxRedirects: 0 });
    check(
      res.status() === 200,
      `Open ${new URL(href).pathname}${new URL(href).search} answers ${res.status()} on admin-web`,
    );
  }
  for (const href of theirLinks.slice(0, 1)) {
    const res = await ctx.request.get(new URL(href, adminWeb).href, { maxRedirects: 0 });
    console.log(`note admin-web's own Open ${href} answers ${res.status()} (#10606)`);
  }
  await ctx.close();
}

// A phone.
{
  const { ctx, page } = await open(`${base}${PATH}`, true, { width: 390, height: 844 });
  const layout = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    open: [...document.querySelectorAll("main table tbody tr a")].map((a) => a.getBoundingClientRect().height),
    stats: getComputedStyle(document.querySelector("main dl")).gridTemplateColumns.split(" ").length,
  }));
  check(layout.scroll <= 390, `390 px: no sideways scroll (${layout.scroll})`);
  check(
    layout.open.every((h) => h >= 40),
    `390 px: each Open is at least 40 px tall (${layout.open.join(", ")})`,
  );
  check(layout.stats === 2, `390 px: the counts are two by two (${layout.stats} columns)`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
