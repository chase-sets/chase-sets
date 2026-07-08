import { expect, test, type Page } from "@playwright/test";
import {
  authenticateAdmin,
  expectAdminWebHydrated,
  expectPageOk,
  skipDeployedAdminE2e,
  waitForProjectionPositionFromUrl,
} from "./support/admin-e2e";

test.describe("support admin platform feedback", () => {
  test("operator reviews platform feedback @admin-support", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/support/platform-feedback", "/access/sign-in");

    await expectPageOk(page, "/support/platform-feedback?status=new");
    await expect(page).toHaveURL(/\/support\/platform-feedback\?status=new$/);
    await expect(page.getByRole("heading", { name: "Platform Feedback" })).toBeVisible();
    await expectAdminWebHydrated(page);
    await expect(page.getByLabel("Status")).toHaveValue("new");
    await expect(page.getByLabel("Topic")).toHaveValue("all");
    await expect(page.getByLabel("Workflow")).toHaveValue("all");

    const { detailLink, feedbackId } = await waitForNewFeedbackLink(page);
    await detailLink.click();

    await expect(page).toHaveURL(new RegExp(`/support/platform-feedback/${feedbackId}$`));
    await expect(page.getByRole("heading", { name: `Feedback ${feedbackId}` })).toBeVisible();
    await expect(page.getByText("New").first()).toBeVisible();

    await page.getByRole("button", { name: "Mark reviewed" }).click();
    await page.waitForURL(
      (url) => url.pathname === `/support/platform-feedback/${feedbackId}` && url.search.includes("afterWrite"),
      { timeout: 30_000 },
    );
    const reviewedUrl = new URL(page.url());
    await waitForPlatformFeedbackProjection(page, reviewedUrl, `mark platform feedback ${feedbackId} reviewed`);
    await page.goto(reviewedUrl.pathname, { waitUntil: "domcontentloaded" });
    await expectReviewedFeedback(page, feedbackId);
  });
});

async function waitForNewFeedbackLink(page: Page) {
  const detailLinks = page.locator('a[href^="/support/platform-feedback/pfb_"]');
  let visibleHref: string | null = null;
  await expect
    .poll(
      async () => {
        for (let index = 0; index < (await detailLinks.count()); index += 1) {
          const candidate = detailLinks.nth(index);
          if (await candidate.isVisible().catch(() => false)) {
            visibleHref = await candidate.getAttribute("href");
            return visibleHref;
          }
        }

        if (!visibleHref) {
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        }

        return visibleHref;
      },
      { timeout: 45_000 },
    )
    .toMatch(/^\/support\/platform-feedback\/pfb_/);

  const href = visibleHref ?? "";
  const detailLink = page.locator(`a[href="${href}"]:visible`).first();
  const feedbackId = href.split("/").pop();
  expect(feedbackId, "new feedback row should link to a detail page").toBeTruthy();

  return { detailLink, feedbackId: feedbackId! };
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
      { intervals: [1_000, 2_000, 5_000], timeout: 45_000 },
    )
    .toBe(status);

  await page.reload({ waitUntil: "domcontentloaded" });
}

async function waitForPlatformFeedbackProjection(page: Page, url: URL, label: string) {
  await waitForProjectionPositionFromUrl(page, url, {
    sourceContextName: "platform-operations",
    targetContextName: "platform-operations",
    projectionName: "experience-platform-feedback-projection",
    label,
    allowLegacyCommitPositionFallback: true,
  });
}

async function expectReviewedFeedback(page: Page, feedbackId: string) {
  await waitForFeedbackStatus(page, feedbackId, "reviewed");
  await expect(page.getByText("Reviewed").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark reviewed" })).toHaveCount(0);
}
