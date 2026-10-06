import { expect, test, type Page } from "@playwright/test";
import {
  assertRenderedCopy,
  renderedCopyBaseline,
  renderedCopyClasses,
  expectRenderedCopyWitness as requireWitness,
  type RenderedCopyWitness,
  type RenderedCopyBaselineEntry,
} from "@chase-sets/playwright-evidence/rendered-copy";
import { authenticateAdmin, authenticatePlatformAdmin, expectAdminPageReady } from "./support/admin-e2e";

type SweepPage = Readonly<{
  persona: "owner" | "platform-admin";
  tag: string;
  key: string;
  witness: RenderedCopyWitness;
  resolvedPath?: string;
}>;
const pages: readonly SweepPage[] = [
  // Identity support/runtime-support/seed.ts:444 creates this account's audit event.
  {
    persona: "owner",
    tag: "@admin-access",
    key: "/access/accounts/acc_seed_demo_account?tab=audit",
    witness: { kind: "populated", selector: '[role="tabpanel"]', text: "account · created" },
  },
  // Auth seed.ts:86 and Identity seed.ts:446 bind the seeded demo session's account name.
  {
    persona: "owner",
    tag: "@admin-access",
    key: "/access/sessions",
    witness: { kind: "populated", selector: "table tbody tr", text: "Chase Sets" },
  },
  // Catalog features/dimensions/api/seed.ts:107 supplies a populated option, not the page heading.
  {
    persona: "owner",
    tag: "@catalog-admin-modeling",
    key: "/catalog/dimensions/dim_seed_condition",
    witness: { kind: "populated", selector: "table tbody tr", text: "Near Mint" },
  },
  // Catalog features/display-templates/api/seed.ts:19 names this seeded template.
  {
    persona: "owner",
    tag: "@catalog-admin-modeling",
    key: "/catalog/display-templates",
    witness: { kind: "populated", selector: "table tbody tr", text: "Pokemon single card" },
  },
  // Catalog support/authoring-support/seed.ts:173 seeds the TCGdex provider integration profile.
  {
    persona: "owner",
    tag: "@catalog-admin-integrations",
    key: "/catalog/integrations",
    witness: { kind: "populated", selector: "table tbody tr", text: "TCGdex" },
  },
  // Catalog features/reference-data/api/seed.ts:263 creates this expansion record.
  {
    persona: "owner",
    tag: "@catalog-admin-integrations",
    key: "/catalog/scopes/ref_seed_expansion_base_set",
    witness: { kind: "populated", selector: "dl", text: "tcgdex / pokemon / ref_seed_series_base / Base Set" },
  },
  // Catalog source-observations/api/seeding/seed.ts:136-160 creates this observation from its base2-60 scenario fixture.
  {
    persona: "owner",
    tag: "@catalog-admin-integrations",
    key: "/catalog/source-observations/tcgdex_en_base2_60",
    witness: { kind: "populated", selector: "dl", text: "base2-60" },
  },
  // Ordering support/runtime-support/seed.ts:298 creates this policy label.
  {
    persona: "owner",
    tag: "@admin-commerce",
    key: "/commerce/postage-policies",
    witness: { kind: "populated", selector: "table tbody tr", text: "Default postage policy" },
  },
  // Marketplace support/runtime-support/seed.ts:190 creates this Pikachu listing exposed by the feed projection.
  {
    persona: "owner",
    tag: "@admin-growth",
    key: "/growth/google-shopping",
    witness: { kind: "populated", selector: "table tbody tr", text: "lst_seed_card_vault_pikachu_low_margin" },
  },
  // Identity seed.ts:471-482 creates and suspends this distinct account; cross-account audit requires platform admin.
  {
    persona: "platform-admin",
    tag: "@admin-access",
    key: "/access/accounts/acc_seed_suspended_account?tab=audit",
    witness: { kind: "populated", selector: '[role="tabpanel"]', text: "account · suspended" },
  },
  // Settlement support/runtime-support/seed.ts:502-513 creates the synthetic failed payout's $5 request less quoted fee ($4.73 net).
  {
    persona: "platform-admin",
    tag: "@admin-commerce",
    key: "/commerce/money-health",
    witness: { kind: "populated", selector: "table tbody tr", text: "$4.73" },
  },
  // The same synthetic failed payout's seeded net amount is rendered in its operations row.
  {
    persona: "platform-admin",
    tag: "@admin-commerce",
    key: "/commerce/payout-operations",
    witness: { kind: "populated", selector: "table tbody tr", text: "$4.73" },
  },
  // Settlement seed.ts:157 creates this ledger entry in the demo wallet.
  {
    persona: "platform-admin",
    tag: "@admin-commerce",
    key: "/commerce/wallet-workbench/acc_seed_demo_account",
    witness: {
      kind: "populated",
      selector: "table tbody tr",
      text: "Manual credit adjustment for seeded balance coverage",
    },
  },
  // Platform Operations seed.ts:270 creates this populated support queue row. Section home redirects to the queue.
  {
    persona: "platform-admin",
    tag: "@admin-support",
    key: "/support",
    resolvedPath: "/support/requests",
    witness: { kind: "populated", selector: "table tbody tr", text: "1/2 required" },
  },
  // Platform Operations seed.ts:157 creates this feedback comment, shown in the list row and detail panel.
  {
    persona: "platform-admin",
    tag: "@admin-support",
    key: "/support/platform-feedback",
    witness: { kind: "populated", selector: "table tbody tr", text: "Checkout payment" },
  },
  {
    persona: "platform-admin",
    tag: "@admin-support",
    key: "/support/platform-feedback/pfb_seed_checkout",
    witness: {
      kind: "populated",
      selector: '[data-card-emitter="detail-panel"]',
      text: "Checkout totals were clear before payment.",
    },
  },
  // reference-lookup.tsx:22-24 deliberately starts with no search/result; require its owning initial form.
  {
    persona: "platform-admin",
    tag: "@admin-support",
    key: "/support/reference-lookup",
    witness: { kind: "reference-lookup-form" },
  },
];

