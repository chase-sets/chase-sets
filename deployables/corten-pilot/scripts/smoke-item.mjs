// Uses a catalog item's page in a browser as a signed-in platform admin, with JavaScript and
// without it, against the real platform API. A draft made for the run is opened from the list and
// changed through every dialog: the publish refused without a blueprint (and Recheck), a
// blueprint, the description, tags, image URLs (two lines), an image fallback (refused JSON, then
// saved and cleared), both kinds of external reference, a field value (the dialog the server
// draws when opened), a category and a content line. Without JavaScript the server-drawn dialog
// and a refused form come back as the page. At a phone's width the page does not scroll
// sideways. The draft is removed at the end. It writes to the dev sandbox's data.
// Usage: node scripts/smoke-item.mjs [pilot-url] [state-file] [model-item]
//   model-item: an active item whose blueprint, fields and category the draft borrows.
import { chromium } from "@playwright/test";

const [
  base = "http://localhost:7790",
  stateFile = "../../artifacts/corten-pilot/admin-state.json",
  model = "cat_seed_lorcana_elsa_snow_queen",
] = process.argv.slice(2);
const stamp = Date.now().toString(36);
let failures = 0;

function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
}

let blocked = 0;
/** A step the platform API keeps from passing, with the issue that tracks it. */
function block(what, issue) {
  console.log(`BLKD ${what} (${issue})`);
  blocked += 1;
}

/**
 * A write's result on the page: `shown` within the wait, else blocked when the API's item does
 * not have it either (`inApi`): the admin item projection can rebuild the page from the row
 * before the write. A page that misses what the API has is a failure.
 */
async function landed(page, what, shown, inApi) {
  if (await eventually(page, shown)) return (check(true, what), true);
  if (!inApi(await apiItem(page, id)))
    return (block(`${what}: saved, and the API's item does not have it`, "chase-sets#10554"), false);
  return (check(false, what), false);
}

/** The item as the API answers it now, without a receipt. */
async function apiItem(page, item) {
  const res = await page.request.get(`${base}/catalog/catalog-items/${item}`, {
    headers: { accept: "application/json" },
  });
  return (await res.json()).data.item;
}

async function settled(page) {
  const start = Date.now();
  while ((await page.getByText("Refresh in a moment").count()) && Date.now() - start < 90_000) {
    await page.waitForTimeout(2_000);
    await page.reload();
  }
}

async function navigated(page) {
  await page.waitForLoadState();
  await page.waitForFunction(() => !(/** @type {any} */ (window).navigation?.transition));
  await settled(page);
  await mark(page);
}

const browser = await chromium.launch();

