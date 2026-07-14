import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { registerOrSignInSyntheticAccount, signInWithPassword } from "./support/auth";

const configuredMarketplaceAccount = {
  email: process.env.MARKETPLACE_E2E_EMAIL?.trim() ?? "",
  password: process.env.MARKETPLACE_E2E_PASSWORD?.trim() ?? "",
};

const searchQuery = process.env.MARKETPLACE_E2E_SEARCH_QUERY ?? "charizard";
const syntheticAccountRunId = (process.env.GITHUB_RUN_ID ?? `${Date.now()}-${process.pid}`)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .slice(0, 12);
const syntheticAccountNonce = Math.random().toString(36).slice(2, 8);
const authProjectionTimeoutMs = 90_000;

const accountCriticalRoutes = [
  { path: "/account/cart", heading: /^Your cart$/i, flow: "buy cart" },
  { path: "/account/sell-list", heading: /^Sell List$/i, flow: "sell list" },
  { path: "/account/listings", heading: /^Listings$/i, flow: "listings" },
  { path: "/account/offers/submitted", heading: /^Submitted Offers$/i, flow: "submitted offers" },
  { path: "/account/offers/matches", heading: /^Offer Matches$/i, flow: "offer matches" },
  { path: "/account/inventory", heading: /^Inventory$/i, flow: "inventory" },
  { path: "/account/purchases", heading: /^Purchases$/i, flow: "purchases" },
  { path: "/account/sales", heading: /^Sales$/i, flow: "sales" },
  { path: "/account/settlement", heading: /^Wallet$/i, flow: "wallet" },
  { path: "/account/payouts", heading: /^Payouts$/i, flow: "payouts" },
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

  const titleSlug = testInfo.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20);

  return {
    email: `critical-flow-${syntheticAccountRunId}-${syntheticAccountNonce}-${testInfo.workerIndex}-${testInfo.retry}-${titleSlug}@chasesets.test`,
    password: `critical-flow-${syntheticAccountRunId}-${testInfo.workerIndex}-${testInfo.retry}`,
    displayName: `Critical Flow ${syntheticAccountRunId} ${syntheticAccountNonce} ${testInfo.workerIndex} ${testInfo.retry} ${titleSlug}`,
    shouldRegister: true,
  };
}

async function authenticateAccount(page: Page, testInfo: TestInfo) {
  await expectPageOk(page, "/");
  const origin = new URL(page.url()).origin;
  const credentials = marketplaceAccountFor(testInfo);

  if (credentials.shouldRegister) {
    return {
      ...credentials,
      sessionToken: await registerOrSignInSyntheticAccount(page, origin, credentials),
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
    await expect(page.getByText(/Find cards, comics, figures, sneakers/i)).toBeVisible();
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
    await expect(page.getByText(/Create an account with a passkey/i)).toBeVisible();
    await expect(page.getByText("Passkey").first()).toBeVisible();
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

  test("signed-in account can reach critical marketplace commerce surfaces @marketplace-seller", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    await authenticateAccount(page, testInfo);
    await expectAccountRouteReady(page, accountCriticalRoutes[0]);

    for (const route of accountCriticalRoutes) {
      await test.step(`open ${route.flow}`, async () => {
        await expectAccountRouteReady(page, route);
      });
    }
  });
});
