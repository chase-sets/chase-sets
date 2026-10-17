import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import {
  authenticatePlatformAdmin,
  expectAdminWebHydrated,
  expectPageOk,
  skipDeployedAdminE2e,
  waitForProjectionPositionFromResponse,
} from "./support/admin-e2e";

test.describe("support admin platform feedback", () => {
  test("records seeded feedback furniture mobile @admin-support @browser-e2e-seed", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSeededFeedback(page);
    const light = await feedbackFurniture(page, "light");
    await captureResponsiveEvidence({ page, testInfo, claimId: "card-feedback-mobile-light" });
    const dark = await feedbackFurniture(page, "dark");
    await captureResponsiveEvidence({ page, testInfo, claimId: "card-feedback-mobile-dark" });
    expect(dark, "theme must preserve accessible roles, names and order").toBe(light);
    await testInfo.attach("feedback-mobile-accessibility", {
      body: JSON.stringify({ light, dark }),
      contentType: "application/json",
    });
  });

  test("records seeded feedback furniture desktop @admin-support @browser-e2e-seed", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSeededFeedback(page);
    const light = await feedbackFurniture(page, "light");
    await captureResponsiveEvidence({ page, testInfo, claimId: "card-feedback-desktop-light" });
    const dark = await feedbackFurniture(page, "dark");
    await captureResponsiveEvidence({ page, testInfo, claimId: "card-feedback-desktop-dark" });
    expect(dark, "theme must preserve accessible roles, names and order").toBe(light);
    await testInfo.attach("feedback-desktop-accessibility", {
      body: JSON.stringify({ light, dark }),
      contentType: "application/json",
    });
  });

  test("operator reviews platform feedback @admin-support", async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticatePlatformAdmin(page, "/support/platform-feedback", "/access/sign-in");

    await expectPageOk(page, "/support/platform-feedback?status=new");
    await expect(page).toHaveURL(/\/support\/platform-feedback\?status=new$/);
    await expect(page.getByRole("heading", { name: "Platform Feedback", exact: true })).toBeVisible();
    await expectAdminWebHydrated(page);
    await expect(page.getByLabel("Status")).toHaveValue("new");
    await expect(page.getByLabel("Topic")).toHaveValue("all");
    await expect(page.getByLabel("Workflow")).toHaveValue("all");

    const feedbackId = await submitFreshPlatformFeedback(page);
    const detailLink = await waitForFeedbackLink(page, feedbackId);
    await detailLink.click();

    await expect(page).toHaveURL(new RegExp(`/support/platform-feedback/${feedbackId}$`));
    await expect(page.getByRole("heading", { name: `Feedback ${feedbackId}` })).toBeVisible();
    await expect(page.getByText("New").first()).toBeVisible();

    await markFeedbackReviewed(page, feedbackId);
    await expect(page).toHaveURL((url) => url.pathname === `/support/platform-feedback/${feedbackId}`);
    await expectReviewedFeedback(page, feedbackId);
  });
});

async function openSeededFeedback(page: Page) {
  const route = "/support/platform-feedback/pfb_seed_checkout";
  await authenticatePlatformAdmin(page, route, "/access/sign-in");
  await expectPageOk(page, route);
  await expectAdminWebHydrated(page);
  await expect(page.getByRole("heading", { name: "Feedback pfb_seed_checkout", exact: true })).toBeVisible();
}

async function feedbackFurniture(page: Page, mode: "light" | "dark") {
  await page.emulateMedia({ colorScheme: mode });
  const theme = page.locator("[data-chase-theme]").first();
  await expect(theme).toBeVisible();
  await theme.evaluate((element, value) => element.setAttribute("data-color-mode", value), mode);
  await expect(theme).toHaveAttribute("data-color-mode", mode);
  const target = page.locator('[data-card-emitter="detail-panel"]:has(> div > div:text-is("Feedback"))');
  await expect(target).toHaveCount(1);
  await expect(target).toBeVisible();
  await expect(target).toContainText("Checkout totals were clear before payment.");
  await expect(target.locator("dl dt")).not.toHaveCount(0);
  await expect(target).toHaveClass("rounded-tokenLg overflow-hidden bg-surface-2 p-4");
  const chrome = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { shadow: style.boxShadow, border: style.borderTopWidth, fill: style.backgroundColor };
  });
  expect(chrome).toMatchObject({ shadow: "none", border: "0px" });
  expect(chrome.fill).not.toBe("rgba(0, 0, 0, 0)");
  return target.ariaSnapshot();
}

async function submitFreshPlatformFeedback(page: Page) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.post(`${origin}/api/experience/platform-feedback`, {
    data: {
      rating: 5,
      topic: "ease-of-use",
      comment: "E2E admin support feedback review coverage.",
      followUpConsent: false,
      workflow: "checkout-payment",
      sourceRoutePath: "/support/platform-feedback",
      relatedEntities: [{ type: "e2e", id: `admin-support-${Date.now().toString(36)}` }],
    },
  });

  expect(response.status(), "platform feedback submission should create a new feedback item").toBe(201);
  const body = (await response.json()) as { id?: string };
  expect(body.id, "platform feedback submission should return a feedback id").toMatch(/^pfb_/);
  await waitForPlatformFeedbackProjection(page, response, `submit platform feedback ${body.id}`);
  return body.id!;
}

async function waitForFeedbackLink(page: Page, feedbackId: string) {
  const href = `/support/platform-feedback/${feedbackId}`;
  const detailLink = page.locator(`a[href="${href}"]:visible`).first();
  await expect
    .poll(
      async () => {
        if (await detailLink.isVisible().catch(() => false)) {
          return href;
        }

        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        return null;
      },
      { timeout: 90_000 },
    )
    .toMatch(/^\/support\/platform-feedback\/pfb_/);

  return detailLink;
}

async function markFeedbackReviewed(page: Page, feedbackId: string) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.post(`${origin}/api/experience/platform-feedback/${feedbackId}/review`, {
    data: {},
  });
  expect(response.status(), "platform feedback review command should succeed").toBe(200);
  await waitForPlatformFeedbackProjection(page, response, `mark platform feedback ${feedbackId} reviewed`);
}

async function waitForFeedbackStatus(page: Page, feedbackId: string, status: "reviewed") {
  const origin = new URL(page.url()).origin;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${origin}/api/experience/platform-feedback/${feedbackId}`);
        if (response.status() !== 200) {
          return null;
        }

        const body = (await response.json()) as { status?: string };
        return body.status ?? null;
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 90_000 },
    )
    .toBe(status);

  await page.reload({ waitUntil: "domcontentloaded" });
}

async function waitForPlatformFeedbackProjection(page: Page, response: APIResponse, label: string) {
  await waitForProjectionPositionFromResponse(page, response, {
    sourceContextName: "platform-operations",
    targetContextName: "platform-operations",
    projectionName: "experience-platform-feedback-projection",
    label,
  });
}

async function expectReviewedFeedback(page: Page, feedbackId: string) {
  await waitForFeedbackStatus(page, feedbackId, "reviewed");
  await expect(page.getByText("Reviewed").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark reviewed" })).toHaveCount(0);
}
