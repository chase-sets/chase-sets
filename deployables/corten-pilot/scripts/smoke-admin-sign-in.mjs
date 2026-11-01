// Signs admin-web's browser-e2e platform admin in through the admin pilot's own sign-in, against
// the real platform API, with JavaScript and without it, on a phone (390 px) and a desktop
// (1280 px): a signed-out postage policies page sends the browser to the pilot's sign-in, the email
// step offers its methods, the password starts the session (HttpOnly, SameSite=Lax) and the
// browser lands back on the pilot's page, whose account menu has Sign out; signing out clears the
// cookie and the page asks to sign in again. Signing in for a page only admin-web serves lands on
// admin-web, which the page's `form-action` must allow. Nothing is wider than the screen and every
// control is at least 44 px tall. Never sends a wrong password: the API counts failures by the browser's
// address, which on a local run is every run's.
// The platform admin exists only in the browser-e2e seed (PLATFORM_ADMIN_EMAIL); against the dev
// seed, sign in as another seeded password user with PILOT_ADMIN_EMAIL and PILOT_ADMIN_PASSWORD
// (the demo user, demo@chasesets.test).
// Usage: node scripts/smoke-admin-sign-in.mjs [pilot-url] [admin-web-url]   (the pilot's ADMIN_WEB_ORIGIN)
import { chromium } from "@playwright/test";

const [base = "http://localhost:7790", adminWeb = "http://localhost:7752"] = process.argv.slice(2);
const email = process.env.PILOT_ADMIN_EMAIL ?? "browser-e2e-platform-admin@chasesets.test";
const password = process.env.PILOT_ADMIN_PASSWORD ?? "browser-e2e-platform-admin-password";
const screen = "/commerce/postage-policies";
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

/** Whether the page fits the screen, and the controls in the page shorter than 44 px. */
async function layout(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const short = [...document.querySelectorAll("main a, main button, main input:not([type=hidden])")]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => el.getBoundingClientRect().height < 43.5)
      .map((el) => el.outerHTML.slice(0, 80));
    return { fits: root.scrollWidth <= root.clientWidth, short };
  });
}

const browser = await chromium.launch();
for (const javaScriptEnabled of [true, false]) {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
  ]) {
    const label = `${javaScriptEnabled ? "with" : "without"} JavaScript at ${viewport.width} px`;
    const ctx = await browser.newContext({ javaScriptEnabled, viewport });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    const problems = [];
    page.on("console", (m) => m.type() === "error" && page.url().startsWith(base) && problems.push(m.text()));
    page.on("pageerror", (e) => problems.push(String(e)));

    await page.goto(`${base}${screen}`);
    check(
      page.url() === `${base}/access/sign-in?returnTo=${encodeURIComponent(screen)}`,
      `${label}: a signed-out page is the pilot's sign-in (${page.url()})`,
    );
    check((await page.locator("h1").textContent())?.trim() === "Sign In", `${label}: the sign-in page renders`);
    const workspace = await page.getByRole("link", { name: "Continue with Google Workspace" }).getAttribute("href");
    check(
      Boolean(workspace?.includes("/api/auth/social/google/start?journey=admin")),
      `${label}: Google Workspace is offered (${workspace})`,
    );
    let fit = await layout(page);
    check(
      fit.fits && fit.short.length === 0,
      `${label}: the first step fits, controls 44 px ${JSON.stringify(fit.short)}`,
    );

    await page.getByLabel("Email or phone").fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL(/signInIdentifier=/);
    check(page.url().includes("signInMethod=password"), `${label}: the email step is an address (${page.url()})`);
    const methods = await page.getByRole("navigation", { name: "Sign-in method" }).getByRole("link").allTextContents();
    check(
      JSON.stringify(methods) === JSON.stringify(["Passkey", "Email me a sign-in link", "Password"]),
      `${label}: the email's methods ${JSON.stringify(methods)}`,
    );
    fit = await layout(page);
    check(
      fit.fits && fit.short.length === 0,
      `${label}: the password step fits, controls 44 px ${JSON.stringify(fit.short)}`,
    );

    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await page.waitForURL(`${base}${screen}**`);
    check(page.url().startsWith(`${base}${screen}`), `${label}: back on the pilot's page (${page.url()})`);
    const session = (await ctx.cookies(base)).find((c) => c.name === "chase_sets_session");
    check(
      Boolean(session?.httpOnly) && session?.sameSite === "Lax" && session.expires > Date.now() / 1000,
      `${label}: the session cookie is HttpOnly, Lax and lasts`,
    );
    const menu = page.getByLabel("Account menu");
    check((await menu.count()) === 1, `${label}: the account menu is there`);
    await menu.click();
    const signOut = page.getByRole("button", { name: "Sign out" });
    check(await signOut.isVisible(), `${label}: the menu opens to Sign out`);
    fit = await layout(page);
    check(fit.fits, `${label}: the page fits with the menu open`);
    await signOut.click();
    await page.waitForURL(`${base}/access/sign-in**`);
    check(page.url() === `${base}/access/sign-in`, `${label}: signing out is the sign-in (${page.url()})`);
    check(
      !(await ctx.cookies(base)).some((c) => c.name === "chase_sets_session" && c.value),
      `${label}: the session cookie is gone`,
    );
    await page.goto(`${base}${screen}`);
    check(page.url().startsWith(`${base}/access/sign-in`), `${label}: the page asks to sign in again`);
    // A page the pilot does not serve is admin-web's: the sign-in's redirect goes there.
    await page.goto(`${base}/access/sign-in?returnTo=${encodeURIComponent("/commerce")}`);
    await page.getByLabel("Email or phone").fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL(/signInIdentifier=/);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await page.waitForURL((u) => !u.pathname.includes("sign-in"), { timeout: 20_000 }).catch(() => undefined);
    check(
      page.url().startsWith(`${adminWeb}/commerce`),
      `${label}: a page only admin-web serves is admin-web's (${page.url()})`,
    );
    check(problems.length === 0, `${label}: no script errors ${JSON.stringify(problems)}`);
    await ctx.close();
  }
}
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "every check passed");
process.exit(failures ? 1 : 0);
