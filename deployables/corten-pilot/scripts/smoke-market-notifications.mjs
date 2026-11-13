// Uses the notification center in a browser, against the real platform API, beside marketplace's.
// - Without JavaScript, as the auth seed's collector: the feed's heading, unread count and first
//   notification as marketplace shows them; Settings lists the channels the page has words for
//   (marketplace also shows bare "sms" and "rcs") and the alerts.
// - A channel's switch, with and without JavaScript: Email notifications off then on again, each
//   time the API agreeing (two writes that leave it as it was).
// - An alert made through the API for the smoke: Pause, Resume and Delete with JavaScript, each
//   drawn in place with no navigation: while the list's read catches up the section says so and
//   is read again from the settings' address with the write's receipt (`ReadAgain::from`), the
//   list read after each write (it deletes the alert).
// - Mark read, with JavaScript, on the oldest unread notification when there is one (one write a
//   run, which marks it read for good).
// - At 1280 and 390 px nothing scrolls sideways, every control is at least 40 px tall, and no
//   console errors.
// Usage: node scripts/smoke-market-notifications.mjs [pilot-url] [marketplace-url] [collector-state] [api-url]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7793",
  market = "http://localhost:7753",
  state = "../../artifacts/corten-pilot/collector-state.json",
  api = "http://localhost:7762",
] = process.argv.slice(2);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const cookie = JSON.parse(readFileSync(state, "utf8"))
  .cookies.filter((c) => c.name === "chase_sets_session")
  .map((c) => `${c.name}=${c.value}`)
  .join("; ");
const alertsApi = `${api}/api/marketplace/account/product-alerts`;
const writes = { cookie, "content-type": "application/json", origin: market };
const preference = async (key) =>
  (await (await fetch(`${api}/api/notifications/preferences`, { headers: { cookie } })).json()).items.find(
    (p) => p.key === key,
  )?.enabled;

const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 } } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, storageState: state });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}
const main = (page) => page.evaluate(() => document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "");

// No script, beside marketplace.
{
  const { ctx, page } = await context({ javaScriptEnabled: false });
  await page.goto(`${market}/account/notifications`, { timeout: 120_000 });
  const theirs = await main(page);
  await page.goto(`${base}/account/notifications`);
  const ours = await main(page);
  const unread = (text) => text.match(/(\d+) unread/)?.[1];
  check(
    unread(ours) !== undefined && unread(ours) === unread(theirs),
    `the unread count: ${unread(ours)} (marketplace ${unread(theirs)})`,
  );
  const first = await page.locator("#feed article").first().locator("p").first().innerText();
  check(theirs.includes(first), `the first notification is marketplace's too: ${first}`);
  for (const words of ["Notifications", "Recent updates", "Mark all read"]) {
    check(
      ours.includes(words) === theirs.includes(words),
      `${words}: ${ours.includes(words)} (marketplace ${theirs.includes(words)})`,
    );
  }
  await page.getByRole("link", { name: /Settings/ }).click();
  const settings = await main(page);
  check(
    settings.includes("Delivery settings") && settings.includes("Product alerts"),
    "Settings is a link to the delivery settings and the alerts",
  );
  check(
    (await page.getByRole("switch").count()) === 3 && !/\bsms\b|\brcs\b/.test(settings),
    `three channels, no bare sms or rcs (${await page.getByRole("switch").count()})`,
  );
  // The switch without a script: a post, then the settings again.
  const was = await preference("email");
  await page.getByRole("switch", { name: "Email notifications" }).click();
  await page.waitForLoadState();
  check((await preference("email")) === !was, `without a script, the switch turns email ${was ? "off" : "on"}`);
  check(
    (await page.getByRole("switch", { name: "Email notifications" }).getAttribute("aria-checked")) === String(!was),
    "and the page says so",
  );
  await page.getByRole("switch", { name: "Email notifications" }).click();
  await page.waitForLoadState();
  check((await preference("email")) === was, "and back again");
  await ctx.close();
}

