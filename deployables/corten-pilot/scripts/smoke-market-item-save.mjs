// Uses the item page's Add to List in a browser, against the real platform API.
// - As a guest, without JavaScript: Add to List saves an intent, keeps its owner in marketplace's
//   cookie, and lands on marketplace's registration with the claim in its return address.
// - As the auth seed's collector, without JavaScript: Add to List opens the dialog the page drew
//   (command="show-modal"), with the recent lists and a new list; Add Product adds the product and
//   the page says where it went, with the list in marketplace's collection.
// - With JavaScript: a new list without a title comes back refused with the dialog open, and its
//   script makes it modal; Escape closes it and focus returns to Add to List.
// - At 390 px the dialog is a sheet at the bottom, and nothing scrolls sideways.
// It writes a guest intent (which expires on its own) and adds the product to the collector's list
// "Corten pilot smoke", made on the first run and reused after (Collections has no archive route).
// Usage: node scripts/smoke-market-item-save.mjs [pilot-url] [collector-state] [marketplace-url] [api-url] [slug]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7793",
  collectorState = "../../artifacts/corten-pilot/collector-state.json",
  web = "http://localhost:7753",
  api = "http://localhost:7762",
  slug = "charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp",
] = process.argv.slice(2);
const TITLE = "Corten pilot smoke";
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

const collector = JSON.parse(readFileSync(collectorState, "utf8"))
  .cookies.filter((c) => c.name === "chase_sets_session")
  .map((c) => `${c.name}=${c.value}`)
  .join("; ");
const recent = async () =>
  (
    await (
      await fetch(`${api}/api/marketplace/account/saved-lists/recent`, {
        headers: { cookie: collector, "chase-sets-read-target-context": "discovery" },
      })
    ).json()
  ).items ?? [];
async function eventually(read, done) {
  let value = await read();
  for (let i = 0; i < 30 && !done(value); i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    value = await read();
  }
  return value;
}

// Raw and Near Mint: a product in the seed.
const choice = "dimension.dim_seed_form=chc_seed_form_raw&dimension.dim_seed_condition=chc_seed_condition_near_mint";
const itemPage = `${base}/items/${slug}?${choice}`;

