import { expect, test, type Page } from "@playwright/test";

const marketplaceAccount = {
  email: process.env.MARKETPLACE_E2E_EMAIL ?? "demo@chasesets.test",
  password: process.env.MARKETPLACE_E2E_PASSWORD ?? "demo1234",
};

const searchQuery = process.env.MARKETPLACE_E2E_SEARCH_QUERY ?? "charizard";

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

async function expectPageOk(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} did not return a page response`).not.toBeNull();
  expect(response!.status(), `${path} returned HTTP ${response!.status()}`).toBeLessThan(400);
}

async function signInWithPassword(page: Page, credentials = marketplaceAccount) {
  await expectPageOk(page, "/");
  const origin = new URL(page.url()).origin;
  const response = await page.request.post(`${origin}/api/auth/password-sign-in`, {
    data: credentials,
  });
  expect(response.status(), "password sign-in should start a session").toBe(200);
  const body = (await response.json()) as { sessionToken?: string };
  expect(body.sessionToken, "password sign-in should return a session token").toBeTruthy();

  await page.context().addCookies([
    {
      name: "chase_sets_session",
      value: body.sessionToken!,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https://"),
    },
  ]);
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

  test("seeded account can sign in, review cart, and reach seller listings", async ({ page }) => {
    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    await signInWithPassword(page);

    await page.goto("/account/cart");
    await expect(page).toHaveURL(/\/account\/cart/);
    await expect(page.getByText(/^Buy Cart$/i).first()).toBeVisible();

    await page.goto("/account/listings");
    await expect(page).toHaveURL(/\/account\/listings/);
    await expect(page.getByRole("heading", { name: "Listings", exact: true })).toBeVisible();
  });

  test("signed-in account can reach critical marketplace commerce surfaces", async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    await signInWithPassword(page);
    await page.goto("/account/cart");
    await expect(page).toHaveURL(/\/account\/cart/);

    for (const route of accountCriticalRoutes) {
      await test.step(`open ${route.flow}`, async () => {
        await expectPageOk(page, route.path);
        await expect(page).toHaveURL(new RegExp(route.path.replaceAll("/", "\\/")));
        await expect(page.getByRole("heading", { name: route.heading }).first()).toBeVisible();
      });
    }
  });
});
