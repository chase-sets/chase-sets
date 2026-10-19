import { expect, test, type Page } from "@playwright/test";
import {
  classifyRenderedCopy,
  expectRenderedCopyWitness,
  readRenderedCopyOccurrences,
  renderedCopyClasses,
  renderedCopyTuples,
  sweepRenderedCopy,
  type RenderedCopyWitness,
} from "@chase-sets/playwright-evidence/rendered-copy";
import { signInWithPassword } from "./support/auth";
import { marketplaceBrowserE2eBuyerCredentials, marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

type SweepWitness = Readonly<{ witness: RenderedCopyWitness; root?: string }>;
const witnesses: Readonly<Record<string, SweepWitness>> = {
  // Fulfillment seed.ts:185 supplies the review-eligible tracking identifier; notification-intents.ts:130 renders it.
  "/account/notifications": {
    witness: { kind: "populated", selector: "p", text: "Tracking identifier: 1ZSEEDREVIEWELIGIBLE." },
  },
  // Marketplace support/runtime-support/seed.ts:335 creates this submitted offer's item title.
  "/account/offers/submitted": { witness: { kind: "populated", selector: "section", text: "Charizard" } },
  // Auth support/runtime-support/seed.ts:109 and Identity seed.ts:456 bind the collector session/account.
  "/account/sessions": { witness: { kind: "populated", selector: "table tbody tr", text: "Collector Zero" } },
  // Platform Operations support/runtime-support/seed.ts:270-285 creates the not-received request with one of two required evidence items.
  "/account/support": { witness: { kind: "populated", selector: "table tbody tr", text: "1/2 required" } },
  // Payments support/runtime-support/seed.ts:490,510 pins the payment method shown in the loaded payment summary.
  "/account/payments/pay_seed_checkout_pending": {
    root: 'aside[aria-label="Payment Summary"]',
    witness: { kind: "populated", selector: "div", text: "card" },
  },
  "/account/payments/pay_seed_review_eligible_captured": {
    root: 'aside[aria-label="Payment Summary"]',
    witness: { kind: "populated", selector: "div", text: "card" },
  },
  // Fulfillment support/runtime-support/seed.ts:185 pins this delivered tracking identifier.
  "/account/shipments/shp_seed_review_eligible": {
    witness: { kind: "populated", selector: "section", text: "1ZSEEDREVIEWELIGIBLE" },
  },
  // Settlement support/runtime-support/seed.ts:213 creates this wallet ledger entry.
  "/account/desk/money": { witness: { kind: "populated", selector: "table tbody tr", text: "Failed payout reversal" } },
  // Marketplace support/runtime-support/seed.ts:118 and Inventory seed.ts create the demo's Charizard listing.
  "/account/listings": { witness: { kind: "populated", selector: "table tbody tr", text: "Charizard" } },
  // Checkout seed.ts:327-371 seeds no Sell List lines; sell-list-page.tsx:243-250 owns the healthy empty state.
  "/account/sell-list": { witness: { kind: "sell-list-empty" } },
  // Fulfillment support/runtime-support/seed.ts:175 creates the exception card's tracking identifier.
  "/account/sales/shipments": {
    witness: { kind: "populated", selector: '[data-elevation-role="entity"]', text: "Tracking 1ZSEEDEXCEPTION" },
  },
  // Ordering seed.ts:68's item title reaches the print document through Fulfillment's reference-order seed.
  "/account/sales/shipments/packing-slips?shipmentIds=shp_seed_awaiting_label": {
    root: "body",
    witness: {
      kind: "populated",
      selector: "[data-packing-slip-page] table tbody tr",
      text: "Twilight Masquerade Elite Trainer Box",
    },
  },
  // The same Fulfillment reference-order seed supplies this detail's populated packing line.
  "/account/sales/shipments/shp_seed_awaiting_label": {
    witness: {
      kind: "populated",
      selector: '[data-elevation-role="furniture"]',
      text: "Twilight Masquerade Elite Trainer Box",
    },
  },
  // Channels features/manual-sync/api/seed.ts:65 creates this sandbox TCGplayer connection.
  "/account/channels/connection-seed-tcgplayer-manual": {
    witness: { kind: "populated", selector: "span", text: "sandbox" },
  },
  // Channels features/manual-sync/api/seed.ts:26 binds the publication to the seeded Charizard listing.
  "/account/channels/publication/connection-seed-tcgplayer-manual": {
    witness: { kind: "populated", selector: "section", text: "lst_seed_charizard_base_set_nm" },
  },
};

const tuples = renderedCopyTuples.filter((tuple) => tuple.deployable === "marketplace");

const channelConnectionKey = "/account/channels/connection-seed-tcgplayer-manual";
async function requirePublicationActivity(page: Page, key: string, timeout?: number) {
  const check = expect.configure({ timeout });
  const main = page.locator("main");
  const label = `${key}: required loaded Publication activity seeded row`;
  await check(main.getByText("Publication activity is unavailable", { exact: true }), label).toHaveCount(0);
  const log = main.locator('[data-channels-outbound-operation-log="true"]');
  await check(log, label).toHaveCount(1);
  await check(log, label).toBeVisible();
  // Channels features/manual-sync/api/seed.ts:23-28,108 seeds this operation's listing.
  await check(
    log.locator("table tbody tr").getByText("lst_seed_charizard_base_set_nm", { exact: true }),
    label,
  ).toBeVisible();
}

test("the marketplace sweep witnesses exactly its census tuples @marketplace-account", () => {
  expect(Object.keys(witnesses).sort()).toEqual(tuples.map((tuple) => tuple.page).sort());
  expect(tuples).toHaveLength(15);
});

for (const tuple of tuples) {
  const entry = witnesses[tuple.page]!;
  test(`rendered copy ${tuple.persona} ${tuple.page} @rendered-copy @browser-e2e-seed`, async ({ page }, info) => {
    const startedAt = Date.now();
    await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
    await signInWithPassword(
      page,
      new URL(page.url()).origin,
      tuple.persona === "collector"
        ? marketplaceBrowserE2eBuyerCredentials()
        : marketplaceBrowserE2eSellerCredentials(),
    );
    const response = await page.goto(tuple.page, { waitUntil: "domcontentloaded" });
    const annotation = {
      persona: tuple.persona,
      key: tuple.page,
      url: page.url(),
      witness: entry.witness,
      expectedState: entry.witness.kind === "sell-list-empty" ? "empty" : "populated",
    };
    info.annotations.push({ type: "rendered-copy", description: JSON.stringify(annotation) });
    expect(response?.status(), `${tuple.page}: navigation HTTP status`).toBe(200);
    await expect(page, tuple.page).toHaveURL(new URL(tuple.page, info.project.use.baseURL).href);
    await expect(page.getByRole("heading", { level: 1 }).first(), tuple.page).toBeVisible();
    await expectRenderedCopyWitness(page, tuple.page, entry.witness, { root: entry.root });
    if (tuple.page === channelConnectionKey) await requirePublicationActivity(page, tuple.page);

    console.log(`RENDERED_COPY_WITNESS ${JSON.stringify(annotation)}`);
    await sweepRenderedCopy(page, tuple, { retry: info.retry, startedAt, witness: entry.witness.kind });
  });
}

test.describe("rendered-copy Channel planted controls @marketplace-seller", () => {
  const loaded =
    '<section data-channels-outbound-operation-log="true"><h2>Publication activity</h2><table><tbody><tr><td>lst_seed_charizard_base_set_nm</td></tr></tbody></table></section>';
  test("loaded Publication activity requires the exact seeded listing row", async ({ page }) => {
    await page.setContent(`<main><h1>Channel connection</h1><span>sandbox</span>${loaded}</main>`);
    await requirePublicationActivity(page, channelConnectionKey, 1);
  });
  for (const [name, content] of [
    ["read-error", "<section><h2>Publication activity</h2><h3>Publication activity is unavailable</h3></section>"],
    ["missing component", ""],
    ["empty component", loaded.replace("<tr><td>lst_seed_charizard_base_set_nm</td></tr>", "")],
    ["missing seeded row", loaded.replace("lst_seed_charizard_base_set_nm", "lst_seed_other")],
  ]) {
    test(`Channel ${name} rejects an otherwise healthy sandbox page before classification`, async ({ page }) => {
      await page.setContent(`<main><h1>Channel connection</h1><span>sandbox</span>${content}</main>`);
      await expect(page.getByText("sandbox", { exact: true })).toBeVisible();
      await expect(requirePublicationActivity(page, channelConnectionKey, 1)).rejects.toThrow(channelConnectionKey);
    });
  }
});

test("six rendered-copy classes exclude code, pre and raw-identifier containers @marketplace-account", async ({
  page,
}) => {
  const samples = [
    "xyz_01ARYZ6S41TSV4RRFFQ69G5FAV",
    "ord_seed_planted",
    "[object Object]",
    "{quantity}",
    "item(s)",
    "2026-05-04T15:00",
  ];
  const excludedText = samples.join(" ");
  await page.setContent(
    `<main>${samples.map((text) => `<p>${text}</p>`).join("")}<code>${excludedText}</code><pre style="color: red">${excludedText}</pre><span data-raw-identifier>${excludedText}</span><p style="display:none">${excludedText}</p></main>`,
  );
  const { counts, occurrences } = await readRenderedCopyOccurrences(page, []);
  console.log(
    `RENDERED_COPY_PLANTED violations=${occurrences.length} classes=${occurrences.map((entry) => entry.class).join(",")}`,
  );
  expect(occurrences).toHaveLength(6);
  expect(occurrences.map((occurrence) => occurrence.class)).toEqual(renderedCopyClasses);
  expect(occurrences.map((occurrence) => occurrence.text)).toEqual(samples);
  expect(Object.values(counts)).toEqual([1, 1, 1, 1, 1, 1]);
  await expect(page.locator("code")).not.toHaveAttribute("style");
  await expect(page.locator("pre")).toHaveAttribute("style", "color: red");
});

test("whole tokens and inline node boundaries retain shape-based classification @marketplace-account", async ({
  page,
}) => {
  expect(classifyRenderedCopy("NaN undefined [object Object]").map((violation) => violation.class)).toEqual([
    "object-string",
    "object-string",
    "object-string",
  ]);
  expect(classifyRenderedCopy("NaNoseconds undefinedBehavior pre[object Object]post {field.name} items")).toEqual([]);
  await page.setContent(
    "<main><p><span>zzz_</span><span>01ARYZ6S41TSV4RRFFQ69G5FAV</span></p><code>ord_seed_excluded</code><p>ord_seed_visible</p></main>",
  );
  const { occurrences } = await readRenderedCopyOccurrences(page, []);
  expect(occurrences.map(({ class: kind, text, path }) => ({ kind, text, path }))).toEqual([
    { kind: "typed-id", text: "zzz_01ARYZ6S41TSV4RRFFQ69G5FAV", path: "body > main > p:nth-of-type(1)" },
    { kind: "seed-id", text: "ord_seed_visible", path: "body > main > p:nth-of-type(2)" },
  ]);
});
