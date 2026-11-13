// Uses Add matching products to Buy Cart on the marketplace search page in a browser, against the
// real platform API, signed in (scripts/sign-in.mjs <marketplace> <state> marketplace) and as a guest.
// - With JavaScript at 1280 px: the trigger opens the preview as a modal dialog without leaving the
//   search, Close shuts it, the trigger opens it again (the README's open workarounds), and Add eligible
//   products goes back to the search saying how many were added and merged, with the cart's count
//   shown. A result's Add to List (words naming a product whose options need no filter, `[list-words]`)
//   opens its dialog in the search, and again after Close.
// - At 390 px: the sheet sits on the bottom edge at the full width, nothing scrolls sideways and its
//   controls are at least 40 px tall.
// - Without JavaScript: the trigger is the search page with the sheet open, and the add is the same
//   redirect.
// - A guest: the add keeps a guest cart in a cookie, and the count shows it.
// The sandbox's cart projection can trail a write by a second or two past the API's
// read-after-write timeout, when the count falls back to the cart as it stands (as marketplace's
// `resolveCartCount` does), so the count is read again for a few seconds before it fails.
// Usage: node scripts/smoke-market-search-cart.mjs [pilot-url] [state-file] [words] [list-words]
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7792",
  stateFile = "artifacts/corten-pilot/marketplace-state.json",
  words = "booster",
  listWords = "booster",
] = process.argv.slice(2);
const search = `${base}/search?q=${encodeURIComponent(words)}`;
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

// Wake the search read.
for (let i = 0; i < 3 && (await fetch(search)).status !== 200; i += 1);