// With a script: the switch, an alert's Pause, Resume and Delete, and Mark read, each in place.
let made = null;
try {
  const { ctx, page, problems } = await context();
  await page.goto(`${base}/account/notifications?view=settings`);
  await page.waitForFunction(() => window.__hydratedAt);
  const navigations = [];
  page.on("framenavigated", (f) => f === page.mainFrame() && navigations.push(f.url()));
  // The section's reads again: GETs of the settings with a receipt, as a patch.
  let readsAgain = 0;
  page.on(
    "request",
    (r) =>
      r.method() === "GET" &&
      r.url().includes("afterWrite=") &&
      r.headers()["corten"] === "action" &&
      (readsAgain += 1),
  );
  const email = page.getByRole("switch", { name: "Email notifications" });
  const was = (await email.getAttribute("aria-checked")) === "true";
  await email.click();
  await page.waitForFunction(
    (v) => document.querySelector("#preference-email [role=switch]")?.getAttribute("aria-checked") === v,
    String(!was),
  );
  check((await preference("email")) === !was, "with a script, the switch turns email the other way, drawn in place");
  await page.getByRole("switch", { name: "Email notifications" }).click();
  await page.waitForFunction(
    (v) => document.querySelector("#preference-email [role=switch]")?.getAttribute("aria-checked") === v,
    String(was),
  );
  check((await preference("email")) === was, "and back again");
  check(
    (await page.evaluate(() => document.activeElement?.getAttribute("role"))) === "switch",
    "focus stays on the switch",
  );

  // An alert for the smoke, through the API.
  const item = await (
    await fetch(`${api}/api/marketplace/items/charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp`, {
      headers: { "chase-sets-read-target-context": "discovery" },
    })
  ).json();
  const created = await fetch(alertsApi, {
    method: "POST",
    headers: writes,
    body: JSON.stringify({
      marketSide: "listing",
      catalogItemId: item.catalog_item_id,
      productId: `${item.catalog_item_id}::smoke`,
      selectedOptions: [],
      productSummary: "Corten pilot smoke alert",
      thresholdAmount: "12.34",
      thresholdCurrencyCode: "USD",
    }),
  });
  made = (await created.json()).id;
  check(created.status === 201 && Boolean(made), `an alert for the smoke (${created.status} ${made})`);
  await page.goto(`${base}/account/notifications?view=settings&section=product-alerts#product-alerts`);
  await page.waitForFunction(() => window.__hydratedAt);
  const card = () => page.locator("#product-alerts article", { hasText: "Corten pilot smoke alert" });
  for (let i = 0; i < 20 && (await card().count()) === 0; i++) {
    await page.waitForTimeout(500);
    await page.reload();
  }
  check((await card().innerText()).includes("Listings - at or below $12.34"), "the alert is listed with its threshold");
  const before = navigations.length;
  for (const [button, status] of [
    ["Pause", "paused"],
    ["Resume", "active"],
  ]) {
    await card().getByRole("button", { name: button }).click();
    await page.waitForFunction(
      (s) =>
        [...document.querySelectorAll("#product-alerts article")].some(
          (a) => a.textContent.includes("Corten pilot smoke alert") && a.textContent.includes(s),
        ),
      status,
    );
    check(true, `${button} draws the alert ${status} in place`);
  }
  await card().getByRole("button", { name: "Delete" }).click();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("#product-alerts article")].some((a) =>
        a.textContent.includes("Corten pilot smoke alert"),
      ),
  );
  check(true, "Delete takes it out of the list in place");
  made = null;
  // A write whose read has not caught up is read again in place, so no write navigates.
  const moved = navigations.slice(before);
  check(moved.length === 0, `the alert's three writes stay on the page (${moved.join(", ") || "no navigation"})`);
  console.log(`note the section was read again ${readsAgain} times while the writes' reads caught up`);

  // Mark read, on the oldest unread notification.
  await page.goto(`${base}/account/notifications`);
  await page.waitForFunction(() => window.__hydratedAt);
  const unread = page.locator("#feed article", { has: page.getByRole("button", { name: "Mark read" }) });
  const count = async () => Number((await page.locator("#feed").innerText()).match(/(\d+) unread/)?.[1]);
  if ((await unread.count()) > 0) {
    const was = await count();
    await unread.last().getByRole("button", { name: "Mark read" }).click();
    await page.waitForFunction(
      (n) => Number(document.querySelector("#feed")?.textContent.match(/(\d+) unread/)?.[1]) === n - 1,
      was,
    );
    check(true, `Mark read draws the feed again in place: ${was} then ${was - 1} unread`);
  } else {
    console.log("note no unread notification left to mark read");
  }
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
} finally {
  if (made) {
    const status = (await fetch(`${alertsApi}/${made}/delete`, { method: "POST", headers: writes, body: "{}" })).status;
    check(status === 200, `the smoke's alert is deleted again (${status})`);
  }
}

// Layout.
for (const [width, height] of [
  [1280, 900],
  [390, 844],
]) {
  for (const path of ["/account/notifications", "/account/notifications?view=settings"]) {
    const { ctx, page, problems } = await context({ viewport: { width, height } });
    await page.goto(`${base}${path}`);
    await page.waitForFunction(() => window.__hydratedAt);
    const layout = await page.evaluate(() => {
      const small = [];
      for (const el of document.querySelectorAll("main a, main button")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height < 40)
          small.push(`${el.tagName} ${el.textContent.trim().slice(0, 24)} ${Math.round(r.height)}`);
      }
      return { overflow: document.documentElement.scrollWidth - window.innerWidth, small };
    });
    check(layout.overflow <= 0, `${path} at ${width} px: nothing scrolls sideways (${layout.overflow})`);
    check(
      layout.small.length === 0,
      `${path} at ${width} px: every control is at least 40 px tall${layout.small.length ? `: ${layout.small.join(", ")}` : ""}`,
    );
    check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
    await page.screenshot({
      path: `${process.env.TEMP}/pilot-notifications-${path.includes("settings") ? "settings" : "feed"}-${width}.png`,
      fullPage: true,
    });
    await ctx.close();
  }
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