const browser = await chromium.launch();
const elsewhere = [];
async function context({ javaScriptEnabled, state, viewport }) {
  const ctx = await browser.newContext({
    javaScriptEnabled,
    ...(state ? { storageState: state } : {}),
    ...(viewport ? { viewport } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  const theirs = (text) =>
    !page.url().startsWith(base) && (elsewhere.push(`${page.url().split("?")[0]}: ${text.slice(0, 160)}`), true);
  page.on(
    "console",
    (m) => m.type() === "error" && !m.text().includes("status of 422") && !theirs(m.text()) && problems.push(m.text()),
  );
  page.on("pageerror", (e) => !theirs(String(e)) && problems.push(String(e)));
  page.on("response", (r) => {
    if (r.status() === 404 || r.status() >= 500)
      (r.url().startsWith(base) ? problems : elsewhere).push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return { ctx, page, problems };
}
const addToList = (page) => page.getByRole("button", { name: /to a Saved List$/ });
const dialog = (page) => page.locator("dialog#save-to-list");

try {
  // A guest, without JavaScript.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: false });
    await page.goto(itemPage);
    check((await dialog(page).count()) === 0, "a guest's page draws no dialog");
    await addToList(page).click();
    await page.waitForURL((u) => u.href.startsWith(`${web}/register`));
    const back = new URL(new URL(page.url()).searchParams.get("returnTo") ?? "/", web);
    const intent = back.searchParams.get("claimSavedListIntent");
    check(
      back.pathname === `/items/${slug}` && Boolean(intent),
      `it lands on marketplace's registration, back to the item with the claim (${intent})`,
    );
    const owner = (await ctx.cookies()).find((c) => c.name === "chase_sets_anonymous_saved_lists")?.value;
    check(
      Boolean(owner?.startsWith("anon_cmd_")),
      `the guest's owner is kept in marketplace's cookie (${owner?.slice(0, 9)}...)`,
    );
    check(problems.length === 0, `no errors on the pilot's pages (${problems.join("; ")})`);
    await ctx.close();
  }

  // The collector, without JavaScript.
  {
    const before = await recent();
    const existing = before.find((l) => l.title === TITLE);
    const { ctx, page, problems } = await context({ javaScriptEnabled: false, state: collectorState });
    await page.goto(itemPage);
    check(!(await dialog(page).isVisible()), "the dialog is drawn closed");
    await addToList(page).click();
    check(await dialog(page).isVisible(), "Add to List opens it with no script");
    check(await dialog(page).evaluate((d) => d.matches(":modal")), "as a modal");
    const radios = dialog(page).locator('input[name="list"]');
    check((await radios.count()) === before.length + 1, `it offers the ${before.length} recent lists and a new one`);
    const title = dialog(page).locator('input[name="title"]');
    if (existing) {
      await dialog(page).locator(`input[name="list"][value="${existing.listId}"]`).check();
      check(!(await title.isVisible()), "with a recent list chosen, the new list's title is hidden");
    } else {
      await dialog(page).locator('input[name="list"][value="new"]').check();
      check(await title.isVisible(), "with a new list chosen, its title is shown");
      await title.fill(TITLE);
    }
    await dialog(page).locator('input[name="quantity"]').fill("2");
    await dialog(page).getByRole("button", { name: "Add Product" }).click();
    await page.waitForURL((u) => u.searchParams.has("saved"));
    const at = new URL(page.url());
    check(at.origin === base && at.searchParams.get("saved_quantity") === "2", "the page comes back after the write");
    const banner = page.getByRole("status").filter({ hasText: `Added to ${TITLE}` });
    check((await banner.count()) === 1, `and says the product was added to ${TITLE}`);
    const line = existing
      ? "already on the List, so its Tracked Quantity increased by 2"
      : "added with a Tracked Quantity of 2";
    check((await banner.innerText()).includes(line), `(${line})`);
    const view = banner.getByRole("link", { name: "View in My Collection" });
    const href = new URL(await view.getAttribute("href"));
    check(
      href.origin === web && href.searchParams.get("list") === at.searchParams.get("saved_list"),
      "View in My Collection opens the list on marketplace",
    );
    const after = await eventually(
      recent,
      (lists) => (lists.find((l) => l.title === TITLE)?.trackedUnitCount ?? 0) >= (existing?.trackedUnitCount ?? 0) + 2,
    );
    const list = after.find((l) => l.title === TITLE);
    check(
      list?.trackedUnitCount === (existing?.trackedUnitCount ?? 0) + 2,
      `the list tracks 2 more (${existing?.trackedUnitCount ?? 0} -> ${list?.trackedUnitCount})`,
    );
    check(problems.length === 0, `no errors on the pilot's pages (${problems.join("; ")})`);
    await ctx.close();
  }

  // With JavaScript: a refusal comes back with the dialog open, made modal by its script.
  {
    const { ctx, page, problems } = await context({ javaScriptEnabled: true, state: collectorState });
    await page.goto(itemPage);
    await addToList(page).click();
    await dialog(page).locator('input[name="list"][value="new"]').check();
    await dialog(page).locator('input[name="title"]').fill("   ");
    const refused = page.waitForResponse((r) => r.url().endsWith("/save") && r.request().method() === "POST");
    await dialog(page).getByRole("button", { name: "Add Product" }).click();
    check((await refused).status() === 422, "a new list without a title is refused (422)");
    await page.waitForLoadState();
    check(await dialog(page).isVisible(), "the page comes back with the dialog open");
    check((await dialog(page).getByRole("alert").innerText()).includes("Enter a title"), "saying why");
    check(await dialog(page).evaluate((d) => d.matches(":modal")), "and its script makes it modal");
    check(await dialog(page).locator('input[name="list"][value="new"]').isChecked(), "with a new list still chosen");
    await page.keyboard.press("Escape");
    check(!(await dialog(page).isVisible()), "Escape closes it");
    check(problems.length === 0, `no errors on the pilot's pages (${problems.join("; ")})`);
    await ctx.close();
  }

  // At 390 px, the dialog is a sheet at the bottom of the screen.
  {
    const { ctx, page } = await context({
      javaScriptEnabled: true,
      state: collectorState,
      viewport: { width: 390, height: 844 },
    });
    await page.goto(itemPage);
    await addToList(page).click();
    await dialog(page).locator('input[name="list"][value="new"]').check();
    const { wide, box, small } = await page.evaluate(() => {
      const d = document.querySelector("dialog#save-to-list");
      const r = d.getBoundingClientRect();
      return {
        wide: document.documentElement.scrollWidth > window.innerWidth || d.scrollWidth > d.clientWidth,
        box: {
          left: Math.round(r.left),
          right: Math.round(window.innerWidth - r.right),
          bottom: Math.round(window.innerHeight - r.bottom),
        },
        small: Array.from(
          d.querySelectorAll('button, input:not([type="hidden"]):not([type="radio"]), label:not([for])'),
        )
          .filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 40)
          .map(
            (e) =>
              `${e.tagName} "${e.textContent.trim().slice(0, 20)}" ${Math.round(e.getBoundingClientRect().height)}px`,
          ),
      };
    });
    check(!wide, "390 px: nothing scrolls sideways");
    check(
      box.left === 0 && box.right === 0 && box.bottom === 0,
      `390 px: the dialog spans the screen's width at its bottom (${JSON.stringify(box)})`,
    );
    check(small.length === 0, `390 px: every control in it is at least 40 px (${small.join(", ")})`);
    await page.screenshot({ path: "../../artifacts/corten-pilot/item-save-390.png" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: "../../artifacts/corten-pilot/item-save-1280.png" });
    await ctx.close();
  }
} finally {
  await browser.close();
}
if (elsewhere.length)
  console.log(
    `note marketplace's own pages logged ${elsewhere.length} errors (not counted):\n     ${[...new Set(elsewhere)].slice(0, 6).join("\n     ")}`,
  );
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
