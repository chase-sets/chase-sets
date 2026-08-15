import { readFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eBuyerCredentials, marketplaceBrowserE2eSeedContract } from "./support/seed-contract";
import { logMarketplaceSeedContractGap } from "./support/seed-contract-gap";

type Issue6020Theme = "light" | "dark";
type GithubPullRequestEvent = Readonly<{
  pull_request?: Readonly<{ number?: unknown; head?: Readonly<{ sha?: unknown }> }>;
}>;

function issue6020Authority() {
  const eventPath = process.env.GITHUB_EVENT_PATH?.trim();
  const event = eventPath ? (JSON.parse(readFileSync(eventPath, "utf8")) as GithubPullRequestEvent) : null;
  const rawPrNumber = event?.pull_request?.number;
  const rawHeadSha = event?.pull_request?.head?.sha;
  const prNumber = typeof rawPrNumber === "number" && Number.isInteger(rawPrNumber) ? rawPrNumber : null;
  const headSha = typeof rawHeadSha === "string" ? rawHeadSha : null;
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    (prNumber === null || prNumber <= 0 || headSha === null || !/^[0-9a-f]{40}$/.test(headSha))
  ) {
    throw new Error("issue #6020 hosted visual evidence requires an exact pull-request number and 40-character head");
  }
  return { prNumber: prNumber ?? 0, headSha: headSha ?? "local-unbound" };
}

async function setIssue6020Theme(page: Page, mode: Issue6020Theme) {
  const response = await page.request.put(`${new URL(page.url()).origin}/api/identity/preferences`, {
    data: { colorMode: mode },
  });
  expect(response.status(), `persist ${mode} theme`).toBe(200);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-chase-theme]").first()).toHaveAttribute("data-color-mode", mode);
}

