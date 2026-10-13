import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { seedSyntheticOfferMarketPrice } from "@chase-sets/pricing/server";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import { identitySeedIds } from "@chase-sets/identity-seed";
import {
  requireIdentityCommitSource,
  verifyMarketFollowingBuyerContactInOwnedSandbox,
} from "@chase-sets/identity/seed-support/market-following-verification";
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
  if (!sandbox.DATABASE_URL_IDENTITY)
    throw new Error("Buyer fixture verification requires the current owned E2E Identity sandbox.");
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
    await test.step("Prepare and verify the exact synthetic Pricing estimate before Preview (not worker proof)", async () => {
      removeEstimate = await seedSyntheticOfferMarketPrice(pool, fixture);
    });
    const credentials = marketplaceBrowserE2eBuyerCredentials();
    await signInWithPassword(page, String(testInfo.project.use.baseURL), credentials);
    // The scenario collector starts with an unverified email. Every invocation (retries
    // included) issues Identity's existing VerifyContactMethod command against the seeded
    // user's actual stored primary email contact in the owned E2E Identity database and
    // keeps only the commit metadata captured inside that command's scope. The receipt is
    // forwarded to Auth on the very session read whose actor and permissions are asserted,
    // so readiness is proven by that response, never by polling or a neighboring wait.
    const verification = await verifyMarketFollowingBuyerContactInOwnedSandbox({
      identityDatabaseUrl: sandbox.DATABASE_URL_IDENTITY,
      companionDatabaseUrl: catalogDatabaseUrl,
      userId: identitySeedIds.collector.userId,
      primaryEmail: marketplaceBrowserE2eSeedContract.buyer.email,
    });
    expect(verification.userId).toBe(identitySeedIds.collector.userId);
    const identityCommit = requireIdentityCommitSource(verification.sources);
    const session = await page.request.get("/api/auth/session", {
      headers: {
        [CHASE_SETS_READ_AFTER_WRITE_HEADER]: encodeFreshWriteReceipt({
          observedAtMs: Date.now(),
          sources: [identityCommit],
        }),
        [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "auth",
      },
    });
    expect(session.ok(), "receipt-honoring Auth session read").toBe(true);
    const actor = (await session.json()).actor;
    expect(actor).toMatchObject({
      userId: identitySeedIds.collector.userId,
      accountId: identitySeedIds.collector.accountId,
    });
    expect(actor.permissions, "offers.manage on the receipted session response").toContain("offers.manage");
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
    await expect(page.getByLabel(/item commitment allowance/i)).toHaveCount(0);
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
      await page.getByRole("checkbox", { name: /^I authorize/ }).scrollIntoViewIfNeeded();
      await expect(page.getByLabel(/item commitment allowance/i)).toHaveCount(0);
      await expect(page.getByText(/accepted item commitments|remaining item commitment/i)).toHaveCount(0);
      await expect(
        page.getByRole("checkbox", {
          name: "I authorize these exact selected Offers, quantities, currency, adjustment and maximum unit item amounts. Resuming requires a fresh preview and consent.",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole("checkbox", { name: /^I authorize/ })).toBeVisible();
      await expect(page.getByRole("checkbox", { name: /^I authorize/ })).not.toBeChecked();
      await expect(page.getByRole("button", { name: "Authorize reviewed Offers" })).toBeDisabled();
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
    expect(policyId).toBeTruthy();
    const policy = await page.request.get(`/api/marketplace/account/offer-policies/${policyId}`);
    expect(policy.ok(), "authoritative policy detail after Authorize").toBe(true);
    const owner = await policy.json();
    expect(owner).toMatchObject({ policyId, status: "active" });
    for (const field of ["itemCommitmentAllowance", "consumedItemAmount", "remainingItemAllowance"])
      expect(JSON.stringify(owner)).not.toContain(`"${field}"`);
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
      await expect(seller.getByRole("button", { name: "Accept offer match", exact: true }).first()).toBeDisabled();
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
    const resumeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/account/offers/submitted.data",
    );
    await page.getByRole("button", { name: "Preview to resume" }).click();
    const resume = await resumeResponse;
    const resumeDiagnostic = `Resume Preview action status=${resume.status()}; command status=${
      resume.headers()["x-marketplace-command-status"] ?? "no rejection"
    }; code=${resume.headers()["x-marketplace-command-code"] ?? "none"}`;
    expect(resume.status(), resumeDiagnostic).toBe(200);
    expect(resume.headers()["x-marketplace-command-status"], resumeDiagnostic).toBeUndefined();
    await expect(page.getByText("Review exact Offer authority"), resumeDiagnostic).toBeVisible();
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
    await test.step("Two Offers of one policy each create exactly one distinct Order", async () => {
      const offerIds: string[] = [];
      for (let index = 0; index < 2; index++) {
        const submitted = await page.request.post("/api/marketplace/account/offers/submitted", {
          data: {
            catalogItemId: fixture.catalogItemId,
            productId: fixture.productId,
            itemTitle: "Surging Sparks Booster Box",
            selectedOptions: [],
            priceAmount: fixture.amount,
            priceCurrencyCode: "USD",
            quantityRequested: 1,
            shippingDestinationSnapshot: {
              name: "Synthetic Buyer",
              line1: "1 Main Street",
              line2: null,
              city: "Chicago",
              state: "IL",
              postalCode: "60601",
              country: "US",
            },
          },
        });
        expect(submitted.status()).toBe(201);
        offerIds.push((await submitted.json()).id);
      }
      const acceptancePolicyId = `bop_${crypto.randomUUID()}`;
      const commandUrl = `/api/marketplace/account/offer-policies/${acceptancePolicyId}/commands`;
      let created = false;
      try {
        const creation = await page.request.post(commandUrl, {
          data: { type: "CreateBuyerOfferPolicy", expectedVersion: 0, operationId: crypto.randomUUID() },
        });
        expect(creation.ok()).toBe(true);
        created = true;
        const preview = await page.request.post(commandUrl, {
          data: {
            type: "PreviewBuyerOfferPolicy",
            expectedVersion: 1,
            operationId: crypto.randomUUID(),
            terms: {
              currency: "USD",
              adjustmentBps: 0,
              offers: offerIds.map((offerId) => ({
                offerId,
                offerVersion: 1,
                catalogItemId: fixture.catalogItemId,
                productId: fixture.productId,
                selectedOptions: [],
                quantity: 1,
                maximumUnitItemAmount: "140.00",
              })),
            },
          },
        });
        expect(preview.ok()).toBe(true);
        const reviewed = await preview.json();
        const authorized = await page.request.post(commandUrl, {
          data: {
            type: "AuthorizeBuyerOfferPolicy",
            expectedVersion: reviewed.version,
            previewId: reviewed.preview.previewId,
            consent: true,
            operationId: crypto.randomUUID(),
          },
        });
        expect(authorized.ok()).toBe(true);
        const sellerContext = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL) });
        try {
          const seller = await sellerContext.newPage();
          await signInWithPassword(
            seller,
            String(testInfo.project.use.baseURL),
            marketplaceBrowserE2eSellerCredentials(),
          );
          for (const offerId of offerIds) {
            await expect
              .poll(async () => {
                const response = await seller.request.get(`/api/marketplace/account/offers/matches/${offerId}`);
                return response.ok() ? (await response.json()).can_fulfill : false;
              })
              .toBe(true);
            const match = await (await seller.request.get(`/api/marketplace/account/offers/matches/${offerId}`)).json();
            const quote = await seller.request.get(
              `/api/marketplace/account/offers/matches/${offerId}/terms-preview?listingId=${match.listing_id}`,
            );
            expect(quote.ok()).toBe(true);
            const acceptance = await seller.request.post(`/api/marketplace/account/offers/matches/${offerId}/accept`, {
              data: { listingId: match.listing_id, feeQuoteFingerprint: (await quote.json()).fee_quote_fingerprint },
            });
            expect(acceptance.status()).toBe(201);
          }
        } finally {
          await sellerContext.close();
        }
        const readOrders = async () => {
          const response = await page.request.get("/api/marketplace/account/purchases?limit=100");
          expect(response.ok()).toBe(true);
          const result = await response.json();
          expect(result.count).toBe(result.total);
          return result.items.filter(
            (order: { source_type: string; source_reference_id: string }) =>
              order.source_type === "offer-acceptance" && offerIds.includes(order.source_reference_id),
          );
        };
        await expect.poll(async () => (await readOrders()).length).toBe(2);
        const orders = await readOrders();
        for (const offerId of offerIds)
          expect(
            orders.filter((order: { source_reference_id: string }) => order.source_reference_id === offerId),
          ).toHaveLength(1);
        expect(new Set(orders.map((order: { order_id: string }) => order.order_id)).size).toBe(2);
      } finally {
        if (created) {
          const response = await page.request.get(`/api/marketplace/account/offer-policies/${acceptancePolicyId}`);
          expect(response.ok()).toBe(true);
          const current = await response.json();
          const stopped = await page.request.post(commandUrl, {
            data: { type: "StopBuyerOfferPolicy", expectedVersion: current.version, operationId: crypto.randomUUID() },
          });
          expect(stopped.ok()).toBe(true);
        }
      }
    });
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
