import { expect, test } from "@playwright/test";
import {
  assertRenderedCopy,
  classifyRenderedCopy,
  readRenderedCopy,
  renderedCopyClasses,
  renderedCopyBaseline,
  expectRenderedCopyWitness,
  type RenderedCopyWitness,
} from "@chase-sets/playwright-evidence/rendered-copy";
import { signInWithPassword } from "./support/auth";
import { marketplaceBrowserE2eBuyerCredentials, marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

type SweepPage = Readonly<{ persona: "collector" | "demo"; key: string; witness: RenderedCopyWitness; root?: string }>;
const pages: readonly SweepPage[] = [
  // Fulfillment seed.ts:185 supplies the review-eligible tracking identifier; notification-intents.ts:125 renders it.
  {
    persona: "collector",
    key: "/account/notifications",
    witness: { kind: "populated", selector: "p", text: "Tracking identifier: 1ZSEEDREVIEWELIGIBLE." },
  },
  // Marketplace support/runtime-support/seed.ts:335 creates this submitted offer's item title.
  {
    persona: "collector",
    key: "/account/offers/submitted",
    witness: { kind: "populated", selector: "section", text: "Charizard" },
  },
  // Auth support/runtime-support/seed.ts:109 and Identity seed.ts:456 bind the collector session/account.
  {
    persona: "collector",
    key: "/account/sessions",
    witness: { kind: "populated", selector: "table tbody tr", text: "Collector Zero" },
  },
  // Platform Operations support/runtime-support/seed.ts:269-284 creates the not-received request with one of two required evidence items.
  {
    persona: "collector",
    key: "/account/support",
    witness: { kind: "populated", selector: "table tbody tr", text: "1/2 required" },
  },
  // Payments support/runtime-support/seed.ts:490,510 pins the payment method shown in the loaded payment summary.
  {
    persona: "collector",
    key: "/account/payments/pay_seed_checkout_pending",
    root: 'aside[aria-label="Payment Summary"]',
    witness: { kind: "populated", selector: "div", text: "card" },
  },
  {
    persona: "collector",
    key: "/account/payments/pay_seed_review_eligible_captured",
    root: 'aside[aria-label="Payment Summary"]',
    witness: { kind: "populated", selector: "div", text: "card" },
  },
  // Fulfillment support/runtime-support/seed.ts:185 pins this delivered tracking identifier.
  {
    persona: "collector",
    key: "/account/shipments/shp_seed_review_eligible",
    witness: { kind: "populated", selector: "section", text: "1ZSEEDREVIEWELIGIBLE" },
  },
  // Settlement support/runtime-support/seed.ts:213 creates this wallet ledger entry.
  {
    persona: "demo",
    key: "/account/desk/money",
    witness: { kind: "populated", selector: "table tbody tr", text: "Failed payout reversal" },
  },
  // Marketplace support/runtime-support/seed.ts:118 and Inventory seed.ts create the demo's Charizard listing.
  {
    persona: "demo",
    key: "/account/listings",
    witness: { kind: "populated", selector: "table tbody tr", text: "Charizard" },
  },
  // Checkout seed.ts:327-371 seeds no Sell List lines; sell-list-page.tsx:242-249 owns the healthy empty state.
  { persona: "demo", key: "/account/sell-list", witness: { kind: "sell-list-empty" } },
  // Fulfillment support/runtime-support/seed.ts:175 creates the exception card's tracking identifier.
  {
    persona: "demo",
    key: "/account/sales/shipments",
    witness: { kind: "populated", selector: '[data-elevation-role="entity"]', text: "Tracking 1ZSEEDEXCEPTION" },
  },
  // Ordering seed.ts:68's item title reaches the print document through Fulfillment's reference-order seed.
  {
    persona: "demo",
    key: "/account/sales/shipments/packing-slips?shipmentIds=shp_seed_awaiting_label",
    root: "body",
    witness: {
      kind: "populated",
      selector: "[data-packing-slip-page] table tbody tr",
      text: "Twilight Masquerade Elite Trainer Box",
    },
  },
  // The same Fulfillment reference-order seed supplies this detail's populated packing line.
  {
    persona: "demo",
    key: "/account/sales/shipments/shp_seed_awaiting_label",
    witness: {
      kind: "populated",
      selector: '[data-elevation-role="furniture"]',
      text: "Twilight Masquerade Elite Trainer Box",
    },
  },
  // Channels features/manual-sync/api/seed.ts:65 creates this sandbox TCGplayer connection.
  {
    persona: "demo",
    key: "/account/channels/connection-seed-tcgplayer-manual",
    witness: { kind: "populated", selector: "span", text: "sandbox" },
  },
  // Channels features/manual-sync/api/seed.ts:26 binds the publication to the seeded Charizard listing.
  {
    persona: "demo",
    key: "/account/channels/publication/connection-seed-tcgplayer-manual",
    witness: { kind: "populated", selector: "section", text: "lst_seed_charizard_base_set_nm" },
  },
];

for (const entry of pages) {
  const tag = entry.persona === "collector" ? "@marketplace-account" : "@marketplace-seller";
  test(`rendered copy ${entry.persona} ${entry.key} ${tag} @browser-e2e-seed`, async ({ page }, info) => {
    await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
    await signInWithPassword(
      page,
      new URL(page.url()).origin,
      entry.persona === "collector"
        ? marketplaceBrowserE2eBuyerCredentials()
        : marketplaceBrowserE2eSellerCredentials(),
    );
    const response = await page.goto(entry.key, { waitUntil: "domcontentloaded" });
    const annotation = {
      persona: entry.persona,
      key: entry.key,
      url: page.url(),
      witness: entry.witness,
      expectedState: entry.witness.kind === "sell-list-empty" ? "empty" : "populated",
    };
    info.annotations.push({ type: "rendered-copy", description: JSON.stringify(annotation) });
    expect(response?.status(), `${entry.key}: navigation HTTP status`).toBe(200);
    await expect(page, entry.key).toHaveURL(new URL(entry.key, info.project.use.baseURL).href);
    await expect(page.getByRole("heading", { level: 1 }).first(), entry.key).toBeVisible();
    await expectRenderedCopyWitness(page, entry.key, entry.witness, { root: entry.root });

    console.log(`RENDERED_COPY_WITNESS ${JSON.stringify(annotation)}`);
    await assertRenderedCopy(page, entry.key, renderedCopyBaseline);
  });
}

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
  const violations = classifyRenderedCopy(await readRenderedCopy(page));
  expect(violations).toHaveLength(6);
  expect(violations.map((violation) => violation.class)).toEqual(renderedCopyClasses);
  expect(violations.map((violation) => violation.text)).toEqual(samples);
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
    "<main><span>zzz_</span><span>01ARYZ6S41TSV4RRFFQ69G5FAV</span><code>ord_seed_excluded</code><p>ord_seed_visible</p></main>",
  );
  expect(classifyRenderedCopy(await readRenderedCopy(page))).toEqual([
    { class: "typed-id", text: "zzz_01ARYZ6S41TSV4RRFFQ69G5FAV" },
    { class: "seed-id", text: "ord_seed_visible" },
  ]);
});