const browser = await chromium.launch();
async function context({ javaScriptEnabled = true, viewport = { width: 1280, height: 900 }, signedIn = true } = {}) {
  const ctx = await browser.newContext({
    javaScriptEnabled,
    viewport,
    ...(signedIn ? { storageState: stateFile } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}
const trigger = (page) => page.getByRole("button", { name: "Add matching products to Buy Cart" });
const sheet = (page) => page.locator("dialog:has(#bulk-cart-title)");
const add = (page) => sheet(page).getByRole("button", { name: "Add eligible products" });
const added = /\d+ added, \d+ merged/;
const count = (page) =>
  page.evaluate(() => {
    const badge = [...document.querySelectorAll('[data-badge="checkout.cart-count"]')].find((b) => !b.hidden);
    return badge ? badge.textContent.trim() : null;
  });
const said = (page) =>
  page
    .getByText(added)
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
async function countSoon(page) {
  for (let i = 0; ; i += 1) {
    const shown = await count(page);
    if ((shown !== null && Number(shown.replace(/\D/g, "")) > 0) || i === 4) return shown;
    await page.waitForTimeout(1_500);
    await page.reload();
  }
}
async function settled(page, url) {
  await page.waitForURL(url);
  await page.waitForFunction(() => !document.querySelector("main")?.hasAttribute("aria-busy"));
}
const isModal = (page) => sheet(page).evaluate((d) => d.matches(":modal"));

// Script, 1280 px, signed in.
{
  const { ctx, page, problems } = await context();
  await page.goto(search);
  await page.waitForFunction(() => window.__hydratedAt);
  check(await trigger(page).isVisible(), "the search offers Add matching products to Buy Cart");
  const address = page.url();
  await trigger(page).click();
  await sheet(page).waitFor({ state: "visible" });
  check(await isModal(page), "the preview opens as a modal dialog");
  check(new URL(page.url()).pathname === "/search", `and the search stays: ${page.url()}`);
  const summary = await sheet(page).locator("p").first().textContent();
  check(/\d+ ready, \d+ need product options\./.test(summary ?? ""), `the preview says what it would add: ${summary}`);
  await sheet(page).getByRole("button", { name: "Close" }).click();
  check(!(await sheet(page).evaluate((d) => d.open)), "Close shuts it");
  await trigger(page).click();
  await sheet(page).waitFor({ state: "visible" });
  check(await isModal(page), "the trigger opens it again after Close");
  if (await add(page).isEnabled()) {
    await add(page).click();
    await settled(page, (u) => u.pathname === "/search" && !u.pathname.endsWith("/cart"));
    check(await said(page), "the add goes back to the search saying how many");
    check(new URL(page.url()).searchParams.get("q") === words, `with the same words: ${page.url()} (was ${address})`);
    const shown = await countSoon(page);
    check(shown !== null && Number(shown.replace(/\D/g, "")) > 0, `the cart's count shows the cart: ${shown}`);
  } else {
    check(false, "Add eligible products is enabled for these words (none are ready; pick other words)");
  }
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

// Script, 1280 px, signed in: a result's Add to List.
{
  const { ctx, page, problems } = await context();
  await page.goto(`${base}/search?q=${encodeURIComponent(listWords)}`);
  await page.waitForFunction(() => window.__hydratedAt);
  const dialog = page.locator("#save-to-list");
  const open = () => dialog.evaluate((d) => d instanceof HTMLDialogElement && d.matches(":modal"));
  const button = page.locator("form.search-page__save button").first();
  await button.click();
  await page.locator("#save-to-list[open]").waitFor();
  check(await open(), "a result's Add to List opens its dialog, modal");
  check(new URL(page.url()).pathname === "/search", `in the search: ${page.url()}`);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  check(!(await dialog.evaluate((d) => d.open)), "Cancel shuts it");
  await button.click();
  await page.locator("#save-to-list[open]").waitFor();
  check(await open(), "and Add to List opens it again");
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

// Script, 390 px, signed in.
{
  const { ctx, page, problems } = await context({ viewport: { width: 390, height: 844 } });
  await page.goto(search);
  await page.waitForFunction(() => window.__hydratedAt);
  await trigger(page).click();
  await sheet(page).waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector("dialog:has(#bulk-cart-title)");
    const r = dialog.getBoundingClientRect();
    const small = [];
    for (const el of dialog.querySelectorAll("a, button")) {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.height < 40)
        small.push(`${el.tagName} ${el.textContent.trim().slice(0, 30)} ${Math.round(b.height)}`);
    }
    return {
      bottom: Math.round(window.innerHeight - r.bottom),
      width: Math.round(r.width),
      viewport: window.innerWidth,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      small,
    };
  });
  check(Math.abs(layout.bottom) <= 1, `the sheet sits on the bottom edge (${layout.bottom} px above it)`);
  check(Math.abs(layout.width - layout.viewport) <= 1, `at the full width (${layout.width} of ${layout.viewport})`);
  check(layout.overflow <= 0, `nothing scrolls sideways (${layout.overflow})`);
  check(
    layout.small.length === 0,
    `every sheet control is at least 40 px tall${layout.small.length ? `: ${layout.small.join(", ")}` : ""}`,
  );
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

// No script, signed in.
{
  const { ctx, page } = await context({ javaScriptEnabled: false });
  await page.goto(search);
  await trigger(page).click();
  await page.waitForURL(/\/search\/cart\?/);
  check(await sheet(page).isVisible(), `without a script the trigger is the page with the sheet open: ${page.url()}`);
  await add(page).click();
  await page.waitForURL((u) => u.pathname === "/search");
  check(await said(page), "and the add is the same redirect, saying how many");
  await ctx.close();
}

// Script, a guest.
{
  const { ctx, page, problems } = await context({ signedIn: false });
  await page.goto(search);
  await page.waitForFunction(() => window.__hydratedAt);
  await trigger(page).click();
  await sheet(page).waitFor({ state: "visible" });
  await add(page).click();
  await settled(page, (u) => u.pathname === "/search");
  check(await said(page), "a guest's add says how many");
  const cookie = (await ctx.cookies()).find((c) => c.name === "chase_sets_anonymous_cart");
  check(Boolean(cookie?.value), "and keeps the guest cart in a cookie");
  const shown = await countSoon(page);
  check(shown !== null && Number(shown.replace(/\D/g, "")) > 0, `the cart's count shows it: ${shown}`);
  check(problems.length === 0, `no console errors${problems.length ? `: ${problems.join(" | ")}` : ""}`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
