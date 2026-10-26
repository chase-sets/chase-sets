import { expect, test } from "@playwright/test";
import { captureAccessibilityEvidence, captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

test("Pricing Health renders preview-only horizon and hurdle panels without mutation @marketplace-seller @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto("/sign-in?returnTo=%2Faccount%2Fdesk%2Fpricing-health", { waitUntil: "domcontentloaded" });
  await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSellerCredentials());
  const before = await page.request.get("/api/marketplace/account/pricing-health");
  expect(before.ok()).toBe(true);
  const beforeBody = await before.json();
  await page.goto("/account/desk/pricing-health");
  await expect(page.getByTestId("pricing-health-page")).toBeVisible();
  await expect(page.getByTestId("pricing-health-what-if")).toBeVisible();
  await expect(page.getByText("Horizon value curve", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Hurdle sweep", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("No product line", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.getByTestId("pricing-health-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-health-what-if-360" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.getByTestId("pricing-health-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-health-what-if-390" });
  await page.setViewportSize({ width: 820, height: 1180 });
  expect(
    await page.getByTestId("pricing-health-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  await captureResponsiveEvidence({ page, testInfo, claimId: "pricing-health-what-if-tablet" });
  await captureAccessibilityEvidence({ page, testInfo, surface: "Pricing Health what-if panels" });
  const after = await page.request.get("/api/marketplace/account/pricing-health");
  expect(await after.json()).toMatchObject({ target: beforeBody.target, whatIf: beforeBody.whatIf });
});
