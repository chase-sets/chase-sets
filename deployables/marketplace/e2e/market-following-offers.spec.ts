import { expect, test } from "@playwright/test";
import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { seedSyntheticOfferMarketPrice } from "../../../bounded-contexts/pricing/support/runtime-support/seed";
import { signInWithPassword } from "./support/auth";
import {
  marketplaceBrowserE2eBuyerCredentials,
  marketplaceBrowserE2eSellerCredentials,
  marketplaceBrowserE2eSeedContract,
} from "./support/seed-contract";

test("market-following consent, held evidence and permanent stop @marketplace-account @browser-e2e-seed", async ({
  page,
  browser,
}, testInfo) => {
  const fixture = marketplaceBrowserE2eSeedContract.marketFollowing;
  const catalogDatabaseUrl: unknown = testInfo.config.metadata.catalogDatabaseUrl;
  if (typeof catalogDatabaseUrl !== "string") throw new Error("The owned E2E database target is required.");
  const databaseUrl = new URL(catalogDatabaseUrl);
  if (
    !/^\/cs_[a-z0-9_]+_catalog$/.test(databaseUrl.pathname) ||
    !["localhost", "127.0.0.1"].includes(databaseUrl.hostname)
  )
    throw new Error("Synthetic estimate requires the owned local E2E database.");
  // sandbox.mjs names every context database cs_<sandbox-id>_<context>.
  databaseUrl.pathname = databaseUrl.pathname.replace(/_catalog$/, "_pricing");
  const pool = createPgPool(databaseUrl.toString(), { max: 1 });
  let removeEstimate: (() => Promise<void>) | undefined;
  let policyId: string | undefined;
  const authorizations: unknown[] = [];
  try {
    removeEstimate = await seedSyntheticOfferMarketPrice(pool, fixture);
    const credentials = marketplaceBrowserE2eBuyerCredentials();
    await signInWithPassword(page, String(testInfo.project.use.baseURL), credentials);
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/account/offers/submitted")) {
        const fields = new URLSearchParams(request.postData() ?? "");
        policyId = fields.get("policyId") ?? policyId;
        const command = fields.get("command");
        if (command && JSON.parse(command).type === "AuthorizeBuyerOfferPolicy")
          authorizations.push(JSON.parse(command));
      }
    });
    await page.goto("/account/offers/submitted");
    await page.getByRole("switch", { name: "Follow the market for selected Offers" }).click();
    await page.getByRole("checkbox", { name: `Select Surging Sparks Booster Box (${fixture.offerId})` }).check();
    await page.getByRole("checkbox", { name: `Select Pikachu (${fixture.heldOfferId})` }).check();
    await page.getByLabel("Maximum unit item amount: Surging Sparks Booster Box").fill("140.00");
    await page.getByLabel("Lifetime Item Commitment Allowance", { exact: false }).fill("400.00");
    const advanced = page.getByRole("button", { name: "Advanced adjustment" });
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await advanced.focus();
    await page.keyboard.press("Enter");
    await expect(advanced).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByLabel("Market Price adjustment (%)", { exact: true })).toHaveValue("0");
    await advanced.click();
    await page.getByRole("button", { name: "Preview selected Offers" }).click();
    await expect(page.getByText("Review exact Offer authority")).toBeVisible();
    await expect(page.getByText(/Market Price:.*130.00.*Estimate version: 8346001/)).toBeVisible();
    await expect(page.getByText("Proposed unit item amount: $130.00")).toBeVisible();
    await expect(page.getByText("Held: a Market Price is not available for this Product yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Authorize reviewed Offers" })).toBeDisabled();
    for (const [width, height] of [
      [360, 800],
      [390, 844],
      [768, 1024],
      [1440, 1000],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      await page.getByLabel("Lifetime Item Commitment Allowance", { exact: false }).scrollIntoViewIfNeeded();
      await expect(page.getByLabel("Lifetime Item Commitment Allowance", { exact: false })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`market-following-review-${width}.png`), fullPage: true });
    }
    await page.getByRole("checkbox", { name: /^I authorize/ }).check();
    await page.getByRole("button", { name: "Authorize reviewed Offers" }).dblclick();
    await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]).toMatchObject({ consent: true });
    const policies = await (
      await page.request.get(`/api/marketplace/account/offer-policies?offerId=${fixture.offerId}`)
    ).json();
    policyId = policies.items.find((policy: { status: string }) => policy.status === "active")?.policyId;
    expect(policyId).toBeTruthy();
    await page.getByRole("button", { name: "Pause market following" }).click();
    await expect(page.getByText("Paused", { exact: true }).first()).toBeVisible();
    const sellerContext = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL) });
    try {
      const seller = await sellerContext.newPage();
      await signInWithPassword(seller, String(testInfo.project.use.baseURL), marketplaceBrowserE2eSellerCredentials());
      const response = await seller.request.get(`/api/marketplace/account/offers/matches/${fixture.heldOfferId}`);
      expect(response.ok()).toBe(true);
      const match = await response.json();
      expect(match.can_fulfill).toBe(false);
      expect(["unavailable", "held", "refresh_required"]).toContain(match.managed_status);
      await seller.goto(`/account/offers/matches/${fixture.heldOfferId}`);
      await expect(seller.getByRole("button", { name: "Accept Offer Match", exact: true }).first()).toBeDisabled();
      const sellerMarkup = await seller.content();
      for (const field of [
        "buyerOfferPolicyId",
        "buyer_offer_policy_id",
        "policyId",
        "authority",
        "previewId",
        "maximumUnitItemAmount",
        "adjustmentBps",
        "itemCommitmentAllowance",
        "consumedItemAmount",
        "remainingItemAllowance",
        "marketPrice",
        "estimateVersion",
      ]) {
        expect(JSON.stringify(match)).not.toContain(`"${field}"`);
        expect(sellerMarkup).not.toContain(`"${field}"`);
      }
    } finally {
      await sellerContext.close();
    }
    await page.getByRole("button", { name: "Preview to resume" }).click();
    await expect(page.getByText("Review exact Offer authority")).toBeVisible();
    await page.getByRole("checkbox", { name: /^I authorize/ }).check();
    await page.getByRole("button", { name: "Authorize reviewed Offers" }).click();
    await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
    await page.getByRole("checkbox", { name: /^Stop is permanent/ }).check();
    await page.getByRole("button", { name: "Stop market following" }).click();
    await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview to resume" })).toHaveCount(0);
    await page.goto(`/account/offers/submitted/${fixture.offerId}`);
    await page.getByRole("button", { name: /^Manage Stopped/ }).click();
    await expect(page.getByText(/Stop is permanent/)).toBeVisible();
  } finally {
    try {
      if (policyId) {
        const current = await (await page.request.get(`/api/marketplace/account/offer-policies/${policyId}`)).json();
        if (current.status !== "stopped") {
          const stopped = await page.request.post(`/api/marketplace/account/offer-policies/${policyId}/commands`, {
            data: { type: "StopBuyerOfferPolicy", expectedVersion: current.version, operationId: crypto.randomUUID() },
          });
          expect(stopped.ok()).toBe(true);
        }
      }
    } finally {
      try {
        await removeEstimate?.();
      } finally {
        await (pool as PgTransactionalPool & { end: () => Promise<void> }).end();
      }
    }
  }
});
