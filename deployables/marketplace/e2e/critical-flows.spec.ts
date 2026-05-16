import { expect, test, type Page } from "@playwright/test";

const demoOwner = {
  email: "demo@chasesets.test",
  password: "demo1234",
};

async function signInWithPassword(page: Page, credentials = demoOwner) {
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByRole("textbox", { name: /Password/ }).fill(credentials.password);
  await page.getByRole("button", { name: /^Sign in$/i }).click();
}

test.describe("marketplace critical flows", () => {
  test("signed-out shoppers can browse, search, and reach auth entry points", async ({ page }) => {
    await page.goto("/search");

    const searchBox = page.getByRole("searchbox").first();
    await expect(searchBox).toBeVisible();
    await expect(page.getByText(/Find cards, comics, figures, sneakers/i)).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign In" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Register" }).first()).toBeVisible();

    await searchBox.fill("charizard");
    await expect(searchBox).toHaveValue("charizard");
    await expect(page.getByRole("link", { name: /View details for Charizard/ }).first()).toBeVisible();

    await page.getByRole("link", { name: "Sign In" }).first().click();
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByText(/^Sign in$/i).first()).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("textbox", { name: /Password/ })).toBeVisible();

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

    await expect(page).toHaveURL(/\/account\/cart/);
    await expect(page.getByText(/^Cart$/i).first()).toBeVisible();

    await page.goto("/account/listings");
    await expect(page).toHaveURL(/\/account\/listings/);
    await expect(page.getByRole("heading", { name: "Listings", exact: true })).toBeVisible();
  });
});
