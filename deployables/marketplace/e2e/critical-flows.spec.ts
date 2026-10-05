import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { registerSyntheticAccount, signInWithPassword, syntheticAccountFor } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

const configuredMarketplaceAccount = {
  email: process.env.MARKETPLACE_E2E_EMAIL?.trim() ?? "",
  password: process.env.MARKETPLACE_E2E_PASSWORD?.trim() ?? "",
};

const searchQuery = process.env.MARKETPLACE_E2E_SEARCH_QUERY ?? "charizard";
const authProjectionTimeoutMs = 90_000;

const accountCriticalRoutes = [
  { path: "/account/cart", heading: /^Your cart$/i, flow: "buy cart" },
  { path: "/account/sell-list", heading: /^Sell List$/i, flow: "sell list" },
  { path: "/account/listings", heading: /^Listings$/i, flow: "listings" },
  { path: "/account/repricing", heading: /^Repricing$/i, flow: "repricing" },
  { path: "/account/offers/submitted", heading: /^Submitted Offers$/i, flow: "submitted offers" },
  { path: "/account/offers/matches", heading: /^Offer Matches$/i, flow: "offer matches" },
  { path: "/account/inventory", heading: /^Inventory$/i, flow: "inventory" },
  { path: "/account/purchases", heading: /^Purchases$/i, flow: "purchases" },
  { path: "/account/sales", heading: /^Sales$/i, flow: "sales" },
  { path: "/account/desk/money", heading: /^Money$/i, flow: "money" },
] as const;

type AccountRoute = {
  path: string;
  heading: RegExp;
  flow: string;
};

const protectedAccountRoutes = [
  { path: "/account/listings", flow: "listings" },
  { path: "/account/security", flow: "security" },
  { path: "/account/shipping-addresses", flow: "shipping addresses" },
  { path: "/account/support", flow: "support" },
  { path: "/account/reviews/written", flow: "written reviews" },
] as const;

