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
