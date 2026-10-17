import { expect, test } from "@playwright/test";
import { signInWithPassword } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

test.describe("marketplace notifications route", () => {
  test("renders the notification center as an account page and redirects retired sheet links @marketplace-account @browser-e2e-seed", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await signInWithPassword(page, new URL(page.url()).origin, marketplaceBrowserE2eSellerCredentials());

    await page.goto("/account/notifications", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/account\/notifications$/);
    await expect(page.getByRole("heading", { level: 1, name: "Notifications", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent updates", exact: true })).toBeVisible();
    await expect(page.getByText("Notifications could not load")).toHaveCount(0);

    await page.goto("/search?notifications=feed", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/account\/notifications$/);
    await expect(page.getByRole("heading", { name: "Recent updates", exact: true })).toBeVisible();

    await page.goto("/?notifications=settings", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/account\/notifications\?view=settings$/);
    await expect(page.getByRole("heading", { name: "Delivery settings", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Product alerts", exact: true })).toBeVisible();
    await expect(page.getByText("Notifications could not load")).toHaveCount(0);
  });
});