for (const entry of pages) {
  test(`rendered copy ${entry.persona} ${entry.key} ${entry.tag} @browser-e2e-seed`, async ({ page }, info) => {
    await (entry.persona === "owner" ? authenticateAdmin : authenticatePlatformAdmin)(page, entry.key);
    const response = await page.goto(entry.key, { waitUntil: "domcontentloaded" });
    const annotation = {
      persona: entry.persona,
      key: entry.key,
      url: page.url(),
      witness: entry.witness,
      expectedState: entry.witness.kind === "reference-lookup-form" ? "initial-form" : "populated",
    };
    info.annotations.push({ type: "rendered-copy", description: JSON.stringify(annotation) });
    expect(response?.status(), `${entry.key}: navigation HTTP status`).toBe(200);
    await expect(page, entry.key).toHaveURL(new URL(entry.resolvedPath ?? entry.key, info.project.use.baseURL).href);
    const heading = page.getByRole("heading", { level: 1 }).first();
    await expect(heading, entry.key).toBeVisible();
    await expectAdminPageReady(page, { heading: await heading.innerText() });
    await requireWitness(page, entry.key, entry.witness);

    console.log(`RENDERED_COPY_WITNESS ${JSON.stringify(annotation)}`);
    await assertRenderedCopy(page, entry.key, renderedCopyBaseline);
  });
}

const expectRenderedCopyWitness = (page: Page, key: string, witness: RenderedCopyWitness) =>
  requireWitness(page, key, witness, { timeout: 1 });

test.describe("rendered-copy planted controls @admin-access", () => {
  const key = "/planted-copy-control";
  const allowance: readonly RenderedCopyBaselineEntry[] = [{ page: key, class: "seed-id", maxCount: 1, issue: 8720 }];

  test("baseline entries are parsed, sorted by page and class, and unique", () => {
    const keys = renderedCopyBaseline.map((entry) => JSON.stringify([entry.page, entry.class]));
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of renderedCopyBaseline) {
      expect(renderedCopyClasses).toContain(entry.class);
      expect(Number.isSafeInteger(entry.maxCount) && entry.maxCount > 0).toBe(true);
      expect(Object.keys(entry).sort()).toEqual(
        ("issue" in entry
          ? ["page", "class", "maxCount", "issue"]
          : ["page", "class", "selector", "maxCount", "intentional"]
        ).sort(),
      );
      if ("issue" in entry) expect(Number.isSafeInteger(entry.issue) && entry.issue > 0).toBe(true);
      else {
        expect(entry.selector.trim()).not.toBe("");
        expect(entry.intentional.trim()).not.toBe("");
      }
    }
  });

  test("unbaselined violation names page, class and text", async ({ page }) => {
    await page.setContent("<main><p>ord_seed_planted</p></main>");
    await expect(assertRenderedCopy(page, key, [])).rejects.toThrow(
      `${key} seed-id: unbaselined violation "ord_seed_planted"`,
    );
  });
  test("count above maxCount names page, class, text and entry", async ({ page }) => {
    await page.setContent("<main><p>ord_seed_planted ord_seed_extra</p></main>");
    await expect(assertRenderedCopy(page, key, allowance)).rejects.toThrow(
      `${key} seed-id: count 2 above maxCount 1; text "ord_seed_planted"; entry`,
    );
  });
  test("stale low count instructs lowering or deleting the named entry", async ({ page }) => {
    await page.setContent("<main><p>Healthy copy</p></main>");
    await expect(assertRenderedCopy(page, key, allowance)).rejects.toThrow(
      `${key} seed-id: count 0 below maxCount 1; the fix has landed, so lower or delete entry`,
    );
  });
  test("intentional allowance cannot escape its reviewed selector", async ({ page }) => {
    const intentional: readonly RenderedCopyBaselineEntry[] = [
      {
        page: key,
        class: "seed-id",
        selector: "#intentional-policy",
        maxCount: 1,
        intentional: "Copyable policy identity.",
      },
    ];
    await page.setContent('<main><p id="intentional-policy">pol_seed_policy</p></main>');
    await assertRenderedCopy(page, key, intentional);
    await page.setContent('<main><p id="intentional-policy">Human name</p><p>ord_seed_escape</p></main>');
    await expect(assertRenderedCopy(page, key, intentional)).rejects.toThrow(
      `${key} seed-id: violation "ord_seed_escape" outside intentional selector "#intentional-policy"`,
    );
  });
  test("populated-looking shell without its seeded witness fails readiness with page key", async ({ page }) => {
    await page.setContent("<main><h1>Listings</h1><section><p>Some other product</p></section></main>");
    await expect(
      expectRenderedCopyWitness(page, key, { kind: "populated", selector: "section", text: "Charizard" }),
    ).rejects.toThrow(`${key}: required populated witness`);
  });

  test("malformed baseline entries fail with the page and entry", async ({ page }) => {
    await page.setContent("<main><p>ord_seed_planted</p></main>");
    await expect(assertRenderedCopy(page, key, [{ ...allowance[0]!, class: "unknown" }])).rejects.toThrow(
      `${key} unknown: unknown baseline class`,
    );
    await expect(assertRenderedCopy(page, key, [{ ...allowance[0]!, maxCount: 0 }])).rejects.toThrow(
      `${key} seed-id: invalid maxCount`,
    );
    await expect(assertRenderedCopy(page, key, [...allowance, ...allowance])).rejects.toThrow(
      `${key} seed-id: duplicate baseline entries`,
    );
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
