// The collector's sessions (`/account/sessions`) in a browser, against the real platform API, as the
// auth seed's collector. WRITES: each run signs the collector in twice more through Auth's
// password sign-in (two synthetic sessions, their tokens never printed) and revokes both through
// the pilot; the end revokes any the run left active, whatever happened. The browser's own session
// is never touched.
// - Read: the list shows the collector's sessions, each card linking to its page; at 390 px
//   nothing scrolls sideways and every control is at least 44 px tall.
// - The status filter reaches Auth: Active lists only active sessions, and Clear lists them all.
// - A session's page: its details, the breadcrumb back to the list, no Switch Account for a
//   one-account session, and Revoke behind a dialog.
// - With JavaScript: Revoke signs the synthetic session out (Auth then refuses its token), and the
//   page says so. A revoke sent again for it, which Auth answers 500, says it is no longer active.
// - Without JavaScript: Revoke still opens its dialog and signs the second session out.
// - A visitor is sent to the pilot's sign-in, back to /account/sessions.
// - No console errors.
// Usage: node scripts/smoke-market-sessions.mjs [pilot-url] [collector-state] [api-url]
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
const own = (await (await fetch(`${api}/api/auth/session`, { headers: { cookie } })).json()).actor;
const list = async (query = "") =>
  (
    (await (await fetch(`${api}/api/auth/sessions?limit=250${query}`, { headers: { cookie } })).json()).items ?? []
  ).filter((s) => s.user_id === own.userId);
