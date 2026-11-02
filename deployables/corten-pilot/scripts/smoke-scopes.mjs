// Uses the scopes list in a browser as a signed-in platform admin, with JavaScript and without
// it, against the real platform API, and compares it with admin-web's own scopes page (the same
// session: cookies are the host's, not the port's): the same scopes on the first page, in the same
// order, with the same promotion and sync. Then the domain, status and language filters, a
// scope's View (the pilot's scope page, scripts/smoke-scope.mjs), and a phone's width. It only reads.
// Usage: node scripts/smoke-scopes.mjs [pilot-url] [admin-web-url] [state-file]   (state from scripts/sign-in.mjs)
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7790",
  adminWeb = "http://localhost:7752",
  stateFile = "../../artifacts/corten-pilot/admin-state.json",
] = process.argv.slice(2);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch();
const elsewhere = [];

async function context(javaScriptEnabled, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ storageState: stateFile, javaScriptEnabled, viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  // The pilot's errors count; admin-web's own page's are reported, not counted (its dev server's
  // route discovery logs "Failed to fetch manifest patches" when the smoke moves on mid-fetch).
  const problems = [];
  const theirs = (text) => !page.url().startsWith(base) && (elsewhere.push(text.slice(0, 160)), true);
  page.on("console", (m) => m.type() === "error" && !theirs(m.text()) && problems.push(m.text()));
  page.on("pageerror", (e) => !theirs(String(e)) && problems.push(String(e)));
  return { ctx, page, problems };
}

/** Waits for the page Corten swaps in after a same-origin navigation. */
async function navigated(page) {
  await page.waitForLoadState();
  await page.waitForFunction(() => !(/** @type {any} */ (window).navigation?.transition));
}

/** The scopes table's rows as text cells, without the View column. admin-web draws its attention
 * queue above the list, so the scopes table is the page's last. */
const rows = (page) =>
  page
    .locator("table")
    .last()
    .locator("tbody tr")
    .evaluateAll((trs) =>
      trs.map((tr) =>
        Array.from(tr.querySelectorAll("td"), (td) => (td.textContent ?? "").replace(/\s+/g, " ").trim()).slice(0, 5),
      ),
    );

// With JavaScript, beside admin-web.
{
  const { ctx, page, problems } = await context(true);
  await page.goto(`${adminWeb}/catalog/scopes`, { waitUntil: "networkidle" });
  await page.locator("table").last().locator("tbody tr").first().waitFor();
  const theirs = await rows(page);
  await page.goto(`${base}/catalog/scopes`);
  check((await page.locator("h1").textContent()) === "Scopes", "the list renders");
  const ours = await rows(page);
  check(ours.length > 0, `the API has scopes (${ours.length} on the page)`);
  const same = JSON.stringify(ours) === JSON.stringify(theirs);
  check(same, "the same scopes as admin-web's page, in its order, with its promotion and sync");
  if (!same) {
    for (let i = 0; i < Math.max(ours.length, theirs.length); i += 1) {
      if (JSON.stringify(ours[i]) !== JSON.stringify(theirs[i])) {
        console.log(`  row ${i}: pilot ${JSON.stringify(ours[i])}\n         admin-web ${JSON.stringify(theirs[i])}`);
        break;
      }
    }
  }
  check(
    (await page.locator('nav a[aria-current="page"]').textContent()) === "Scopes",
    "the nav's Scopes is the current page",
  );

  // The domain of the first row, and active.
  const domain = ours[0][1].split(" · ")[0];
  await page.getByLabel("Product domain").selectOption(domain);
  await page.getByLabel("Status").selectOption("active");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.waitForURL(
    (u) => u.searchParams.get("product_domain") === domain && u.searchParams.get("status") === "active",
  );
  await navigated(page);
  const filtered = await rows(page);
  check(
    filtered.every((r) => r[1].startsWith(`${domain} · `) && r[3] === "Live"),
    `the domain and status filters (${filtered.length} active ${domain} scopes, each Live)`,
  );

  // A language edition on the unfiltered page: every row has it.
  await page.goto(`${base}/catalog/scopes`);
  const options = await page
    .getByLabel("Language")
    .locator("option")
    .evaluateAll((os) => os.map((o) => o.getAttribute("value")));
  const language = options.find((v) => v);
  if (language) {
    await page.getByLabel("Language").selectOption(language);
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForURL((u) => u.searchParams.get("language") === language);
    await navigated(page);
    const by = await rows(page);
    check(
      by.length > 0 && by.every((r) => r[2].split(": ")[1]?.split(", ").includes(language)),
      `the language facet (${by.length} with ${language})`,
    );
  } else {
    console.log("skip the language facet: no scope on the page has an edition");
  }

  const view = page.locator("table").last().locator("tbody tr").first().getByRole("link", { name: "View" });
  const href = await view.getAttribute("href");
  check(href?.startsWith("/catalog/scopes/") ?? false, `View opens the pilot's scope page (${href})`);
  const answer = await page.request.get(`${base}${href}`);
  check(answer.ok(), `which answers (${answer.status()})`);
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

// Without JavaScript.
{
  const { ctx, page } = await context(false);
  await page.goto(`${base}/catalog/scopes`);
  check((await page.locator("table").last().locator("tbody tr").count()) > 0, "the list renders without JavaScript");
  await page.getByLabel("Search").fill("zzzz-no-such-scope");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.waitForURL((u) => u.searchParams.get("search") === "zzzz-no-such-scope");
  check((await page.getByText("No scopes found").count()) === 1, "the filter form is a GET; nothing matches");
  await ctx.close();
}

// A phone's width.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  await page.goto(`${base}/catalog/scopes`);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `the page does not scroll sideways at 390 px (${wide} px over)`);
  await page.screenshot({ path: "../../artifacts/corten-pilot/scopes-390.png", fullPage: false });
  check(problems.length === 0, `no script errors at 390 px (${problems.join(" | ")})`);
  await ctx.close();
}

await browser.close();
if (elsewhere.length)
  console.log(
    `note admin-web's own page logged ${elsewhere.length} errors (not counted): ${[...new Set(elsewhere)].slice(0, 3).join(" | ")}`,
  );
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
