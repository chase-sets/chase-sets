import { expect, test, type APIResponse, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createPostgresEventStore, createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as checkoutModule } from "@chase-sets/checkout";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { seedSyntheticOfferMarketPrice } from "@chase-sets/pricing/server";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  appendFreshWriteTokenFromSources,
  encodeFreshWriteReceipt,
  readFreshWriteToken,
  readResponseConsistencyMetadata,
} from "@chase-sets/http/responses";
import { identitySeedIds } from "@chase-sets/identity-seed";
import { inventorySeedIds } from "@chase-sets/inventory/seed-support/ids";
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

test("market-following consent, changed target, Checkout acceptance and permanent stop @marketplace-account @browser-e2e-seed", async ({
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
  const removeEstimates: (() => Promise<void>)[] = [];
  const companionPools: PgTransactionalPool[] = [];
  const timeline: unknown[] = [];
  let listingId: string | undefined;
  let policyId: string | undefined;
  let sellerContext: BrowserContext | undefined;
  const authorizations: unknown[] = [];
  const writes: unknown[] = [];
  try {
    await test.step("Prepare and verify the exact synthetic Pricing estimate before Preview (not worker proof)", async () => {
      removeEstimates.push(await seedSyntheticOfferMarketPrice(pool, fixture));
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
    const rememberWrite = (response: APIResponse) => {
      const metadata = readResponseConsistencyMetadata({ headers: new Headers(response.headers()) });
      expect(metadata?.commitPositions.length, "retain the real command's commit receipt").toBeGreaterThan(0);
      writes.push(metadata);
    };
    const freshReadHeaders = (target: "marketplace" | "ordering") => {
      const receipt = readFreshWriteToken(appendFreshWriteTokenFromSources("http://localhost/", writes));
      expect(receipt, "carry the captured command receipts into the exact read").not.toBeNull();
      return {
        [CHASE_SETS_READ_AFTER_WRITE_HEADER]: encodeFreshWriteReceipt(receipt!),
        [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: target,
      };
    };
    const submitTestOffer = async (offer: {
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      selectedOptions: { dimensionId: string; optionId: string }[];
      priceAmount: string;
      priceCurrencyCode: string;
      quantityRequested: number;
    }) => {
      const submitted = await page.request.post("/api/marketplace/account/offers/submitted", {
        data: {
          attemptId: crypto.randomUUID(),
          ...offer,
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
      rememberWrite(submitted);
      const result = await submitted.json();
      expect(result.id, "the created Offer's actual identity").toEqual(expect.stringMatching(/^off_/));
      return result.id as string;
    };
    const controlOfferIds: string[] = [];
    for (const seedOfferId of [fixture.offerId, fixture.heldOfferId]) {
      const response = await page.request.get(`/api/marketplace/account/offers/submitted/${seedOfferId}`);
      expect(response.ok(), "read the seed only as a template; never attach its permanent membership").toBe(true);
      const source = await response.json();
      controlOfferIds.push(
        await submitTestOffer({
          catalogItemId: source.catalog_catalog_item_id,
          productId: source.product_id,
          itemTitle: source.item_title,
          selectedOptions: source.selected_options,
          priceAmount: source.price_amount,
          priceCurrencyCode: source.price_currency_code,
          quantityRequested: source.quantity_requested,
        }),
      );
    }
    const [controlOfferId, heldControlOfferId] = controlOfferIds;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/account/offers/submitted")) {
        const fields = new URLSearchParams(request.postData() ?? "");
        policyId = fields.get("policyId") ?? policyId;
        const command = fields.get("command");
        if (command && JSON.parse(command).type === "AuthorizeBuyerOfferPolicy")
          authorizations.push(JSON.parse(command));
        if (command) timeline.push({ step: "buyer policy command", command: JSON.parse(command) });
      }
    });
    await page.goto(appendFreshWriteTokenFromSources("/account/offers/submitted", writes));
    await page.getByRole("switch", { name: "Follow the market for selected Offers" }).click();
    for (const name of [
      `Select Surging Sparks Booster Box (${controlOfferId})`,
      `Select Pikachu (${heldControlOfferId})`,
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
    await test.step("A versioned Market Price changes the authorized Offer through the real worker", async () => {
      await expect(
        seedSyntheticOfferMarketPrice(pool, {
          ...fixture,
          estimateVersion: "8347002",
          previousEstimateVersion: "999",
          amount: "135.00",
        }),
      ).rejects.toThrow("exact previous owned estimate");
      removeEstimates.push(
        await seedSyntheticOfferMarketPrice(pool, {
          ...fixture,
          estimateVersion: "8347002",
          previousEstimateVersion: fixture.estimateVersion,
          amount: "135.00",
        }),
      );
      await expect
        .poll(async () => {
          const response = await page.request.get(`/api/marketplace/account/offers/submitted/${controlOfferId}`);
          expect(response.ok()).toBe(true);
          return (await response.json()).price_amount;
        })
        .toBe("135.00");
      await page.reload();
      await expect(page.getByText("$135.00", { exact: true }).first()).toBeVisible();
      for (const [width, height] of [
        [360, 800],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width: width!, height: height! });
        await page.getByRole("button", { name: "Pause market following" }).scrollIntoViewIfNeeded();
        await expect(page.getByRole("button", { name: "Pause market following" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`market-following-active-${width}.png`), fullPage: true });
      }
      timeline.push({
        step: "worker target observed",
        offerId: controlOfferId,
        amount: "135.00",
        estimateVersion: "8347002",
      });
    });
    await page.getByRole("button", { name: "Pause market following" }).click();
    await expect(page.getByText("Paused", { exact: true }).first()).toBeVisible();
    sellerContext = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL) });
    {
      const seller = await sellerContext.newPage();
      await signInWithPassword(seller, String(testInfo.project.use.baseURL), marketplaceBrowserE2eSellerCredentials());
      const response = await seller.request.get(`/api/marketplace/account/offers/matches/${heldControlOfferId}`, {
        headers: freshReadHeaders("marketplace"),
      });
      expect(response.ok()).toBe(true);
      const match = await response.json();
      expect(match.can_fulfill).toBe(false);
      expect(["unavailable", "held", "refresh_required"]).toContain(match.managed_status);
      await seller.goto(appendFreshWriteTokenFromSources(`/account/offers/matches/${heldControlOfferId}`, writes));
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
    await test.step("The seller accepts the visibly authorized Match through Checkout sell-confirm", async () => {
      const seller = await sellerContext!.newPage();
      if (marketplaceBrowserE2eSellerCredentials().email !== marketplaceBrowserE2eSeedContract.seller.email)
        throw new Error("This journey requires the seeded synthetic seller.");
      try {
        const listing = await seller.request.post("/api/marketplace/account/listings", {
          data: {
            idempotencyKey: `e2e_create_${randomUUID().replaceAll("-", "")}`,
            inventoryItemId: inventorySeedIds.items.surgingSparksBoosterBox,
            priceAmount: "135.00",
            priceCurrencyCode: "USD",
            quantityCap: owner.authority.offers.find((offer: { offerId: string }) => offer.offerId === controlOfferId)
              .quantity,
          },
        });
        expect(listing.status(), "create test-owned stock; the seeded demo Listing is withdrawn").toBe(201);
        rememberWrite(listing);
        const draft = await listing.json();
        listingId = draft.id;
        const published = await seller.request.post(`/api/marketplace/account/listings/${listingId}/publish`, {
          data: {
            idempotencyKey: `e2e_publish_${randomUUID().replaceAll("-", "")}`,
            feeQuoteFingerprint: draft.feeQuoteFingerprint,
          },
        });
        expect(published.ok(), "publish the test-owned Listing through its normal gates").toBe(true);
        rememberWrite(published);
        const fixtureRead = await seller.request.get(`/api/marketplace/account/listings/${listingId}`, {
          headers: freshReadHeaders("marketplace"),
        });
        expect(fixtureRead.ok(), "receipted read of the exact owned seller stock").toBe(true);
        expect(await fixtureRead.json()).toMatchObject({
          listing_id: listingId,
          product_id: fixture.productId,
          price_currency_code: "USD",
          status: "active",
        });
        // Marketplace's Listing read does not fence Ordering's independent supply inputs.
        // Establish those inputs before acceptance can wake the Order-creation reaction.
        const orderingFixtureRead = await seller.request.get(`/api/marketplace/account/listings/${listingId}`, {
          headers: freshReadHeaders("ordering"),
        });
        expect(orderingFixtureRead.ok(), "Ordering has applied the test-owned Listing's publication receipt").toBe(
          true,
        );

        const sellerSession = await seller.request.get("/api/auth/session");
        expect(sellerSession.ok()).toBe(true);
        const sellerActor = (await sellerSession.json()).actor;
        for (const contextName of ["settlement", "checkout"]) {
          const url = new URL(sandbox[`DATABASE_URL_${contextName.toUpperCase()}`] ?? "");
          if (
            url.host !== databaseUrl.host ||
            url.pathname !== databaseUrl.pathname.replace(/_pricing$/, `_${contextName}`)
          )
            throw new Error("Payout fixture requires the same owned E2E sandbox.");
          companionPools.push(createPgPool(url.toString(), { max: 1 }));
        }
        const [settlementPool, checkoutPool] = companionPools;
        const settlement = createPostgresEventStore({ pool: settlementPool! });
        const streamId = `settlement.payout-readiness-${sellerActor.accountId}`;
        const prior = (await readCompleteStream(settlement, { streamId })).at(-1);
        const [ready] = await settlement.appendToStream({
          streamId,
          expectedVersion: prior?.streamVersion ?? 0,
          context: {
            tenantId: sellerActor.tenantId,
            audit: { forAccountId: sellerActor.accountId, performedByUserId: sellerActor.userId },
          },
          events: [
            {
              eventType: "settlement.payout-readiness.recorded",
              payload: {
                accountId: sellerActor.accountId,
                status: "ready",
                missingRequirements: [],
                recordedAt: new Date().toISOString(),
                syntheticFixture: "market-following-e2e-only",
              },
            },
          ],
        });
        const checkout = checkoutModule.createServices(checkoutPool!, {});
        const projector = checkoutModule.buildSubscriptions!(checkout).find(
          (entry) => entry.sourceContextName === "settlement",
        )!;
        await projector.handlers["settlement.payout-readiness.recorded"]!(toTransportEvent(ready!));
        timeline.push({ step: "synthetic payout readiness", eventId: ready!.eventId });
        await expect
          .poll(async () => {
            const response = await seller.request.get(`/api/marketplace/account/offers/matches/${controlOfferId}`, {
              headers: freshReadHeaders("marketplace"),
            });
            expect(response.ok()).toBe(true);
            const match = await response.json();
            return { can_fulfill: match.can_fulfill, amount: match.price_amount, listingId: match.listing_id };
          })
          .toEqual({ can_fulfill: true, amount: "135.00", listingId });
        seller.on("request", (request) => {
          if (request.method() === "POST") {
            const fields = new URLSearchParams(request.postData() ?? "");
            timeline.push({
              step: "seller command",
              path: new URL(request.url()).pathname,
              intent: fields.get("intent"),
              sessionId: fields.get("sessionId"),
            });
          }
        });
        await seller.goto(`/account/offers/matches/${controlOfferId}`);
        for (const field of ["maximumUnitItemAmount", "buyerOfferPolicyId", "adjustmentBps", "itemCommitmentAllowance"])
          expect(await seller.content()).not.toContain(`"${field}"`);
        await seller.getByRole("button", { name: "Accept offer match", exact: true }).first().click();
        await expect(seller).toHaveURL(/\/account\/sell-list/);
        await seller
          .locator('a[href*="/checkout/sell/"], button')
          .filter({ hasText: /seller checkout|review sale/i })
          .first()
          .click();
        await expect(seller).toHaveURL(/\/checkout\/sell\/session\//);
        for (const [name, value] of Object.entries({
          sellerName: "Synthetic Seller",
          email: marketplaceBrowserE2eSeedContract.seller.email,
          shipFromName: "Synthetic Seller",
          shipFromLine1: "1 Main Street",
          shipFromCity: "Chicago",
          shipFromState: "IL",
          shipFromPostalCode: "60601",
          shipFromCountry: "US",
        })) {
          const field = seller.locator(`input[name="${name}"]:visible`);
          if (await field.count()) await field.fill(value);
        }
        await seller.locator('input[name="termsAccepted"]').check();
        await seller.getByRole("button", { name: "Review sale", exact: true }).first().click();
        await expect(seller).toHaveURL(/\/checkout\/sell\/.*confirmation/);
        const readAccepted = async () => {
          const response = await page.request.get(`/api/marketplace/account/offers/submitted/${controlOfferId}`);
          expect(response.ok()).toBe(true);
          return response.json();
        };
        await expect.poll(async () => (await readAccepted()).status).toBe("accepted");
        const accepted = await readAccepted();
        expect(accepted).toMatchObject({ status: "accepted", price_amount: "135.00" });
        const readOrders = async () => {
          const response = await page.request.get("/api/marketplace/account/purchases?limit=100");
          expect(response.ok()).toBe(true);
          const result = await response.json();
          expect(result.count).toBe(result.total);
          return result.items.filter(
            (order: { source_reference_id: string }) => order.source_reference_id === controlOfferId,
          );
        };
        await expect.poll(async () => (await readOrders()).length).toBe(1);
        const orders = await readOrders();
        const orderResponse = await page.request.get(`/api/marketplace/account/purchases/${orders[0].order_id}`);
        expect(orderResponse.ok()).toBe(true);
        const order = await orderResponse.json();
        expect(accepted.quantity_requested).toBe(
          owner.authority.offers.find((offer: { offerId: string }) => offer.offerId === controlOfferId).quantity,
        );
        expect(order.lines).toEqual([
          expect.objectContaining({ unit_price_amount: "135.00", quantity: accepted.quantity_requested }),
        ]);
        timeline.push({ step: "immutable acceptance", offer: accepted, order });
        await page.goto("/account/offers/submitted");
        await page.getByRole("button", { name: "Pause market following" }).click();
        await expect(page.getByText("Paused", { exact: true }).first()).toBeVisible();
        removeEstimates.push(
          await seedSyntheticOfferMarketPrice(pool, {
            ...fixture,
            estimateVersion: "8347003",
            previousEstimateVersion: "8347002",
            amount: "100.00",
          }),
        );
        expect(await readAccepted()).toMatchObject({
          status: "accepted",
          price_amount: "135.00",
          quantity_requested: accepted.quantity_requested,
        });
        await seller.screenshot({
          path: testInfo.outputPath("market-following-checkout-confirmation.png"),
          fullPage: true,
        });
      } finally {
        await seller.close();
      }
    });
    const stopConfirmation = page.getByRole("checkbox", { name: /^Stop is permanent/ });
    await stopConfirmation.focus();
    await page.keyboard.press("Space");
    await expect(stopConfirmation).toBeChecked();
    await page.getByRole("button", { name: "Stop market following" }).click();
    await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview to resume" })).toHaveCount(0);
    await page.goto(`/account/offers/submitted/${heldControlOfferId}`);
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
                attemptId: crypto.randomUUID(),
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
        if (listingId && sellerContext) {
          const withdrawn = await sellerContext.request.post(
            `/api/marketplace/account/listings/${listingId}/withdraw`,
            {
              data: { idempotencyKey: `e2e_withdraw_${randomUUID().replaceAll("-", "")}` },
            },
          );
          expect(withdrawn.ok()).toBe(true);
        }
        await sellerContext?.close();
      } finally {
        try {
          await testInfo.attach("market-following-command-timeline", {
            body: JSON.stringify(timeline, null, 2),
            contentType: "application/json",
          });
          for (const remove of removeEstimates.reverse()) await remove();
          for (const companion of companionPools)
            await (companion as PgTransactionalPool & { end: () => Promise<void> }).end();
        } finally {
          await (pool as PgTransactionalPool & { end: () => Promise<void> }).end();
        }
      }
    }
  }
});