async function expectPageOk(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} did not return a page response`).not.toBeNull();
  expect(response!.status(), `${path} returned HTTP ${response!.status()}`).toBeLessThan(400);
}

async function expectAccountRouteReady(page: Page, route: AccountRoute) {
  await expect
    .poll(
      async () => {
        const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
        expect(response, `${route.path} did not return a page response`).not.toBeNull();
        expect(response!.status(), `${route.path} returned HTTP ${response!.status()}`).toBeLessThan(400);

        if (new URL(page.url()).pathname !== route.path) {
          return false;
        }

        await expect(page.getByRole("heading", { name: route.heading }).first()).toBeVisible();
        return true;
      },
      { intervals: [1_000, 2_000, 5_000], timeout: authProjectionTimeoutMs },
    )
    .toBe(true);
}

function marketplaceAccountFor(testInfo: TestInfo) {
  if (configuredMarketplaceAccount.email) {
    if (!configuredMarketplaceAccount.password) {
      throw new Error("MARKETPLACE_E2E_PASSWORD is required when MARKETPLACE_E2E_EMAIL is configured.");
    }

    return {
      email: configuredMarketplaceAccount.email,
      password: configuredMarketplaceAccount.password,
      displayName: "Marketplace E2E Account",
      shouldRegister: false,
    };
  }

  return syntheticAccountFor(testInfo);
}

async function authenticateAccount(page: Page, testInfo: TestInfo) {
  await expectPageOk(page, "/");
  const origin = new URL(page.url()).origin;
  const credentials = marketplaceAccountFor(testInfo);

  if (credentials.shouldRegister) {
    return {
      ...credentials,
      sessionToken: await registerSyntheticAccount(page, origin, credentials),
    };
  }

  return {
    ...credentials,
    sessionToken: await signInWithPassword(page, origin, credentials),
  };
}

async function waitForPreferences(
  page: Page,
  expected: Readonly<{
    colorMode?: string;
    reducedMotion?: string;
  }>,
) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/identity/preferences");
        expect(response.status()).toBe(200);
        return (await response.json()) as { colorMode?: string; reducedMotion?: string };
      },
      { timeout: authProjectionTimeoutMs },
    )
    .toMatchObject(expected);
}

async function openAccountColorThemeControl(page: Page) {
  const accountMenu = page.getByRole("button", { name: "Account menu" });
  const colorTheme = page.getByRole("group", { name: "Color theme" });

  await expect(accountMenu).toBeVisible();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await accountMenu.click();
    const opened = await colorTheme
      .waitFor({ state: "visible", timeout: 500 })
      .then(() => true)
      .catch(() => false);

    if (opened) {
      return colorTheme;
    }
  }

  await expect(colorTheme).toBeVisible();
  return colorTheme;
}

function expectFirstPaintChaseRoot(html: string, expected: Readonly<{ colorMode: string; reducedMotion: string }>) {
  const root = html.match(/<div\s[^>]*data-chase-theme=""[^>]*>/)?.[0] ?? "";

  expect(root, "first paint should include the design-system shell root").toContain('data-chase-theme=""');
  expect(root).toContain(`data-color-mode="${expected.colorMode}"`);
  expect(root).toContain(`data-reduced-motion="${expected.reducedMotion}"`);
  expect(root).not.toContain('data-color-mode="light"');
}

test.describe("marketplace critical flows", () => {
  test("signed-out shoppers can browse, search, and reach auth entry points @marketplace-browse", async ({ page }) => {
    await expectPageOk(page, "/search");

    const searchBox = page.getByRole("searchbox").first();
    await expect(searchBox).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Find trading cards worth chasing.");
    await expect(searchBox).toHaveAttribute("placeholder", "Search Charizard, Black Lotus, Dark Magician, Luffy...");
    await expect(page.getByRole("link", { name: "Sign In" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Register" }).first()).toBeVisible();

    await searchBox.fill(searchQuery);
    await expect(searchBox).toHaveValue(searchQuery);
    await expect(page.getByRole("link", { name: /View details for/i }).first()).toBeVisible();

    await page.getByRole("link", { name: "Sign In" }).first().click();
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByText(/^Sign in$/i).first()).toBeVisible();
    await expect(page.getByLabel(/Email or phone/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();

    await page.getByRole("link", { name: "Register" }).first().click();
    await expect(page).toHaveURL(/\/register/);
    await expect(page.getByRole("heading", { name: "Create your account", exact: true })).toBeVisible();
    await expect(page.getByText("Passkey").first()).toBeVisible();
  });

  test("records sign-in method list and email option at 390x844 @marketplace-account", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expectPageOk(page, "/sign-in");
    await expect(page.getByLabel(/Email or phone/)).toHaveValue("");
    await expect(page.locator('main [role="listitem"]')).toHaveText([
      "Password",
      "Phone Code",
      "Email me a sign-in link",
      "Passkey",
    ]);
    await expect(page.getByRole("radiogroup")).toHaveCount(0);
    await captureResponsiveEvidence({ page, testInfo, claimId: "sign-in-methods-mobile" });

    await page.getByLabel(/Email or phone/).fill("evidence@example.com");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("radio", { name: "Email me a sign-in link", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Email me a sign-in link", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("radiogroup").evaluate(async (group) => {
      await Promise.all(group.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    await expect(page.getByText("We'll email you a one-time link.", { exact: true })).toBeVisible();
    const emailButton = page.getByRole("button", { name: "Email me a sign-in link", exact: true });
    await expect(emailButton).toBeEnabled();
    await expect(emailButton.locator("svg.lucide-mail")).toBeVisible();
    await captureResponsiveEvidence({ page, testInfo, claimId: "sign-in-email-option-mobile" });
  });

  test("records sign-in method list and email option at 1280x900 @marketplace-account", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectPageOk(page, "/sign-in");
    await expect(page.getByLabel(/Email or phone/)).toHaveValue("");
    await expect(page.locator('main [role="listitem"]')).toHaveText([
      "Password",
      "Phone Code",
      "Email me a sign-in link",
      "Passkey",
    ]);
    await expect(page.getByRole("radiogroup")).toHaveCount(0);
    await captureResponsiveEvidence({ page, testInfo, claimId: "sign-in-methods-desktop" });

    await page.getByLabel(/Email or phone/).fill("evidence@example.com");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("radio", { name: "Email me a sign-in link", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Email me a sign-in link", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("radiogroup").evaluate(async (group) => {
      await Promise.all(group.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    await expect(page.getByText("We'll email you a one-time link.", { exact: true })).toBeVisible();
    const emailButton = page.getByRole("button", { name: "Email me a sign-in link", exact: true });
    await expect(emailButton).toBeEnabled();
    await expect(emailButton.locator("svg.lucide-mail")).toBeVisible();
    await captureResponsiveEvidence({ page, testInfo, claimId: "sign-in-email-option-desktop" });
  });

  test("protected account routes preserve the requested return path @marketplace-account", async ({ page }) => {
    for (const route of protectedAccountRoutes) {
      await test.step(`open ${route.flow}`, async () => {
        await page.goto(route.path);
        await expect(page).toHaveURL(/\/sign-in/);

        const redirectedUrl = new URL(page.url());
        expect(redirectedUrl.searchParams.get("returnTo")).toBe(route.path);
        await expect(page.getByText(/^Sign in$/i).first()).toBeVisible();
      });
    }
  });

  test("signed-out checkout session access shows checkout recovery instead of root error @marketplace-checkout", async ({
    page,
  }) => {
    const response = await page.goto("/checkout/buy/session/chk_e2e_missing_access", {
      waitUntil: "domcontentloaded",
    });

    expect(response, "checkout recovery should return a page response").not.toBeNull();
    expect(response!.status(), "missing checkout access should not be a server error").toBe(401);
    await expect(page.getByRole("heading", { name: /^Checkout access required$/i })).toBeVisible();
    await expect(page.getByText("Your payment has not started.").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);
  });

  test("checkout recovery reentry follows a safe action instead of root error @marketplace-checkout", async ({
    page,
  }) => {
    const recoveryResponse = await page.goto("/checkout/buy/session/chk_e2e_missing_access", {
      waitUntil: "domcontentloaded",
    });

    expect(recoveryResponse, "checkout recovery should return a page response").not.toBeNull();
    expect(recoveryResponse!.status(), "expected checkout access recovery should not be a server error").toBe(401);
    await expect(page.getByRole("heading", { name: /^Checkout access required$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);

    const browseAction = page.getByRole("link", { name: /^Browse marketplace$/i });
    await expect(browseAction).toBeVisible();

    // The hydrated marketplace follows this link with client-side routing, so
    // the safe recovery contract must not depend on a full document request.
    await browseAction.click();

    await expect(page).toHaveURL(/\/search(?:$|\?)/);
    await expect(page.getByRole("searchbox").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);
  });

  test("account can authenticate and review cart @marketplace-checkout", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    await authenticateAccount(page, testInfo);

    await expectAccountRouteReady(page, accountCriticalRoutes[0]);
    await expectAccountRouteReady(page, accountCriticalRoutes[2]);
  });

  test("signed-in presentation preferences persist across reloads and converge across sessions @marketplace-account", async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    const account = await authenticateAccount(page, testInfo);
    await expectAccountRouteReady(page, accountCriticalRoutes[0]);

    const colorTheme = await openAccountColorThemeControl(page);
    const preferencesResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/identity/preferences" && response.request().method() === "PUT";
    });
    await colorTheme
      .locator("label")
      .filter({ hasText: /^Dark$/ })
      .click();
    expect((await preferencesResponse).status()).toBe(200);
    await expect(colorTheme.locator('input[data-theme-choice="dark"]')).toBeChecked();

    await expect(page.locator('[data-color-mode="dark"]').first()).toBeVisible();
    await waitForPreferences(page, { colorMode: "dark" });

    const reducedMotionResponse = await page.request.put("/api/identity/preferences", {
      data: { reducedMotion: "always" },
    });
    expect(reducedMotionResponse.status()).toBe(200);
    await waitForPreferences(page, { colorMode: "dark", reducedMotion: "always" });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-color-mode="dark"]').first()).toBeVisible();
    await expect(page.locator('[data-reduced-motion="true"]').first()).toBeVisible();

    const firstPaintResponse = await page.request.get("/account/cart");
    expect(firstPaintResponse.status()).toBeLessThan(400);
    const firstPaintHtml = await firstPaintResponse.text();
    expectFirstPaintChaseRoot(firstPaintHtml, { colorMode: "dark", reducedMotion: "true" });

    const origin = new URL(page.url()).origin;
    const secondContext = await browser.newContext({ baseURL: origin });
    try {
      const secondPage = await secondContext.newPage();
      await signInWithPassword(secondPage, origin, account);
      await expectAccountRouteReady(secondPage, accountCriticalRoutes[0]);
      await expect(secondPage.locator('[data-color-mode="dark"]').first()).toBeVisible();
      await expect(secondPage.locator('[data-reduced-motion="true"]').first()).toBeVisible();
    } finally {
      await secondContext.close();
    }
  });

  test("seeded seller can reach critical marketplace commerce surfaces including repricing @marketplace-seller", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    await signInWithPassword(page, new URL(page.url()).origin, marketplaceBrowserE2eSellerCredentials());
    await expectAccountRouteReady(page, accountCriticalRoutes[0]);

    for (const route of accountCriticalRoutes) {
      await test.step(`open ${route.flow}`, async () => {
        await expectAccountRouteReady(page, route);
      });
    }
  });

  test("records hydrated Sell List review on the Desk offers route @marketplace-checkout", async ({
    page,
  }, testInfo) => {
    const offerId = "off_seed_charizard_base_set_high_roller";
    const sellListApi = "/api/marketplace/account/sell-list";
    const read = async (path: string) => {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(200);
      return response.json();
    };
    await expectPageOk(page, "/sign-in");
    await signInWithPassword(page, new URL(page.url()).origin, marketplaceBrowserE2eSellerCredentials());
    const readinessBefore = await read("/api/settlement/payout-readiness");
    expect(readinessBefore.account_id).toBe("acc_seed_demo_account");
    expect(readinessBefore.status).toBe("not-started");
    expect(readinessBefore.missing_requirements).toEqual(
      expect.arrayContaining(["provider-onboarding", "seller-agreement"]),
    );
    const before = await read(sellListApi);
    expect(before.items).toEqual([]);
    const salesBefore = await read("/api/marketplace/account/sales");
    const offerBefore = await read(`${sellListApi}/offer-matches/${offerId}`);
    expect(offerBefore.status).toBe("submitted");
    let addedLineId: string | undefined;
    const unexpectedSubmissions: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() !== "GET" &&
        /accept-offer|decline-offer|review-sell-list-checkout|checkout-sessions/.test(
          `${request.url()} ${request.postData() ?? ""}`,
        )
      )
        unexpectedSubmissions.push(new URL(request.url()).pathname);
    });
    try {
      await expectPageOk(page, "/account/offers/matches");
      const addForm = page
        .locator(`form:has(input[name="offerId"][value="${offerId}"])`)
        .filter({ has: page.getByRole("button", { name: "Add selected offer to Sell List", exact: true }) });
      await expect(addForm).toHaveCount(1);
      await addForm.getByRole("button", { name: "Add selected offer to Sell List", exact: true }).click();
      await expect(page).toHaveURL(/\/account\/sell-list/);
      await expect.poll(async () => (await read(sellListApi)).items.length).toBe(1);
      const populated = await read(sellListApi);
      const line = populated.items[0];
      expect(line.offer_id).toBe(offerId);
      addedLineId = line.line_id;
      const composite = await read(`${sellListApi}/composite-review`);
      const quote = composite.offerReviews.find((candidate: { lineId: string }) => candidate.lineId === addedLineId);
      expect(quote).toBeDefined();
      const money = (amount: number) =>
        new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
      const expectedNet = quote.terms
        ? money(Number(quote.terms.seller_net_unit_amount) * line.quantity)
        : "Not quoted yet";
      await expectPageOk(page, "/account/desk/offers");
      await expect(page).toHaveURL(/\/account\/desk\/offers$/);
      await expect(page.getByRole("heading", { name: "Offers & sell list", exact: true })).toBeVisible();
      await expect(page.getByText("Offers cannot be accepted yet.", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Payout setup", exact: true })).toHaveAttribute(
        "href",
        "/account/payouts/setup?returnTo=%2Faccount%2Fdesk%2Foffers",
      );
      const card = page.getByRole("button", { name: `Review ${line.item_title} offers and terms`, exact: true });
      await expect(card).toContainText(`Best offer net ${expectedNet}`);
      const dialog = page.getByRole("dialog", { name: `${line.item_title} offers and terms`, exact: true });
      const exerciseReview = async () => {
        for (const activation of ["pointer", "Enter", "Space"]) {
          if (activation === "pointer") await card.click();
          else {
            await card.focus();
            await card.press(activation);
          }
          await expect(dialog).toBeVisible();
          await expect(page.getByRole("dialog")).toHaveCount(1);
          await expect(dialog.getByText("Selected offer", { exact: true })).toBeVisible();
          await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
          await expect(dialog.getByRole("button", { name: "Continue to seller checkout", exact: true })).toBeDisabled();
          await dialog.getByRole("button", { name: "Close", exact: true }).click();
          await expect(dialog).toHaveCount(0);
        }
      };
      const selectOffer = async () => {
        await card.click();
        await expect(dialog).toBeVisible();
        await dialog.getByRole("checkbox", { name: /^Select .+ offer$/ }).check();
        await expect(dialog.getByRole("button", { name: "Accept selected", exact: true })).toBeDisabled();
        await expect(dialog.getByRole("button", { name: "Decline selected", exact: true })).toHaveAttribute(
          "form",
          "sell-list-checkout-form",
        );
      };
      const closeReview = async () => {
        await dialog.getByRole("button", { name: "Clear selection", exact: true }).click();
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
      };
      await page.setViewportSize({ width: 390, height: 844 });
      await exerciseReview();
      await captureResponsiveEvidence({ page, testInfo, claimId: "sell-list-review-closed-mobile" });
      await selectOffer();
      await captureResponsiveEvidence({ page, testInfo, claimId: "sell-list-review-open-mobile" });
      await closeReview();
      await page.setViewportSize({ width: 1280, height: 900 });
      await exerciseReview();
      await captureResponsiveEvidence({ page, testInfo, claimId: "sell-list-review-closed-desktop" });
      await selectOffer();
      await captureResponsiveEvidence({ page, testInfo, claimId: "sell-list-review-open-desktop" });
      await closeReview();
    } finally {
      const current = await read(sellListApi);
      const added = current.items.find((line: { offer_id: string }) => line.offer_id === offerId);
      if (added) {
        addedLineId ??= added.line_id;
        const removal = await page.request.post("/account/desk/offers", {
          form: { intent: "remove-sell-list-line", lineId: addedLineId! },
        });
        expect(removal.ok()).toBe(true);
      }
      await expect.poll(async () => (await read(sellListApi)).items).toEqual(before.items);
      const after = await read(sellListApi);
      expect(after.latestConfirmation).toEqual(before.latestConfirmation);
      expect(await read("/api/marketplace/account/sales")).toEqual(salesBefore);
      expect((await read(`${sellListApi}/offer-matches/${offerId}`)).status).toBe("submitted");
      expect(await read("/api/settlement/payout-readiness")).toEqual(readinessBefore);
      expect(unexpectedSubmissions).toEqual([]);
    }
  });
});