async function context(javaScriptEnabled, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ storageState: stateFile, javaScriptEnabled, viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  // 503 is the API's "preparing" after a write; 422 a refused form, which the page shows.
  page.on("console", (m) => m.type() === "error" && !/status of (503|422)/.test(m.text()) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  return { ctx, page, problems };
}

/**
 * Whether `shown` holds on the page, reloading for up to a minute. A local catalog projection can
 * take longer than a receipt's 30 seconds to show a write (the item read waits on every catalog
 * projection), and then the page is drawn from the read before it.
 */
async function eventually(page, shown) {
  const start = Date.now();
  for (;;) {
    if (await shown().catch(() => false)) return true;
    if (Date.now() - start > 90_000) return false;
    await page.waitForTimeout(2_000);
    await page.reload();
    await navigated(page);
  }
}

/**
 * Marks the page drawn now, so the page a write sends the browser to is the one without the mark.
 * Two writes in a row can end on the same address (product contents' writes carry no receipt),
 * so the address alone does not tell them apart.
 */
async function mark(page) {
  await page.evaluate(() => document.querySelector("main")?.firstElementChild?.setAttribute("data-smoke-seen", ""));
}

/** Whether a new page (not the marked one) with `done=change` arrived within `ms`. */
async function arrived(page, change, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const now = await page
      .evaluate(
        (c) =>
          new URL(location.href).searchParams.get("done") === c &&
          document.readyState !== "loading" &&
          !document.querySelector("main > [data-smoke-seen]"),
        change,
      )
      .catch(() => false);
    if (now) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

/** After a write: the page it sent the browser to, with its toast. */
async function done(page, change) {
  if (!(await arrived(page, change, 30_000))) throw new Error(`no page with done=${change} after the write`);
  await navigated(page);
}

/** Whether a write ended on the page with `change` (false when the dialog refused it). */
async function wrote(page, change) {
  const ok = await arrived(page, change, 15_000);
  if (ok) await navigated(page);
  return ok;
}

/**
 * A control by its accessible name. Not getByLabel's exact match: that takes a wrapping label's
 * whole text, which has a textarea's content and a select's options in it.
 */
function labelled(box, name) {
  const by = (role) => box.getByRole(role, { name, exact: true });
  return by("textbox").or(by("combobox")).or(by("listbox")).or(by("spinbutton"));
}

/** Opens a dialog by its button, fills its fields (by label) and presses `submit`. */
async function dialog(page, id, open, fields, submit) {
  await page.getByRole("button", { name: open, exact: true }).first().click();
  const box = page.locator(`#${id}`);
  await box.waitFor({ state: "visible" });
  for (const [label, value] of fields) {
    const field = labelled(box, label);
    if ((await field.evaluate((el) => el.tagName)) === "SELECT") await field.selectOption(value);
    else await field.fill(value);
  }
  await box.getByRole("button", { name: submit, exact: true }).click();
  return box;
}

// The model item, as a data client reads its page (req.screen).
const probe = await context(true);
// A screen answers JSON as { title, data }.
const modelData = (
  await (
    await probe.page.request.get(`${base}/catalog/catalog-items/${model}`, { headers: { accept: "application/json" } })
  ).json()
).data;
await probe.ctx.close();
const blueprint = modelData.item.blueprint;
const textField = modelData.item.field_values.find((v) => !v.reference && typeof v.value === "string");
const referenceField = modelData.item.field_values.find((v) => v.reference);
const category = modelData.item.categories[0];
check(
  Boolean(blueprint && textField && referenceField && category),
  `the model item has a blueprint, a text and a reference field, a category (${model})`,
);

let id = "";
// With JavaScript.
{
  const { ctx, page, problems } = await context(true);
  await page.goto(`${base}/catalog/catalog-items`);
  await navigated(page);
  await page.getByRole("button", { name: "New Catalog Item" }).click();
  const create = page.locator("#catalog-create-dialog");
  id = await create.locator('input[name="item_id"]').inputValue();
  await create.getByLabel("Description").fill(`Smoke ${stamp}`);
  await create.getByRole("button", { name: "Create" }).click();
  await page.waitForURL((u) => u.searchParams.get("done") === "created");
  for (let i = 0; i < 30; i += 1) {
    await page.goto(`${base}/catalog/catalog-items?search=${id}`);
    await navigated(page);
    if ((await page.locator("#catalog-rows tbody tr").count()) === 1) break;
    await page.waitForTimeout(2_000);
  }
  await page
    .getByRole("row", { name: new RegExp(id) })
    .getByRole("link", { name: "View" })
    .click();
  await navigated(page);
  check(new URL(page.url()).pathname === `/catalog/catalog-items/${id}`, "the list's View opens the pilot's page");
  check((await page.locator("h1").textContent()) === id, "the draft's title is its id");

  // Publish without a blueprint: the API refuses; Recheck draws the form again.
  const publish = await dialog(page, "item-publish-dialog", "Publish", [], "Publish");
  await publish.locator(".form-error").waitFor();
  check(await publish.isVisible(), "a refused publish stays in its open dialog");
  // The API decides which precondition it names first (a new draft's display identity is outdated).
  const reason = (await publish.locator(".form-error").textContent()) ?? "";
  check(reason.trim().length > 0, `with the API's reason (${reason})`);
  check(await publish.getByText("Display identity readiness").isVisible(), "and the display identity's readiness");
  await publish.getByRole("button", { name: "Recheck display identity" }).click();
  await page.waitForFunction(() => !document.querySelector("#item-publish .form-error"));
  check(new URL(page.url()).pathname.endsWith(id), "Recheck is a patch: the address stays");
  await publish.getByRole("button", { name: "Close" }).click();

  // A blueprint: an unknown id is refused, then the model's.
  const bp = await dialog(page, "item-blueprint-dialog", "Assign Blueprint", [["Blueprint ID", "bpt_nope"]], "Assign");
  await bp.locator(".form-error").waitFor();
  check(
    await bp.isVisible(),
    `an unknown blueprint is refused in the dialog (${await bp.locator(".form-error").textContent()})`,
  );
  await labelled(bp, "Blueprint ID").fill(blueprint.blueprintId);
  await bp.getByRole("button", { name: "Assign", exact: true }).click();
  await done(page, "blueprint_assigned");
  check(await page.getByText("Blueprint assigned").isVisible(), "the blueprint's toast");
  check(await page.getByText(blueprint.name, { exact: true }).first().isVisible(), "the page shows the blueprint");

  // The description.
  await dialog(page, "item-metadata-dialog", "Edit Description", [["Description", `Smoke ${stamp} described`]], "Save");
  await done(page, "metadata_revised");
  await landed(
    page,
    "the new description",
    () => page.getByText(`Smoke ${stamp} described`).isVisible(),
    (i) => i.description === `Smoke ${stamp} described`,
  );

  // Tags, and image URLs on two lines (admin-web's input keeps one).
  await page.locator("summary", { hasText: "Tags" }).click();
  await dialog(page, "item-tags-dialog", "Set Tags", [["Tags", ` smoke , ${stamp} `]], "Save");
  await done(page, "tags_updated");
  // The API keeps tags sorted.
  await landed(
    page,
    "the tags, in their open fold",
    () => page.getByText(["smoke", stamp].sort().join(", ")).isVisible(),
    (i) => i.tags.includes(stamp),
  );
  await page.locator("summary", { hasText: "Image URLs" }).click();
  const urls = [`https://example.com/${stamp}/a.png`, `https://example.com/${stamp}/b.png`];
  await dialog(page, "item-image-urls-dialog", "Set Image URLs", [["Image URLs", urls.join("\n")]], "Save");
  await done(page, "image_urls_updated");
  await landed(
    page,
    "both image URLs",
    async () => (await page.locator("li", { hasText: stamp }).count()) === 2,
    (i) => i.image_urls.length === 2 && i.image_urls[0].includes(stamp),
  );

  // An image fallback: variants that are not an object are the field's error.
  await page.locator("summary", { hasText: "Image fallback" }).click();
  const fb = await dialog(
    page,
    "item-fallback-dialog",
    "Set image fallback",
    [
      ["URL", urls[0]],
      ["Variants JSON", "[1]"],
    ],
    "Save",
  );
  await fb.locator("[aria-invalid=true]").waitFor();
  check(await fb.getByText("Enter a JSON object").isVisible(), "variants that are not an object are refused");
  await labelled(fb, "Variants JSON").fill(`{"thumb": {"oneX": "${urls[1]}"}}`);
  await labelled(fb, "Usage").selectOption("loading-only");
  await fb.getByRole("button", { name: "Save", exact: true }).click();
  await done(page, "fallback_updated");
  if (
    await landed(
      page,
      "the fallback, its usage in the summary",
      () => page.getByText("loading-only fallback").isVisible(),
      (i) => i.image_fallback?.usage === "loading-only",
    )
  ) {
    await page.getByRole("button", { name: "Clear image fallback" }).click();
    await done(page, "fallback_cleared");
    await landed(
      page,
      "the fallback is cleared",
      () => page.getByText("No image fallback.").first().isVisible(),
      (i) => i.image_fallback === null,
    );
  }

  // External references: a catalog item reference (the origin section follows it), then a product
  // reference with options.
  const provider = `smoke-${stamp}`;
  await page.locator("summary", { hasText: "External Catalog Item References" }).click();
  await dialog(
    page,
    "item-catalog-ref-dialog",
    "Link Catalog Item Reference",
    [
      ["Provider", provider],
      ["External Key", "k/1"],
    ],
    "Link",
  );
  await done(page, "catalog_ref_linked");
  if (
    await landed(
      page,
      "the catalog item reference (a key with a slash)",
      () => page.getByRole("cell", { name: "k/1", exact: true }).isVisible(),
      (i) => i.external_catalog_item_references.some((r) => r.externalKey === "k/1" || r.external_key === "k/1"),
    )
  ) {
    check(
      await page.getByRole("link", { name: `View Source Observations (${provider})` }).isVisible(),
      "the origin names its provider",
    );
    await page.getByRole("row", { name: /k\/1/ }).getByRole("button", { name: "Unlink" }).click();
    await done(page, "catalog_ref_unlinked");
    await landed(
      page,
      "unlinked",
      () => page.getByText("No external catalog item references").first().isVisible(),
      (i) => i.external_catalog_item_references.length === 0,
    );
  }
  await page.locator("summary", { hasText: "External Product References" }).click();
  const pr = await dialog(
    page,
    "item-product-ref-dialog",
    "Link External Reference",
    [
      ["Provider", provider],
      ["External Key", "sku-1"],
      ["Selected Options", "dim_a:opt_1, broken"],
    ],
    "Link",
  );
  if (await wrote(page, "product_ref_linked")) {
    if (
      await landed(
        page,
        "the product reference and its one whole option",
        () => page.getByRole("cell", { name: "dim_a:opt_1", exact: true }).isVisible(),
        (i) => i.external_product_references.length > 0,
      )
    ) {
      await page.getByRole("row", { name: /sku-1/ }).getByRole("button", { name: "Unlink" }).click();
      await done(page, "product_ref_unlinked");
      await landed(
        page,
        "unlinked",
        () => page.getByText("No external references").first().isVisible(),
        (i) => i.external_product_references.length === 0,
      );
    }
  } else {
    const refused = pr.locator(".form-error");
    check(
      await refused.isVisible(),
      `the API refused the made-up option, in the dialog (${await refused.textContent()})`,
    );
    await pr.getByRole("button", { name: "Close" }).click();
  }

  // A field value, from the dialog the server draws when it is opened.
  await page.getByRole("button", { name: "Set Field Value" }).click();
  const fv = page.locator("#item-field-dialog");
  await fv.waitFor({ state: "visible" });
  check(new URL(page.url()).pathname.endsWith(id), "the dialog was patched in (the address stays)");
  const reference = labelled(fv, "Reference Record");
  await labelled(fv, "Field").selectOption(referenceField.fieldId);
  check(await reference.isVisible(), "a reference field takes a reference record");
  await labelled(fv, "Field").selectOption(textField.fieldId);
  check(await reference.isHidden(), "a text field takes text");
  await labelled(fv, "Value").fill(`smoke ${stamp}`);
  await fv.getByRole("button", { name: "Set", exact: true }).click();
  await done(page, "field_set");
  const hasValue = (i) => i.field_values.some((v) => v.fieldId === textField.fieldId);
  if (
    await landed(
      page,
      "the field's value",
      () => page.getByRole("cell", { name: `smoke ${stamp}` }).isVisible(),
      hasValue,
    )
  ) {
    await page
      .getByRole("row", { name: new RegExp(`smoke ${stamp}`) })
      .getByRole("button", { name: "Clear" })
      .click();
    await done(page, "field_cleared");
    check(await page.getByText("Field value cleared").isVisible(), "the value cleared (its toast)");
    await landed(
      page,
      "the value cleared",
      () => page.getByRole("cell", { name: `smoke ${stamp}` }).isHidden(),
      (i) => !hasValue(i),
    );
  }

  // A category.
  await dialog(page, "item-category-dialog", "Assign Category", [["Category ID", category.categoryId]], "Assign");
  await done(page, "category_assigned");
  const inCategory = (i) => i.categories.some((c) => c.categoryId === category.categoryId);
  if (
    await landed(
      page,
      "the category",
      () => page.getByRole("cell", { name: category.name, exact: true }).isVisible(),
      inCategory,
    )
  ) {
    await page.getByRole("row", { name: category.name }).getByRole("button", { name: "Remove" }).click();
    await done(page, "category_removed");
    await landed(
      page,
      "the category removed",
      () => page.getByText("No categories assigned.").isVisible(),
      (i) => !inCategory(i),
    );
  }

  // A content line: the model item inside the draft.
  await page.locator("summary", { hasText: /^Contents/ }).click();
  await page.getByRole("button", { name: "Add content line" }).click();
  const cl = page.locator("#item-content-dialog");
  await cl.waitFor({ state: "visible" });
  check((await labelled(cl, "Content Type").inputValue()) !== "", "the first content type is chosen");
  await labelled(cl, "Contained Catalog Item").selectOption(model);
  await labelled(cl, "Quantity").fill("2");
  await cl.getByRole("button", { name: "Add content line", exact: true }).click();
  if (await wrote(page, "contents_updated")) {
    const line = page.locator("tr", { hasText: modelData.item.title });
    check(await line.first().isVisible(), "the line, named by its item, in the open fold");
    await line.first().getByRole("button", { name: "Remove" }).click();
    await done(page, "contents_updated");
    check(await eventually(page, () => page.getByText("No Product Contents.").isVisible()), "the line removed");
  } else {
    const refused = cl.locator(".form-error");
    check(await refused.isVisible(), `the API refused the line, in the dialog (${await refused.textContent()})`);
  }
  check(problems.length === 0, `no script errors (${problems.join(" | ")})`);
  await ctx.close();
}

// Without JavaScript.
{
  const { ctx, page } = await context(false);
  await page.goto(`${base}/catalog/catalog-items/${id}`);
  await navigated(page);
  await page.getByRole("button", { name: "Set Field Value" }).click();
  await navigated(page);
  check(new URL(page.url()).pathname.endsWith("/fields"), "Set Field Value is a page without the script");
  const fv = page.locator("#item-field-dialog");
  check((await fv.getAttribute("open")) !== null, "with its dialog open");
  await labelled(fv, "Field").selectOption(textField.fieldId);
  await labelled(fv, "Value").fill(`plain ${stamp}`);
  await fv.getByRole("button", { name: "Set", exact: true }).click();
  await done(page, "field_set");
  await landed(
    page,
    "set without the script",
    () => page.getByRole("cell", { name: `plain ${stamp}` }).isVisible(),
    (i) => i.field_values.some((v) => v.fieldId === textField.fieldId),
  );
  await page.locator("summary", { hasText: "Image fallback" }).click();
  await page.getByRole("button", { name: "Set image fallback" }).click();
  const fb = page.locator("#item-fallback-dialog");
  await labelled(fb, "Variants JSON").fill("nope");
  await fb.getByRole("button", { name: "Save", exact: true }).click();
  await navigated(page);
  check(
    (await page.locator("#item-fallback-dialog").getAttribute("open")) !== null,
    "a refused form is the page with its dialog open",
  );
  check(await page.getByText("Enter a JSON object").isVisible(), "and its error");
  await ctx.close();
}

// A phone's width: the draft and the model item, every fold open.
{
  const { ctx, page, problems } = await context(true, { width: 390, height: 844 });
  for (const item of [id, model]) {
    await page.goto(`${base}/catalog/catalog-items/${item}`);
    await navigated(page);
    for (const summary of await page.locator("summary").all()) await summary.click();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(wide <= 0, `${item} does not scroll sideways at 390 px (${wide} px over)`);
  }
  await page.screenshot({ path: "../../artifacts/corten-pilot/item-390.png", fullPage: true });
  check(problems.length === 0, `no script errors at 390 px (${problems.join(" | ")})`);
  await ctx.close();
}

// The draft, removed.
{
  const { ctx, page } = await context(true);
  await page.goto(`${base}/catalog/catalog-items?search=${id}`);
  await navigated(page);
  await page
    .getByRole("row", { name: new RegExp(id) })
    .getByRole("checkbox")
    .check();
  await page.getByRole("button", { name: "Remove drafts from selected" }).click();
  await page.locator("#catalog-bulk-preview").getByRole("button", { name: "Remove drafts from selected" }).click();
  await page.waitForURL((u) => u.searchParams.get("done") === "drafts_removed");
  check(true, `the draft is removed (${id})`);
  await ctx.close();
}

await browser.close();
console.log(
  `${failures ? `${failures} failed` : "all passed"}${blocked ? `, ${blocked} blocked by the platform API` : ""}`,
);
process.exit(failures ? 1 : 0);
