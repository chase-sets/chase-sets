import { expect, test, type Page } from "@playwright/test";
import {
  assertRenderedCopy,
  expectRenderedCopyWitness as requireWitness,
  renderedCopyTuples,
  sweepRenderedCopy,
  validateRenderedCopyBaseline,
  type RenderedCopyBaselineRow,
  type RenderedCopyWitness,
} from "@chase-sets/playwright-evidence/rendered-copy";
import { authenticateAdmin, authenticatePlatformAdmin, expectAdminPageReady } from "./support/admin-e2e";

type SweepWitness = Readonly<{ witness: RenderedCopyWitness; resolvedPath?: string }>;
const witnesses: Readonly<Record<string, SweepWitness>> = {
  // Identity support/runtime-support/seed.ts:391 creates this account's audit event.
  "/access/accounts/acc_seed_demo_account?tab=audit": {
    witness: { kind: "populated", selector: '[role="tabpanel"]', text: "account · created" },
  },
  // Auth seed.ts:86 and Identity seed.ts:393 bind the seeded demo session's account name.
  "/access/sessions": { witness: { kind: "populated", selector: "table tbody tr", text: "Chase Sets" } },
  // Catalog features/dimensions/api/seed.ts:107 supplies a populated option, not the page heading.
  "/catalog/dimensions/dim_seed_condition": {
    witness: { kind: "populated", selector: "table tbody tr", text: "Near Mint" },
  },
  // Catalog features/display-templates/api/seed.ts:19 names this seeded template.
  "/catalog/display-templates": {
    witness: { kind: "populated", selector: "table tbody tr", text: "Pokemon single card" },
  },
  // Catalog support/authoring-support/seed.ts:173 seeds the TCGdex provider integration profile.
  "/catalog/integrations": { witness: { kind: "populated", selector: "table tbody tr", text: "TCGdex" } },
  // Catalog features/reference-data/api/seed.ts:263 creates this expansion record.
  "/catalog/scopes/ref_seed_expansion_base_set": {
    witness: {
      kind: "populated",
      selector: 'role=region[name="Catalog scope sync"] >> dl',
      text: "tcgdex / pokemon / ref_seed_series_base / Base Set",
    },
  },
  // Catalog source-observations/api/seeding/seed.ts:136-160 creates this observation from its base2-60 scenario fixture.
  "/catalog/source-observations/tcgdex_en_base2_60": {
    witness: { kind: "populated", selector: "dl", text: "base2-60" },
  },
  // Ordering support/runtime-support/seed.ts:298 creates this policy label.
  "/commerce/postage-policies": {
    witness: { kind: "populated", selector: "table tbody tr", text: "Default postage policy" },
  },
  // Marketplace support/runtime-support/seed.ts:190 creates this Pikachu listing exposed by the feed projection.
  "/growth/google-shopping": {
    witness: { kind: "populated", selector: "table tbody tr", text: "lst_seed_card_vault_pikachu_low_margin" },
  },
  // Identity seed.ts:418-429 creates and suspends this distinct account; cross-account audit requires platform admin.
  "/access/accounts/acc_seed_suspended_account?tab=audit": {
    witness: { kind: "populated", selector: '[role="tabpanel"]', text: "account · suspended" },
  },
  // Settlement support/runtime-support/seed.ts:502-513 creates the synthetic failed payout's $5 request less quoted fee ($4.73 net).
  "/commerce/money-health": { witness: { kind: "populated", selector: "table tbody tr", text: "$4.73" } },
  // The same synthetic failed payout's seeded net amount is rendered in its operations row.
  "/commerce/payout-operations": { witness: { kind: "populated", selector: "table tbody tr", text: "$4.73" } },
  // Settlement seed.ts:157 creates this ledger entry in the demo wallet.
  "/commerce/wallet-workbench/acc_seed_demo_account": {
    witness: {
      kind: "populated",
      selector: "table tbody tr",
      text: "Manual credit adjustment for seeded balance coverage",
    },
  },
  // Platform Operations seed.ts:271 creates this populated support queue row. Section home redirects to the queue.
  "/support": {
    resolvedPath: "/support/requests",
    witness: { kind: "populated", selector: "table tbody tr", text: "1/2 required" },
  },
  // Platform Operations seed.ts:158 creates this feedback comment, shown in the list row and detail panel.
  "/support/platform-feedback": {
    witness: { kind: "populated", selector: "table tbody tr", text: "Checkout payment" },
  },
  "/support/platform-feedback/pfb_seed_checkout": {
    witness: {
      kind: "populated",
      selector: '[data-card-emitter="detail-panel"]',
      text: "Checkout totals were clear before payment.",
    },
  },
  // reference-lookup.tsx:22-24 deliberately starts with no search/result; require its owning initial form.
  "/support/reference-lookup": { witness: { kind: "reference-lookup-form" } },
};