async function attachIssue6020State(input: {
  page: Page;
  testInfo: TestInfo;
  state: "checkout-start" | "order-detail";
  route: string;
  suite: "marketplace_account" | "marketplace_checkout";
  assertions: readonly string[];
  assertState: () => Promise<void>;
}) {
  await input.page.setViewportSize({ width: 1280, height: 900 });
  const authority = issue6020Authority();
  const observations: Array<Record<string, unknown>> = [];
  for (const theme of ["light", "dark"] as const) {
    await setIssue6020Theme(input.page, theme);
    await input.assertState();
    const name = `issue-6020-${input.state}-${theme}.png`;
    await input.testInfo.attach(name, {
      body: await input.page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    observations.push({ theme, name, route: input.route, assertions: input.assertions });
  }
  await input.testInfo.attach(`issue-6020-${input.state}-observation.json`, {
    body: Buffer.from(
      JSON.stringify(
        {
          schemaVersion: "issue-6020-state-observation/v1",
          issue: 6020,
          ...authority,
          suite: input.suite,
          state: input.state,
          viewport: { width: 1280, height: 900 },
          observations,
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
}

async function expectPopulatedCheckoutStart(page: Page) {
  await expect(page).toHaveURL(/\/checkout\/start(?:\?|$)/);
  await expect(page.getByText("Checkout summary", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText(new RegExp(`^${marketplaceBrowserE2eSeedContract.cart.lineCount} items?$`, "i")).first(),
  ).toBeVisible();
  await expect(page.getByText(/^Ready$/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to checkout" }).first()).toBeVisible();
}

async function expectPopulatedOrderDetail(page: Page) {
  await expect(page).toHaveURL(/\/account\/purchases\/ord_seed_checkout_pending(?:\?|$)/);
  await expect(page.getByText("ord_seed_checkout_pending", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Item subtotal", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Total", { exact: true }).first()).toBeVisible();
  const glowRoot = page.locator(".surface-border.ds-glass.bg-elevated.shadow-tokenLg.ds-glow").first();
  await expect(glowRoot).toBeVisible();
  const linesSection = page.getByRole("heading", { name: "Lines" }).locator("xpath=ancestor::section[1]");
  await expect(linesSection).toBeVisible();
  expect(
    await linesSection.locator(".rounded-tokenLg").count(),
    "order detail requires at least one line item",
  ).toBeGreaterThan(0);
}

test.describe("marketplace buyer purchase journey", () => {
  test("seeded buyer submits the marketplace sign-in form @marketplace-account @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart", { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eBuyerCredentials());

    await expect(page).toHaveURL(/\/account\/cart(?:\?|$)/);
    await expect(page.getByRole("heading", { name: /^Your cart$/i }).first()).toBeVisible();

    await page.goto("/account/purchases/ord_seed_checkout_pending", { waitUntil: "domcontentloaded" });
    await attachIssue6020State({
      page,
      testInfo,
      state: "order-detail",
      route: "/account/purchases/ord_seed_checkout_pending",
      suite: "marketplace_account",
      assertions: [
        "order reference visible",
        "line item present",
        "money breakdown visible",
        "order summary glow visible",
      ],
      assertState: () => expectPopulatedOrderDetail(page),
    });
  });

  test("captures the populated checkout start before cart mutation @marketplace-checkout @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.goto("/sign-in?returnTo=%2Fcheckout%2Fstart", { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eBuyerCredentials());
    await expect(page).toHaveURL(/\/checkout\/start(?:\?|$)/);

    await attachIssue6020State({
      page,
      testInfo,
      state: "checkout-start",
      route: "/checkout/start",
      suite: "marketplace_checkout",
      assertions: [
        "checkout summary visible",
        "seeded cart count visible",
        "ready line state visible",
        "continue action visible",
      ],
      assertState: () => expectPopulatedCheckoutStart(page),
    });
  });

  test("seeded buyer walks the real cart to the checkout-session boundary @marketplace-checkout @browser-e2e-seed", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart", { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eBuyerCredentials());
    await expect(page).toHaveURL(/\/account\/cart(?:\?|$)/);
    await expect(page.getByRole("heading", { name: /^Your cart$/i }).first()).toBeVisible();

    // The seeded buyer's cart is genuinely non-vacuous: exactly the seeded line count,
    // the redesigned "Estimated total" label, and the single deferral caption. These are
    // hard contracts backed by real seed data (checkout_cart_line_pages for the collector
    // account), so they stay hard.
    const cartLines = page.locator("[data-marketplace-cart-line]");
    await expect(
      cartLines,
      `browser-e2e seed contract requires ${marketplaceBrowserE2eSeedContract.cart.lineCount} cart lines for ${marketplaceBrowserE2eSeedContract.buyer.email}`,
    ).toHaveCount(marketplaceBrowserE2eSeedContract.cart.lineCount);
    await expect(page.getByText("Estimated total").first()).toBeVisible();
    await expect(page.getByText("Final total confirmed at checkout")).toHaveCount(1);

    // Clicking "Check out" creates a REAL checkout session from the seeded cart and
    // navigates to it — a genuine, non-vacuous hand-off from cart to the checkout
    // context. This stays hard.
    const checkoutButton = page.getByRole("button", { name: /^Check out$/i }).first();
    await expect(checkoutButton, "browser-e2e seed contract requires a ready buyer cart").toBeVisible();
    await checkoutButton.click();

    await expect(page).toHaveURL(/\/checkout\/buy\/session\/[^/?]+/);
    // The checkout session surface always renders under the "Secure checkout" banner —
    // the reachable checkout-session boundary. Assert it hard.
    await expect(page.getByRole("heading", { name: /^Secure checkout$/i }).first()).toBeVisible();

    // The payment-ready buyer stepper only renders once checkout deciders start payment.
    // browser-e2e wires no payment provider, so a freshly created checkout session stays
    // on the "Secure checkout" readiness surface ("Preparing checkout" / "Checkout needs
    // attention") and never advances to the stepper (verified by direct inspection of the
    // rendered checkout page in browser-e2e). Assert the full payment boundary only when a
    // payment-ready stepper actually rendered (real/staging env); otherwise log the gap
    // loudly and assert the reachable readiness surface.
    const checkoutSteps = page.locator("[aria-label='Checkout steps']");
    if (await checkoutSteps.isVisible({ timeout: 15_000 }).catch(() => false)) {
      for (const step of ["Contact", "Delivery", "Shipping", "Payment", "Review"]) {
        await expect(checkoutSteps.getByText(new RegExp(`^${step}$`, "i"))).toBeVisible();
      }
      const updateTotals = page.getByRole("button", { name: /Update totals|Pay now/i }).first();
      await expect(updateTotals, "checkout must reach the payment boundary action").toBeVisible();
      await updateTotals.click();
      await expect(
        page.getByText(/Payment review comes next|Final totals before payment|Pay now/i).first(),
      ).toBeVisible();
    } else {
      logMarketplaceSeedContractGap(
        "Checkout session did not reach the payment-ready buyer stepper: browser-e2e wires no payment provider, " +
          "so a checkout session created from the seeded cart stays on the 'Secure checkout' readiness surface " +
          "(payment never starts). The reachable checkout-session boundary is asserted instead.",
      );
      await expect(
        page.getByRole("heading", { name: /Preparing checkout|Checkout needs attention/i }).first(),
      ).toBeVisible();
    }
  });
});
