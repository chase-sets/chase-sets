import { expect, test } from "@playwright/test";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

const routePath = "/account/channels/connection-seed-tcgplayer-manual";

test.describe("manual TCGplayer clamp recovery", () => {
  test("drives recovery, retry, download, and release on the real account route @marketplace-account @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    let claimed = false;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/sign-in?returnTo=${encodeURIComponent(routePath)}`, { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSellerCredentials());

    try {
      await expect(page).toHaveURL(new RegExp(`${routePath.replaceAll("/", "\\/")}(?:\\?|$)`));
      await expect(page.getByRole("heading", { name: /^Manual TCGplayer sync$/i })).toBeVisible();
      const retryButton = page.getByRole("button", { name: /^Retry inbound clamp$/i });
      const releaseButton = page.getByRole("button", { name: /^Release before submission$/i });
      if (testInfo.retry === 0) {
        await expect(page.getByText(/^Inbound clamp recovery needs review$/i)).toBeVisible();
        await expect(retryButton).toBeVisible();
        await expect(page.getByText(/^Ready to download$/i)).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Clamp and download CSV$/i })).toHaveCount(0);
      } else {
        if (await releaseButton.isVisible().catch(() => false)) await releaseButton.click();
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        "the recovery panel must fit the 390px account viewport",
      ).toBe(true);

      if (await retryButton.isVisible().catch(() => false)) await retryButton.click();
      await expect(page.getByText(/^Ready to download$/i)).toBeVisible();
      await expect(page.getByText(/^Inbound clamp recovery needs review$/i)).toHaveCount(0);
      const downloadButton = page.getByRole("button", { name: /^Clamp and download CSV$/i });
      await expect(downloadButton).toBeVisible();

      claimed = true;
      const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
      expect(download.suggestedFilename()).toMatch(/^tcgplayer-staged-run-seed-tcgplayer-manual-recovery\.csv$/);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText(/^Claimed$/i)).toBeVisible();
      await expect(page.getByRole("button", { name: /^Release before submission$/i })).toBeVisible();

      await page.getByRole("button", { name: /^Release before submission$/i }).click();
      await expect(page.getByText(/^Ready to download$/i)).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        "the released panel must fit the 390px account viewport",
      ).toBe(true);
      claimed = false;
    } finally {
      if (claimed) {
        await page.goto(routePath, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        const release = page.getByRole("button", { name: /^Release before submission$/i });
        if (await release.isVisible().catch(() => false)) await release.click().catch(() => undefined);
      }
    }
  });
});