const tuples = renderedCopyTuples.filter((tuple) => tuple.deployable === "admin-web");

const catalogScopeKey = "/catalog/scopes/ref_seed_expansion_base_set";
async function requireSweepWitness(page: Page, key: string, witness: RenderedCopyWitness, timeout?: number) {
  if (key === catalogScopeKey) {
    const check = expect.configure({ timeout });
    const trigger = page.locator('[data-catalog-import-workflow-stage="run-sync"]');
    await check(trigger, `${key}: Run sync disclosure`).toBeVisible();
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    await check(trigger, `${key}: Run sync disclosure`).toHaveAttribute("aria-expanded", "true");
  }
  await requireWitness(page, key, witness, { timeout });
}

test("the admin sweep witnesses exactly its census tuples @admin-access", () => {
  expect(Object.keys(witnesses).sort()).toEqual(tuples.map((tuple) => tuple.page).sort());
  expect(tuples).toHaveLength(17);
});

for (const tuple of tuples) {
  const entry = witnesses[tuple.page]!;
  test(`rendered copy ${tuple.persona} ${tuple.page} ${tuple.tag} @browser-e2e-seed`, async ({ page }, info) => {
    const startedAt = Date.now();
    await (tuple.persona === "owner" ? authenticateAdmin : authenticatePlatformAdmin)(page, tuple.page);
    const response = await page.goto(tuple.page, { waitUntil: "domcontentloaded" });
    const annotation = {
      persona: tuple.persona,
      key: tuple.page,
      url: page.url(),
      witness: entry.witness,
      expectedState: entry.witness.kind === "reference-lookup-form" ? "initial-form" : "populated",
    };
    info.annotations.push({ type: "rendered-copy", description: JSON.stringify(annotation) });
    expect(response?.status(), `${tuple.page}: navigation HTTP status`).toBe(200);
    await expect(page, tuple.page).toHaveURL(new URL(entry.resolvedPath ?? tuple.page, info.project.use.baseURL).href);
    const heading = page.getByRole("heading", { level: 1 }).first();
    await expect(heading, tuple.page).toBeVisible();
    await expectAdminPageReady(page, { heading: await heading.innerText() });
    await requireSweepWitness(page, tuple.page, entry.witness);

    console.log(`RENDERED_COPY_WITNESS ${JSON.stringify(annotation)}`);
    await sweepRenderedCopy(page, tuple, { retry: info.retry, startedAt, witness: entry.witness.kind });
  });
}

const expectRenderedCopyWitness = (page: Page, key: string, witness: RenderedCopyWitness) =>
  requireSweepWitness(page, key, witness, 1);

