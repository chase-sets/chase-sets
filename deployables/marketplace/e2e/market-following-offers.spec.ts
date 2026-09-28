import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { seedSyntheticOfferMarketPrice } from "@chase-sets/pricing/server";
import { createPlatformInternalAuthHeaders } from "@chase-sets/platform-runtime/http";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  decodeCommitReceipt,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import { identitySeedIds } from "@chase-sets/identity-seed";
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
  const sandbox = parseEnv(
    readFileSync(
      process.env.CHASE_SETS_SANDBOX_ENV_FILE ?? new URL("../../../.env.sandbox.local", import.meta.url),
      "utf8",
    ),
  );
  if (catalogDatabaseUrl !== sandbox.DATABASE_URL_CATALOG || !sandbox.DATABASE_URL_PRICING)
    throw new Error("Synthetic estimate requires the current owned E2E sandbox.");
  const databaseUrl = new URL(sandbox.DATABASE_URL_PRICING);
  const catalogUrl = new URL(catalogDatabaseUrl);
  if (
    !/^\/cs_[a-z0-9_]+_pricing$/.test(databaseUrl.pathname) ||
    !["localhost", "127.0.0.1"].includes(databaseUrl.hostname) ||
    databaseUrl.host !== catalogUrl.host ||
    databaseUrl.pathname !== catalogUrl.pathname.replace(/_catalog$/, "_pricing")
  )
    throw new Error("Synthetic estimate requires the owned local E2E database.");
  const pool = createPgPool(databaseUrl.toString(), { max: 1 });
  let removeEstimate: (() => Promise<void>) | undefined;
  let policyId: string | undefined;
  const authorizations: unknown[] = [];
  try {
    removeEstimate = await seedSyntheticOfferMarketPrice(pool, fixture);
    const credentials = marketplaceBrowserE2eBuyerCredentials();
    await signInWithPassword(page, String(testInfo.project.use.baseURL), credentials);
    const session = await page.request.get("/api/auth/session");
    expect(session.ok()).toBe(true);
    expect((await session.json()).actor).toMatchObject({
      userId: identitySeedIds.collector.userId,
      accountId: identitySeedIds.collector.accountId,
    });
    const apiOrigin = new URL(sandbox.PLATFORM_API_URL!);
    if (!["localhost", "127.0.0.1"].includes(apiOrigin.hostname))
      throw new Error("Buyer fixture verification requires the owned local E2E API.");
    // The scenario collector starts with an unverified email. Seed verification
    // through Identity's existing command, never by granting permissions directly.
    const verified = await fetch(
      new URL(`/api/identity/internal/auth/users/${identitySeedIds.collector.userId}/email-verification`, apiOrigin),
      {
        method: "POST",
        redirect: "error",
        headers: createPlatformInternalAuthHeaders(
          { "Content-Type": "application/json" },
          sandbox.PLATFORM_INTERNAL_AUTH_SECRET,
        ),
        body: JSON.stringify({ email: marketplaceBrowserE2eSeedContract.buyer.email }),
      },
    );
    expect(verified.ok, "owned buyer fixture email verification").toBe(true);
    const identityCommit = decodeCommitReceipt(verified.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER)).find(
      (source) => source.sourceContextName === "identity",
    );
    expect(identityCommit, "email verification must return an Identity commit receipt").toBeDefined();
    const identityRead = await page.request.get("/api/identity/current-actor-display", {
      headers: {
        [CHASE_SETS_READ_AFTER_WRITE_HEADER]: encodeFreshWriteReceipt({
          observedAtMs: Date.now(),
          sources: [identityCommit!],
        }),
        [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "identity",
      },
    });
    expect(identityRead.ok(), "receipt-honoring Identity user projection read").toBe(true);
    const readySession = await page.request.get("/api/auth/session");
    expect(readySession.ok()).toBe(true);
    expect((await readySession.json()).actor.permissions).toContain("offers.manage");
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
    for (const name of [
      `Select Surging Sparks Booster Box (${fixture.offerId})`,
      `Select Pikachu (${fixture.heldOfferId})`,
    ]) {
      const selection = page.getByRole("checkbox", { name });
      await selection.focus();
      await page.keyboard.press("Space");
      await expect(selection).toBeChecked();
    }
    await page.getByLabel("Maximum unit item amount: Surging Sparks Booster Box").fill("140.00");
    await page.getByLabel("Lifetime Item Commitment Allowance", { exact: false }).fill("400.00");
    const advanced = page.getByRole("button", { name: "Advanced adjustment" });
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await advanced.focus();
    await page.keyboard.press("Enter");
    await expect(advanced).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByLabel("Market Price adjustment (%)", { exact: true })).toHaveValue("0");
    await advanced.click();
    const previewResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/account/offers/submitted.data",
    );
    await page.getByRole("button", { name: "Preview selected Offers" }).click();
    expect((await previewResponse).status(), "Preview selected Offers action response").toBe(200);
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
    const consent = page.getByRole("checkbox", { name: /^I authorize/ });
    await consent.focus();
    await page.keyboard.press("Space");
    await expect(consent).toBeChecked();
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
    await consent.focus();
    await page.keyboard.press("Space");
    await expect(consent).toBeChecked();
    await page.getByRole("button", { name: "Authorize reviewed Offers" }).click();
    await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
    const stopConfirmation = page.getByRole("checkbox", { name: /^Stop is permanent/ });
    await stopConfirmation.focus();
    await page.keyboard.press("Space");
    await expect(stopConfirmation).toBeChecked();
    await page.getByRole("button", { name: "Stop market following" }).click();
    await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview to resume" })).toHaveCount(0);
    await page.goto(`/account/offers/submitted/${fixture.offerId}`);
    await page.getByRole("button", { name: /^Manage Stopped/ }).click();
    await expect(page.getByText(/Stop is permanent/)).toBeVisible();
  } finally {
    try {
      if (policyId) {
        const response = await page.request.get(`/api/marketplace/account/offer-policies/${policyId}`);
        if (response.status() === 404) {
          expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
        } else {
          expect(response.ok(), "read existing policy before teardown").toBe(true);
          const current = await response.json();
          if (current.status !== "stopped") {
            const stopped = await page.request.post(`/api/marketplace/account/offer-policies/${policyId}/commands`, {
              data: {
                type: "StopBuyerOfferPolicy",
                expectedVersion: current.version,
                operationId: crypto.randomUUID(),
              },
            });
            expect(stopped.ok()).toBe(true);
          }
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
