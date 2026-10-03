import { expect, test } from "@playwright/test";

const disclosuresToOpen = [
  ["fee_comparison", "fee_comparison_source_note"],
  ["fee_calculator", "fee_calculator_source_note"],
  ["launch_timeline", "launch_timeline_wave_qualification"],
  ["product_preview", "product_preview_trust"],
] as const;

for (const variant of ["seller_first_v1", "seller_first_v2"] as const) {
  for (const presentation of [
    { name: "mobile-light", width: 375, height: 900, colorScheme: "light" as const },
    { name: "desktop-dark", width: 1440, height: 900, colorScheme: "dark" as const },
  ]) {
    test(`${variant} disclosure vector at ${presentation.name} @public-web-public-presence`, async ({
      page,
      baseURL,
    }, testInfo) => {
      expect(testInfo.project.name).toBe("public-web-chromium");
      expect(baseURL).toBe(process.env.PUBLIC_WEB_URL);
      await page.setViewportSize({ width: presentation.width, height: presentation.height });
      await page.emulateMedia({ colorScheme: presentation.colorScheme });
      await page.addInitScript(() => {
        (window as { dataLayer?: unknown[] }).dataLayer = [];
      });
      await page.goto(variant === "seller_first_v2" ? "/?intent=buy" : "/", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        (window as { dataLayer?: Array<{ event?: string }> }).dataLayer?.some(
          (entry) => entry.event === "landing_page_view",
        ),
      );

      const disclosures = disclosuresToOpen.map(([, target]) => page.locator(`[data-landing-disclosure="${target}"]`));
      for (const disclosure of disclosures) {
        await expect(disclosure).toHaveCount(1);
        await expect(disclosure.locator("button")).toHaveAttribute("aria-expanded", "false");
      }
      await page.screenshot({ path: testInfo.outputPath("collapsed.png"), fullPage: true });

      for (const disclosure of disclosures) {
        await disclosure.locator("button").click();
        await expect(disclosure.locator("button")).toHaveAttribute("aria-expanded", "true");
        const content = disclosure.locator("p").last();
        await expect(content).toBeVisible();
        const rectangle = await content.boundingBox();
        expect(rectangle?.width).toBeGreaterThan(0);
        expect(rectangle?.height).toBeGreaterThan(0);
      }
      const opened = await page.evaluate(() =>
        (window as { dataLayer?: Array<{ event?: string }> }).dataLayer?.filter(
          (entry) => entry.event === "disclosure_opened",
        ),
      );
      expect(opened).toEqual(
        disclosuresToOpen.map(([section, target]) => ({ event: "disclosure_opened", section, target, variant })),
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("expanded.png"), fullPage: true });
    });
  }
}

// First-screen signup fit (#8504), measured under #8503's contract: light
// scheme, scroll 0, after `document.fonts.ready`, with the counter shown. The
// count and promo responses are stubbed in the browser so the counter and the
// promo bar above the nav always render, as they do in production; every
// target must be present and visible, never conditionally skipped.
const firstScreenDisplayCount = 125;
const firstScreenPromoMessages = {
  items: [
    {
      id: "landing-first-screen-evidence",
      title: "Landing first-screen evidence",
      description: "Stubbed promo message for the landing first-screen check.",
      tone: "info",
    },
  ],
};

for (const variant of ["seller_first_v1", "seller_first_v2"] as const) {
  for (const viewport of [
    { width: 390, height: 664, submitInFirstScreen: true },
    { width: 375, height: 667, submitInFirstScreen: false },
  ]) {
    test(`${variant} first screen at ${viewport.width}x${viewport.height} @public-web-public-presence`, async ({
      page,
      baseURL,
    }, testInfo) => {
      expect(testInfo.project.name).toBe("public-web-chromium");
      expect(baseURL).toBe(process.env.PUBLIC_WEB_URL);
      await page.route("**/api/public-presence/waitlist/count", (request) =>
        request.fulfill({ json: { displayCount: firstScreenDisplayCount } }),
      );
      await page.route("**/api/public-presence/promo-bar-messages", (request) =>
        request.fulfill({ json: firstScreenPromoMessages }),
      );
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(variant === "seller_first_v2" ? "/?intent=buy" : "/", { waitUntil: "domcontentloaded" });

      const panel = page.locator("#waitlist-form");
      await expect(page.locator('section[aria-label="Marketplace announcements"]')).toBeVisible();
      await expect(panel.getByText(`${firstScreenDisplayCount}+`)).toBeVisible();
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      const email = panel.locator('input[name="email"]');
      const submit = panel.locator('button[type="submit"]');
      await expect(email).toHaveCount(1);
      await expect(email).toBeVisible();
      await expect(submit).toHaveCount(1);
      await expect(submit).toBeVisible();
      const emailBox = await email.boundingBox();
      const submitBox = await submit.boundingBox();
      expect(emailBox).not.toBeNull();
      expect(submitBox).not.toBeNull();
      const innerHeight = await page.evaluate(() => window.innerHeight);
      const navBottom = await page.locator("nav").evaluate((nav) => nav.getBoundingClientRect().bottom);
      testInfo.annotations.push({
        type: "first-screen",
        description: JSON.stringify({
          innerHeight,
          navBottom,
          emailTop: emailBox!.y,
          emailBottom: emailBox!.y + emailBox!.height,
          submitBottom: submitBox!.y + submitBox!.height,
        }),
      });
      await page.screenshot({ path: testInfo.outputPath("first-screen.png") });

      expect(emailBox!.y).toBeGreaterThanOrEqual(0);
      expect(emailBox!.y + emailBox!.height, "email input bottom within the first screen").toBeLessThanOrEqual(
        innerHeight,
      );
      if (viewport.submitInFirstScreen) {
        expect(submitBox!.y + submitBox!.height, "submit button bottom within the first screen").toBeLessThanOrEqual(
          innerHeight,
        );
      }
    });
  }
}