test.describe("rendered-copy planted controls @admin-access", () => {
  const key = "/planted-copy-control";
  const row: RenderedCopyBaselineRow = {
    page: key,
    class: "seed-id",
    selector: "main",
    label: null,
    prefix: "ord_",
    token: "SB8-COPY-01",
    issue: 9937,
    maxCount: 1,
  };

  const catalogWitness = witnesses[catalogScopeKey]!.witness;
  const catalogScope = (expanded: boolean, text = "tcgdex / pokemon / ref_seed_series_base / Base Set") =>
    `<main><h1>Scope Detail</h1><button data-catalog-import-workflow-stage="run-sync" aria-expanded="${expanded}" onclick="this.setAttribute('aria-expanded', 'true'); document.querySelector('#sync').hidden = false; this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1)">Run sync</button><section id="sync" aria-labelledby="sync-title" ${expanded ? "" : "hidden"}><h2 id="sync-title">Catalog scope sync</h2><dl><dt>Scope</dt><dd>${text}</dd></dl></section></main>`;
  test("Catalog collapsed Run sync opens before the same seeded scope witness", async ({ page }) => {
    await page.setContent(catalogScope(false));
    await expectRenderedCopyWitness(page, catalogScopeKey, catalogWitness);
    await expect(page.locator('[data-catalog-import-workflow-stage="run-sync"]')).toHaveAttribute("data-clicks", "1");
  });
  test("Catalog open Run sync retains its seeded scope without another click", async ({ page }) => {
    await page.setContent(catalogScope(true));
    await expectRenderedCopyWitness(page, catalogScopeKey, catalogWitness);
    await expect(page.locator('[data-catalog-import-workflow-stage="run-sync"]')).not.toHaveAttribute("data-clicks");
  });
  test("Catalog missing seeded scope fails after exact disclosure activation", async ({ page }) => {
    await page.setContent(
      catalogScope(false, "A different scope").replace(
        "</main>",
        "<dl><dt>Unrelated scope</dt><dd>tcgdex / pokemon / ref_seed_series_base / Base Set</dd></dl></main>",
      ),
    );
    await expect(expectRenderedCopyWitness(page, catalogScopeKey, catalogWitness)).rejects.toThrow(catalogScopeKey);
    await expect(page.locator('[data-catalog-import-workflow-stage="run-sync"]')).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("unbaselined violation names page, class and text", async ({ page }) => {
    await page.setContent("<main><p>ord_seed_planted</p></main>");
    await expect(assertRenderedCopy(page, key, [])).rejects.toThrow(
      `${key} seed-id: unbaselined violation "ord_seed_planted"`,
    );
  });
  test("count above maxCount names page, class, text and field", async ({ page }) => {
    await page.setContent("<main><p>ord_seed_planted ord_seed_extra</p></main>");
    await expect(assertRenderedCopy(page, key, [row])).rejects.toThrow(
      `${key} seed-id: count 2 above maxCount 1; text "ord_seed_planted"; ${key} seed-id field selector="main"`,
    );
  });
  test("stale-low counts name every entry and instruct lowering or deleting them", async ({ page }) => {
    const instant: RenderedCopyBaselineRow = {
      ...row,
      class: "iso-instant",
      prefix: null,
      issue: 9938,
      token: "SB8-COPY-02",
    };
    await page.setContent("<main><p>Healthy copy</p></main>");
    const failure = assertRenderedCopy(page, key, [instant, row]);
    await expect(failure).rejects.toThrow(`${key}: stale-low entries; the fix has landed, so lower or delete each`);
    await expect(assertRenderedCopy(page, key, [instant, row])).rejects.toThrow(
      /issue 9938: count 0 below maxCount 1[\s\S]*issue 9937: count 0 below maxCount 1/,
    );
  });
  test("a selector-scoped owner cannot absorb a value outside its selector", async ({ page }) => {
    const scoped: RenderedCopyBaselineRow = { ...row, selector: "#owned" };
    await page.setContent('<main><p id="owned">ord_seed_owned</p><p>ord_seed_escape</p></main>');
    await expect(assertRenderedCopy(page, key, [scoped])).rejects.toThrow(
      `${key} seed-id: violation "ord_seed_escape" outside selector "#owned"`,
    );
  });
  test("populated-looking shell without its seeded witness fails readiness with page key", async ({ page }) => {
    await page.setContent("<main><h1>Listings</h1><section><p>Some other product</p></section></main>");
    await expect(
      expectRenderedCopyWitness(page, key, { kind: "populated", selector: "section", text: "Charizard" }),
    ).rejects.toThrow(`${key}: required populated witness`);
  });

  test("malformed baselines fail with the row and reason", () => {
    expect(
      validateRenderedCopyBaseline({ schema: "rendered-copy-baseline/v1", rows: [{ ...row, class: "unknown" }] }),
    ).toContain('rendered-copy-baseline.rows[0].class: unknown class "unknown"');
    expect(
      validateRenderedCopyBaseline({ schema: "rendered-copy-baseline/v1", rows: [{ ...row, maxCount: 0 }] }),
    ).toContain("rendered-copy-baseline.rows[0].maxCount: invalid maxCount");
    expect(
      validateRenderedCopyBaseline({ schema: "rendered-copy-baseline/v1", rows: [row, row] }).join("\n"),
    ).toContain("duplicate (page, class, issue)");
  });

  test("reference lookup requires its initial input and enabled submit in one form", async ({ page }) => {
    const form = '<form><input name="reference"><button type="submit">Look up</button></form>';
    await page.setContent(`<main>${form}</main>`);
    await expectRenderedCopyWitness(page, key, { kind: "reference-lookup-form" });
    for (const invalid of [
      form.replace('<input name="reference">', ""),
      form.replace('type="submit"', 'type="button"'),
      form.replace('type="submit"', 'type="submit" disabled'),
      form.replace('name="reference"', 'name="reference" value="ORD-RESULT"'),
    ]) {
      await page.setContent(`<main>${invalid}</main>`);
      await expect(expectRenderedCopyWitness(page, key, { kind: "reference-lookup-form" })).rejects.toThrow(key);
    }
  });

  const sellKey = "/account/sell-list";
  const empty =
    '<section><h2>Your Sell List is empty</h2><p>Add selected offers or products from item pages before reviewing seller checkout.</p><a href="/search">Browse products</a></section>';
  test("healthy Sell List empty state passes in its owning component", async ({ page }) => {
    await page.setContent(`<main><h1>Sell List</h1>${empty}</main>`);
    await expectRenderedCopyWitness(page, sellKey, { kind: "sell-list-empty" });
  });
  const invalidEmptyStates = [
    ["shell-only", "<h1>Sell List</h1>"],
    ["missing title", empty.replace("<h2>Your Sell List is empty</h2>", "")],
    [
      "missing description",
      empty.replace("<p>Add selected offers or products from item pages before reviewing seller checkout.</p>", ""),
    ],
    ["missing link", empty.replace('<a href="/search">Browse products</a>', "")],
    ["wrong link target", empty.replace('href="/search"', 'href="/sign-in"')],
    [
      "split component",
      '<section><h2>Your Sell List is empty</h2></section><section><p>Add selected offers or products from item pages before reviewing seller checkout.</p><a href="/search">Browse products</a></section>',
    ],
    ["pending-fresh-write", `${empty}<p>Your Sell List is catching up</p>`],
    ["missing-after-fresh-write", `${empty}<h2>Sell List line not visible yet</h2>`],
    ["unexpected populated rows", `${empty}<table><tbody><tr><td>Charizard</td></tr></tbody></table>`],
    ["unexpected checkout summary", `${empty}<aside aria-label="Sale checkout summary">Checkout</aside>`],
    ["unavailable", `${empty}<h2>Sell List unavailable</h2>`],
    ["not found", `${empty}<h2>Sell List not found</h2>`],
    ["access required", `${empty}<h2>Checkout access required</h2>`],
    ["error boundary", `${empty}<h1>Marketplace error</h1>`],
    ["loading", `${empty}<section aria-busy="true">Loading</section>`],
  ] as const;
  for (const [name, content] of invalidEmptyStates) {
    test(`Sell List ${name} fails with page key`, async ({ page }) => {
      await page.setContent(`<main>${content}</main>`);
      await expect(expectRenderedCopyWitness(page, sellKey, { kind: "sell-list-empty" })).rejects.toThrow(sellKey);
    });
  }
});
