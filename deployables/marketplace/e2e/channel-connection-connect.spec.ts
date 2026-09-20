import { expect, test } from "@playwright/test";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

test("manual-sync-panel-round-trip: connects and activates an independent real channel @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sign-in?returnTo=%2Faccount%2Fchannels", { waitUntil: "domcontentloaded" });
  await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSellerCredentials());
  await expect(page.getByRole("button", { name: "Connect a channel", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Sales Channel", exact: true }).selectOption("tcgplayer");
  await page.getByRole("button", { name: "Connect a channel", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/channels\/chn_[^/?]+(?:\?|$)/);
  const firstPath = new URL(page.url()).pathname;
  await expect(page.getByText("Pending setup", { exact: true })).toBeVisible();
  const activate = page.getByRole("button", { name: "Activate", exact: true });
  await expect(activate).toBeDisabled();
  const locations = page.getByRole("group", { name: "Storage locations" }).getByRole("checkbox");
  expect(await locations.count(), "the seeded seller must have an active Inventory storage location").toBeGreaterThan(
    0,
  );
  await locations.first().check();
  await expect(activate).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("channels-connect-design-system-390.png"), fullPage: true });
  await activate.click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Manual TCGplayer sync", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("channels-connect-design-system-desktop.png"), fullPage: true });
  await page.goto("/account/channels");
  await page.getByRole("button", { name: "Connect a channel", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/channels\/chn_[^/?]+(?:\?|$)/);
  expect(new URL(page.url()).pathname).not.toBe(firstPath);
  await expect(page.getByText("Pending setup", { exact: true })).toBeVisible();
});