/** A new session of the collector's: its id and a cookie for it (never printed). */
async function signIn() {
  const res = await fetch(`${api}/api/auth/password-sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.PILOT_COLLECTOR_EMAIL ?? "collector@chasesets.test",
      password: process.env.PILOT_COLLECTOR_PASSWORD ?? "collector1234",
    }),
  });
  const body = await res.json();
  return { id: body.sessionId, cookie: `chase_sets_session=${body.sessionToken}` };
}
const alive = async (session) =>
  (await fetch(`${api}/api/auth/session`, { headers: { cookie: session.cookie } })).status === 200;
const created = [];

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
/** Whether the session's card comes to be listed, as the list catches up. */
async function listed(page, id) {
  for (let i = 0; i < 20; i += 1) {
    await page.goto(`${base}/account/sessions?limit=250`);
    if ((await page.locator(`main a[href="/account/sessions/${id}"]`).count()) === 1) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}
/** Revoke the session through its page: Revoke, then the dialog's Confirm revoke. */
async function revoke(page, id) {
  await page.goto(`${base}/account/sessions/${id}`);
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const opens = await dialog.isVisible().catch(() => false);
  if (opens) {
    await dialog.getByRole("button", { name: "Confirm revoke" }).click();
    await page.waitForURL(/said=/);
  }
  return opens;
}

try {
  // Read, and the layout on a phone.
  {
    const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
    const res = await page.goto(`${base}/account/sessions`);
    check(res?.status() === 200, `the list answers 200 (${res?.status()})`);
    const expected = Math.min((await list()).length, 50);
    const cards = await page.locator("main ul a[href^='/account/sessions/ses_']").count();
    check(cards === expected, `one card per session of the collector's, the first 50 (${cards} of ${expected})`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(wide <= 0, `nothing scrolls sideways at 390 px (${wide})`);
    const short = await page.evaluate(() =>
      [...document.querySelectorAll("main select, main button, main a")]
        .filter((e) => e.offsetParent !== null && !e.closest("ul a"))
        .filter((e) => e.getBoundingClientRect().height < 44)
        .map((e) => e.textContent?.trim() || e.getAttribute("name")),
    );
    check(short.length === 0, `every control is at least 44 px tall (${short.join(", ") || "all"})`);

    await page.getByLabel("Status").selectOption("active");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForURL(/status=active/);
    // With the script the page is swapped in after the address changes: wait for the chip.
    await page.getByText("Status: Active").waitFor();
    const statuses = await page.locator("main ul dd span").allInnerTexts();
    const active = (await list("&status=active")).length;
    check(
      statuses.length === Math.min(active, 50) && statuses.every((s) => s === "Active"),
      `Active lists only active sessions (${statuses.length} of ${active})`,
    );
    check((await main(page)).includes("Status: Active"), "and says so");
    await page.getByRole("link", { name: "Clear filters" }).first().click();
    await page.waitForURL((u) => !u.search.includes("status"));
    await page.getByText("Status: Active").waitFor({ state: "detached" });
    check(
      (await page.locator("main ul a[href^='/account/sessions/ses_']").count()) === expected,
      "Clear lists them all again",
    );

    await page.goto(`${base}/account/sessions/${own.sessionId}`);
    const text = await main(page);
    check(
      text.includes("session") && text.includes("Session ID") && text.includes(own.sessionId),
      "a session's page shows its details",
    );
    check(
      (await page.locator("main form[action$='/switch']").count()) === 0,
      "no Switch Account for a one-account session",
    );
    const nav = await page.locator("header nav a[aria-current=page]").getAttribute("href");
    check(nav === "/account/sessions", `the top bar's Sessions is the pilot's and current (${nav})`);
    await page.locator("main nav a[href='/account/sessions']").click();
    await page.waitForURL(`${base}/account/sessions`);
    await page.locator("main h1", { hasText: "Sessions" }).waitFor();
    check(true, "the breadcrumb goes back to the list");
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // With JavaScript: revoke a synthetic session.
  {
    const { ctx, page, problems } = await context();
    const session = await signIn();
    created.push(session);
    check(await alive(session), "a synthetic session is signed in");
    check(await listed(page, session.id), "and comes to be listed");
    const opens = await revoke(page, session.id);
    check(opens, "Revoke asks first");
    check((await main(page)).includes("The session was revoked."), "the page says the session was revoked");
    check(!(await alive(session)), "Auth refuses the revoked session's token");
    // The re-read after a refused write has no receipt to wait for: send it again once Auth lists
    // the session as revoked.
    for (let i = 0; i < 20 && (await list("&status=revoked")).every((s) => s.session_id !== session.id); i += 1) {
      await page.waitForTimeout(1000);
    }
    const again = await page.evaluate(async (path) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      });
      return res.url;
    }, `/account/sessions/${session.id}/revoke`);
    check(
      new URL(again).searchParams.get("said") === "not-active",
      `a revoke sent again (Auth's 500) says it is no longer active (${new URL(again).search})`,
    );
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // Without JavaScript.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: false });
    const session = await signIn();
    created.push(session);
    check(await listed(page, session.id), "a second synthetic session comes to be listed");
    const opens = await revoke(page, session.id);
    check(opens, "without a script, Revoke still opens its dialog (the browser's command=show-modal)");
    check(opens && !(await alive(session)), "and signs the session out");
    check(problems.length === 0, `no console errors (${problems.join(" | ")})`);
    await ctx.close();
  }

  // A visitor.
  {
    const { ctx, page } = await context({ signedIn: false });
    await page.goto(`${base}/account/sessions`);
    const at = new URL(page.url());
    check(
      at.origin + at.pathname === `${base}/sign-in` && at.searchParams.get("returnTo") === "/account/sessions",
      `a visitor signs in on the pilot, back to /account/sessions (${at.pathname}${at.search})`,
    );
    await ctx.close();
  }
} finally {
  for (const session of created) {
    if (!(await alive(session))) continue;
    const res = await fetch(`${api}/api/auth/sessions/${session.id}/revoke`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    console.log(`revoked a session the run left active through the API (${res.status})`);
  }
  check(
    await (async () => (await fetch(`${api}/api/auth/session`, { headers: { cookie } })).status === 200)(),
    "the browser's own session is still signed in",
  );
  await browser.close();
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
