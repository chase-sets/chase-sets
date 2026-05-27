import { expect, test, type Page, type TestInfo } from "@playwright/test";

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
  { path: "/account/cart", heading: /^Buy Cart$/i, flow: "buy cart" },
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

type AccountCriticalRoute = (typeof accountCriticalRoutes)[number];

async function expectPageOk(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} did not return a page response`).not.toBeNull();
  expect(response!.status(), `${path} returned HTTP ${response!.status()}`).toBeLessThan(400);
}

async function expectAccountRouteReady(page: Page, route: AccountCriticalRoute) {
  const deadline = Date.now() + authProjectionTimeoutMs;
  let lastPathname = "";

  while (Date.now() < deadline) {
    const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
    expect(response, `${route.path} did not return a page response`).not.toBeNull();
    expect(response!.status(), `${route.path} returned HTTP ${response!.status()}`).toBeLessThan(400);

    lastPathname = new URL(page.url()).pathname;
    if (lastPathname === route.path) {
      await expect(page.getByRole("heading", { name: route.heading }).first()).toBeVisible();
      return;
    }

    await page.waitForTimeout(1_000);
  }

  expect(lastPathname, `${route.flow} should be reachable as the authenticated account`).toBe(route.path);
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

async function addSessionCookie(page: Page, origin: string, sessionToken: string) {
  await page.context().addCookies([
    {
      name: "chase_sets_session",
      value: sessionToken,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https://"),
    },
  ]);

  const sessionCookie = (await page.context().cookies(origin)).find((cookie) => cookie.name === "chase_sets_session");
  expect(sessionCookie, "browser context should store the auth session cookie").toBeTruthy();
}

async function submitBrowserForm(page: Page, fields: Record<string, string>) {
  await page.locator("body").evaluate((body, formFields) => {
    const form = document.createElement("form");
    form.method = "post";
    form.action = window.location.href;

    for (const [name, value] of Object.entries(formFields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.append(input);
    }

    body.append(form);
    form.submit();
  }, fields);
}

async function signInWithConfiguredPassword(
  page: Page,
  origin: string,
  credentials: ReturnType<typeof marketplaceAccountFor>,
) {
  const response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
    data: {
      email: credentials.email,
      password: credentials.password,
    },
  });

  expect(response.status(), "password sign-in should start a session").toBe(200);
  const body = (await response.json()) as { sessionToken?: string };
  expect(body.sessionToken, "password sign-in should return a session token").toBeTruthy();
  await addSessionCookie(page, origin, body.sessionToken!);
}

async function registerSyntheticAccount(page: Page, origin: string, account: ReturnType<typeof marketplaceAccountFor>) {
  await expectPageOk(page, "/register?returnTo=%2Faccount%2Fcart");

  await Promise.all([
    page.waitForURL(/\/account\/cart/, { timeout: authProjectionTimeoutMs }),
    submitBrowserForm(page, {
      intent: "password",
      registrationMethod: "password",
      displayName: account.displayName,
      email: account.email,
      password: account.password,
    }),
  ]);

  const sessionCookie = (await page.context().cookies(origin)).find((cookie) => cookie.name === "chase_sets_session");
  expect(sessionCookie, "marketplace registration should set the browser auth session cookie").toBeTruthy();
}

async function authenticateAccount(page: Page, testInfo: TestInfo) {
  await expectPageOk(page, "/");
  const origin = new URL(page.url()).origin;
  const credentials = marketplaceAccountFor(testInfo);

  if (credentials.shouldRegister) {
    await registerSyntheticAccount(page, origin, credentials);
    return;
  }

  await signInWithConfiguredPassword(page, origin, credentials);
}

test.describe("marketplace critical flows", () => {
  test("signed-out shoppers can browse, search, and reach auth entry points", async ({ page }) => {
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

  test("protected account routes preserve the requested return path", async ({ page }) => {
    await page.goto("/account/listings");
    await expect(page).toHaveURL(/\/sign-in/);

    const redirectedUrl = new URL(page.url());
    expect(redirectedUrl.searchParams.get("returnTo")).toBe("/account/listings");
    await expect(page.getByText(/^Sign in$/i).first()).toBeVisible();
  });

  test("account can authenticate, review cart, and reach seller listings", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    await authenticateAccount(page, testInfo);

    await expectAccountRouteReady(page, accountCriticalRoutes[0]);
    await expectAccountRouteReady(page, accountCriticalRoutes[2]);
  });

  test("signed-in account can reach critical marketplace commerce surfaces", async ({ page }, testInfo) => {
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
