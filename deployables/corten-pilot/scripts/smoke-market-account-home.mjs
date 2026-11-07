// The collector's account page (`/account`) in a browser, against the real platform API, as the auth
// seed's collector. WRITES: each run changes the collector's marketplace name to a synthetic one
// ("Collector Zero <stamp>") and back to what it was; the end restores it through the API whatever
// happened.
// - Read: the page shows what Identity has (the marketplace name, the legal name, the type, the
//   status) and who is signed in (the role, the email); the account screens it links are the
//   pilot's; at 390 px nothing scrolls sideways and every control is at least 44 px tall.
// - With JavaScript: Update Profile, then the page says it was saved and shows the new name (read
//   after the write); a name of spaces is not sent (the input's pattern, the pilot's
//   workaround).
// - Without JavaScript: Update Profile puts the name back.
// - A visitor is sent to the pilot's sign-in, back to /account.
// - No console errors.
// Usage: node scripts/smoke-market-account-home.mjs [pilot-url] [collector-state] [api-url]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7794",
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
const session = await (await fetch(`${api}/api/auth/session`, { headers: { cookie } })).json();
const accountUrl = `${api}/api/identity/accounts/${session.actor.accountId}`;
const read = async () => (await fetch(accountUrl, { headers: { cookie } })).json();
const original = await read();
const display = await (await fetch(`${api}/api/identity/current-actor-display`, { headers: { cookie } })).json();
const synthetic = `${original.display_name} ${Date.now().toString(36)}`;

const browser = await chromium.launch();
async function context(options = {}) {
  const { javaScriptEnabled = true, viewport = { width: 1280, height: 900 }, signedIn = true } = options;
  const ctx = await browser.newContext({ javaScriptEnabled, viewport, ...(signedIn ? { storageState: state } : {}) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}
const main = (page) => page.evaluate(() => document.querySelector("main")?.innerText.replace(/\s+/g, " ") ?? "");
const heading = (page) =>
  page.evaluate(() => document.querySelector("main h1")?.innerText.replace(/\s+/g, " ").trim() ?? "");
/** Whether the page's heading comes to start with `name`, as the page reads itself again. */
async function shows(page, name) {
  for (let i = 0; i < 30; i += 1) {
    if ((await heading(page).catch(() => "")).startsWith(name)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}
/** Whether Identity's account comes to have `name` as its marketplace name. */
async function settled(name) {
  for (let i = 0; i < 30; i += 1) {
    if ((await read()).display_name === name) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

try {
  // Read, and the layout on a phone.
  {
    const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
    const res = await page.goto(`${base}/account`);
    check(res?.status() === 200, `the page answers 200 (${res?.status()})`);
    check(
      (await heading(page)).startsWith(original.display_name),
      `the heading is the marketplace name (${await heading(page)})`,
    );
    const text = await main(page);
    const role = { owner: "Owner", manager: "Manager", fulfillment: "Fulfillment", viewer: "Viewer" }[
      display.membership.role_key
    ];
    check(text.includes(`Legal Name ${original.name}`), "Trust Details shows the legal name");
    check(
      text.includes(`Membership ${role}`) && text.includes(display.user.primary_email),
      `who is signed in: ${role}, the email`,
    );
    check(text.includes("Account Type Personal") || text.includes("Account Type Business"), "the account type");
    check(text.includes("Status Active"), "the status");
    check((await page.title()) === "Account | Marketplace", `the title (${await page.title()})`);
    const links = await page.locator("main nav a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    check(
      JSON.stringify(links) ===
        JSON.stringify(["/account/shipping-addresses", "/account/inventory/locations", "/account/listings"]),
      `the account screens it links are the pilot's (${links.join(", ")})`,
    );
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(wide <= 0, `nothing scrolls sideways at 390 px (${wide})`);
    const short = await page.evaluate(() =>
      [...document.querySelectorAll("main input:not([type=hidden]), main button, main a")]
        .filter((e) => e.offsetParent !== null)
        .filter((e) => e.getBoundingClientRect().height < 44)
        .map((e) => e.textContent?.trim() || e.getAttribute("name")),
    );
    check(short.length === 0, `every control is at least 44 px tall (${short.join(", ") || "all"})`);
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // With JavaScript.
  {
    const { ctx, page, problems } = await context();
    await page.goto(`${base}/account`);
    const form = page.locator("main form");
    await form.getByLabel("Legal Name").fill("   ");
    await form.getByRole("button", { name: "Update Profile" }).click();
    await page.waitForTimeout(500);
    const blocked = await form.getByLabel("Legal Name").evaluate((i) => i.validity.patternMismatch);
    check(blocked && page.url() === `${base}/account`, "a legal name of spaces is not sent");
    await form.getByLabel("Legal Name").fill(original.name);
    await form.getByLabel("Marketplace name").fill(synthetic);
    await form.getByRole("button", { name: "Update Profile" }).click();
    await page.getByText("Your change was saved").waitFor();
    check(
      page.url().includes("saved="),
      `Update Profile goes to the page with the write's receipt (${new URL(page.url()).search.slice(0, 40)}..)`,
    );
    check(await shows(page, synthetic), "the page shows the new marketplace name");
    check(await settled(synthetic), "Identity has the new marketplace name");
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // Without JavaScript.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: false });
    await page.goto(`${base}/account`);
    const form = page.locator("main form");
    await form.getByLabel("Marketplace name").fill(original.display_name);
    await form.getByRole("button", { name: "Update Profile" }).click();
    await page.waitForLoadState();
    check((await main(page)).includes("Your change was saved"), "without a script, Update Profile says it was saved");
    check(await shows(page, original.display_name), "and the page comes to show the name put back");
    check(await settled(original.display_name), "Identity has the name put back");
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // A visitor.
  {
    const { ctx, page } = await context({ signedIn: false });
    await page.goto(`${base}/account`);
    const at = new URL(page.url());
    check(
      at.origin + at.pathname === `${base}/sign-in` && at.searchParams.get("returnTo") === "/account",
      `a visitor signs in on the pilot, back to /account (${at.pathname}${at.search})`,
    );
    await ctx.close();
  }
} finally {
  const now = await read();
  if (now.name !== original.name || now.display_name !== original.display_name) {
    const res = await fetch(accountUrl, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ name: original.name, displayName: original.display_name }),
    });
    console.log(`restored the profile through the API (${res.status})`);
  }
  await browser.close();
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
