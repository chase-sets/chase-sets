// Signs the auth seed's synthetic collector in through the pilot's own sign-in, against the real
// platform API, with JavaScript and without it, on a phone (390 px) and a desktop (1280 px): a
// signed-out purchases page sends the browser to the pilot's sign-in (a visitor's cart is marketplace's guest cart, so it is not the start), the email step offers its methods, the
// password starts the session (HttpOnly, SameSite=Lax) and the browser lands back on the pilot's
// purchases; then signing out clears the cookie and the purchases ask to sign in again. Nothing is wider
// than the screen and every control is at least 44 px tall. Never sends a wrong password: the API
// counts failures by the browser's address, which on a local run is
// every run's.
// Usage: node scripts/smoke-sign-in.mjs [pilot-url]
import { chromium } from "@playwright/test";

const [base = "http://localhost:7794"] = process.argv.slice(2);
const email = process.env.PILOT_COLLECTOR_EMAIL ?? "collector@chasesets.test";
const password = process.env.PILOT_COLLECTOR_PASSWORD ?? "collector1234";
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

/** Whether the page fits the screen, and the controls shorter than 44 px. */
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
    page.setDefaultTimeout(20_000);
    const problems = [];
    page.on("console", (m) => m.type() === "error" && page.url().startsWith(base) && problems.push(m.text()));
    page.on("pageerror", (e) => problems.push(String(e)));

    await page.goto(`${base}/account/purchases`);
    check(
      page.url() === `${base}/sign-in?returnTo=%2Faccount%2Fpurchases`,
      `${label}: signed-out purchases are the pilot's sign-in (${page.url()})`,
    );
    check((await page.locator("h1").textContent())?.trim() === "Sign In", `${label}: the sign-in page renders`);
    let fit = await layout(page);
    check(
      fit.fits && fit.short.length === 0,
      `${label}: the first step fits, controls 44 px ${JSON.stringify(fit.short)}`,
    );

    await page.getByLabel("Email or phone").fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL(/signInIdentifier=/);
    check(page.url().includes("signInMethod=password"), `${label}: the email step is an address (${page.url()})`);
    check((await page.getByText(`Signing in with ${email}`).count()) === 1, `${label}: it names the email`);
    const methods = await page.getByRole("navigation", { name: "Sign-in method" }).getByRole("link").allTextContents();
    check(
      JSON.stringify(methods) === JSON.stringify(["Passkey", "Email me a sign-in link", "Password"]),
      `${label}: the email's methods ${JSON.stringify(methods)}`,
    );
    const current = await page.locator('nav [aria-current="true"]').textContent();
    check(current?.trim() === "Password", `${label}: the password is shown`);
    fit = await layout(page);
    check(
      fit.fits && fit.short.length === 0,
      `${label}: the password step fits, controls 44 px ${JSON.stringify(fit.short)}`,
    );

    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await page.waitForURL(`${base}/account/purchases**`);
    check(
      page.url().startsWith(`${base}/account/purchases`),
      `${label}: back on the pilot's purchases (${page.url()})`,
    );
    const session = (await ctx.cookies(base)).find((c) => c.name === "chase_sets_session");
    check(
      Boolean(session?.httpOnly) && session?.sameSite === "Lax" && session.expires > Date.now() / 1000,
      `${label}: the session cookie is HttpOnly, Lax and lasts`,
    );
    check(
      (await page.locator("h1").count()) === 1 && !(await page.locator("h1").textContent())?.includes("Sign In"),
      `${label}: the purchases render signed in`,
    );

    const out = await page.request.post(`${base}/sign-out`, { headers: { origin: base }, maxRedirects: 0 });
    check(
      out.status() === 303 && out.headers().location === "/search",
      `${label}: signing out answers 303 to search (${out.status()} ${out.headers().location})`,
    );
    check(
      !(await ctx.cookies(base)).some((c) => c.name === "chase_sets_session" && c.value),
      `${label}: the session cookie is gone`,
    );
    await page.goto(`${base}/account/purchases`);
    check(page.url().startsWith(`${base}/sign-in`), `${label}: the purchases ask to sign in again`);
    check(problems.length === 0, `${label}: no script errors ${JSON.stringify(problems)}`);
    await ctx.close();
  }
}
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "every check passed");
process.exit(failures ? 1 : 0);
