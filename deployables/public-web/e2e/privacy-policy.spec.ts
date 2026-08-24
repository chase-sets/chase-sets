import { expect, test } from "@playwright/test";

// Real-browser lifecycle proof for the counsel-pending /privacy candidate.
//
// `/privacy` is a Public Presence route contributed to the public-web deployable
// only, so this spec lives beside that deployable and runs on the public-web
// Playwright project against PUBLIC_WEB_URL. The marketplace host does not serve
// the route at all: pointing this spec at it renders the marketplace not-found
// shell and fails for the wrong reason.
//
// Every wait keys on a selector, a URL, or a DOM state. `networkidle` is never
// used: public-web shares the platform runtime shell with hosts that keep
// SSE-backed connections open, so a network-idle wait would either hang or pass
// for the wrong reason. Nothing here builds a synthetic DOM — the assertions
// read the page the real route adapter renders.

const privacySubjectIds = [
  "privacy-notice-scope",
  "data-categories-and-sources",
  "purposes-of-use",
  "recipients-and-disclosures",
  "stripe-managed-processing",
  "cookies-and-analytics",
  "gpc-and-sale-share",
  "privacy-rights-and-requests",
  "retention",
  "children",
  "state-supplements",
  "automated-decisionmaking-technology",
] as const;

// Manifest content is packet-only. If any of these strings renders, the review
// packet has leaked into the public notice.
const packetOnlyMarkers = [
  "Disclose the derived first-party cookie set",
  "Define who the notice speaks for",
  "counsel formatting judgment",
  "bounded-contexts/auth/support/request-support/cookies.ts:1",
  "privacy-product-truth-inventory.mjs",
] as const;

test.describe("public-presence/public-web privacy policy route", () => {
  // Negative control for the host this suite reads. Playwright resolves the
  // project and its baseURL before any assertion here, so a spec that drifts
  // back under another deployable's testMatch — or a public-web project wired to
  // some other host — fails on the routing fact instead of silently asserting
  // against a not-found shell.
  test.beforeEach(({ baseURL }, testInfo) => {
    expect(testInfo.project.name, "the privacy policy candidate is public-web coverage").toBe("public-web-chromium");
    const configuredPublicWebUrl = process.env.PUBLIC_WEB_URL;
    if (configuredPublicWebUrl) {
      expect(baseURL, "the public-web project must target PUBLIC_WEB_URL").toBe(configuredPublicWebUrl);
    }
  });

  test("renders the counsel-pending candidate with agreeing body and metadata @public-web-public-presence", async ({
    page,
  }) => {
    await page.goto("/privacy", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/privacy$/);

    const policyPage = page.locator('[data-policy-key="privacy-policy"]');
    await expect(policyPage).toBeVisible();

    // Machine metadata and visible body must agree on pending posture.
    await expect(policyPage).toHaveAttribute("data-policy-publication-status", "counsel-review-required");
    await expect(policyPage).toHaveAttribute("data-policy-version", "v1");
    await expect(policyPage).toHaveAttribute("data-policy-effective-at", "");
    await expect(page.getByText("Counsel review required before this document takes effect")).toBeVisible();
    await expect(page.getByText("Effective date pending counsel approval")).toBeVisible();

    await expect(page.locator('meta[name="chase-sets:policy-publication-status"]').first()).toHaveAttribute(
      "content",
      "counsel-review-required",
    );
    await expect(page.locator('meta[name="chase-sets:policy-key"]').first()).toHaveAttribute(
      "content",
      "privacy-policy",
    );
    await expect(page.locator('meta[name="chase-sets:policy-effective-at"]')).toHaveCount(0);

    // Every required subject renders with an addressable heading.
    for (const subjectId of privacySubjectIds) {
      await expect(page.locator(`#${subjectId}`), subjectId).toBeVisible();
    }
    await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();

    // Derived product-truth subjects the notice must actually disclose.
    const cookiesSection = page.locator('section[aria-labelledby="cookies-and-analytics"]');
    await expect(cookiesSection).toBeVisible();
    const cookiesText = (await cookiesSection.innerText()).replace(/\s+/g, " ");
    for (const subject of [
      "chase_sets_session",
      "chase_sets_anonymous_cart",
      "chase_sets_color_mode",
      "chase-sets:marketplace:recent-searches",
      "chase-sets-theme",
      "chase-sets:review-draft:",
      "discovery.search.restoration.v2",
      "discovery.search.loader-cache.v1",
      "/account/payment-methods",
      "/account/desk/settings",
      "chase-sets-marketplace-pwa-v1",
      "utm_source",
      "referrer",
    ]) {
      expect(cookiesText, subject).toContain(subject);
    }

    // Operator-only subjects stay outside the consumer notice boundary.
    const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    expect(bodyText).not.toContain("catalog.primaryWorkbench.observationSelection.");
    expect(bodyText).not.toContain("chase-sets-admin-pwa-v1");

    // Packet-only review-manifest content never renders.
    for (const marker of packetOnlyMarkers) {
      expect(bodyText, marker).not.toContain(marker);
    }

    // The document is a candidate, not an approved notice.
    expect(bodyText).not.toContain("Effective date:");
  });

  test("links every subject from the on-page table of contents @public-web-public-presence", async ({ page }) => {
    await page.goto("/privacy", { waitUntil: "domcontentloaded" });
    const tableOfContents = page.locator('nav[aria-label="Document sections"]');
    await expect(tableOfContents).toBeVisible();

    for (const subjectId of privacySubjectIds) {
      await expect(tableOfContents.locator(`a[href="#${subjectId}"]`), subjectId).toHaveCount(1);
    }

    await tableOfContents.locator('a[href="#cookies-and-analytics"]').click();
    await expect(page).toHaveURL(/#cookies-and-analytics$/);
    await expect(page.locator("#cookies-and-analytics")).toBeInViewport();
  });
});
