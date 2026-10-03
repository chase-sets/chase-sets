import { expect, test } from "@playwright/test";

// After #8503 the landing page keeps one fine-print disclosure; the FAQ group
// is also collapsed but emits no disclosure event (compare_faq prior art).
const disclosuresToOpen = [["fee_comparison", "fee_comparison_source_note"]] as const;
const landingSectionOrder = [
  "hero",
  "game_roster",
  "open_offers",
  "fee_comparison",
  "founders_offer",
  "final_cta",
  "faq",
] as const;
const faqQuestionCount = 4;

// #8503 AC5 measurement contract: Desktop Chrome project, 390x664, light,
// scroll at 0, measured after document.fonts.ready with the production
// counter state; collapsed disclosures stay collapsed.
const landingLength = {
  width: 390,
  height: 664,
  maxViewportHeights: 9.5,
  maxWords: 1_000,
} as const;

for (const variant of ["seller_first_v1", "seller_first_v2"] as const) {
  const landingPath = variant === "seller_first_v2" ? "/?intent=buy" : "/";

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
      await page.goto(landingPath, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        (window as { dataLayer?: Array<{ event?: string }> }).dataLayer?.some(
          (entry) => entry.event === "landing_page_view",
        ),
      );

      // AC1 on the deployed target: the seven identities in order, nothing retired.
      expect(
        await page.evaluate(() =>
          [...document.querySelectorAll("[data-public-presence-section]")].map((section) =>
            section.getAttribute("data-public-presence-section"),
          ),
        ),
      ).toEqual([...landingSectionOrder]);

      const disclosures = disclosuresToOpen.map(([, target]) => page.locator(`[data-landing-disclosure="${target}"]`));
      await expect(page.locator("[data-landing-disclosure]")).toHaveCount(disclosures.length);
      for (const disclosure of disclosures) {
        await expect(disclosure).toHaveCount(1);
        await expect(disclosure.locator("button")).toHaveAttribute("aria-expanded", "false");
      }
      const faqTriggers = page.locator('[data-public-presence-section="faq"] button[aria-expanded]');
      await expect(faqTriggers).toHaveCount(faqQuestionCount);
      for (let index = 0; index < faqQuestionCount; index += 1) {
        await expect(faqTriggers.nth(index)).toHaveAttribute("aria-expanded", "false");
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
      // Opening a FAQ item is not a tracked disclosure (AC4).
      await faqTriggers.first().click();
      await expect(faqTriggers.first()).toHaveAttribute("aria-expanded", "true");
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

  test(`${variant} landing length at ${landingLength.width}x${landingLength.height} (#8503 AC5) @public-web-public-presence`, async ({
    page,
    baseURL,
  }, testInfo) => {
    expect(testInfo.project.name).toBe("public-web-chromium");
    expect(baseURL).toBe(process.env.PUBLIC_WEB_URL);
    await page.setViewportSize({ width: landingLength.width, height: landingLength.height });
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      (window as { dataLayer?: unknown[] }).dataLayer = [];
    });
    await page.goto(landingPath, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      (window as { dataLayer?: Array<{ event?: string }> }).dataLayer?.some(
        (entry) => entry.event === "landing_page_view",
      ),
    );
    await page.evaluate(() => document.fonts.ready);

    const measurement = await page.evaluate(() => ({
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      words: (document.querySelector("main")?.innerText ?? "").split(/\s+/).filter(Boolean).length,
      expanded: document.querySelectorAll('[aria-expanded="true"]').length,
    }));
    const viewportHeights = measurement.scrollHeight / measurement.innerHeight;
    testInfo.annotations.push({
      type: "landing-length",
      description: `${variant}: ${viewportHeights.toFixed(2)} viewport heights, ${measurement.words} words`,
    });
    await page.screenshot({ path: testInfo.outputPath("length.png"), fullPage: true });

    expect(measurement.scrollY).toBe(0);
    expect(measurement.innerHeight).toBe(landingLength.height);
    expect(measurement.expanded).toBe(0);
    expect(viewportHeights).toBeLessThanOrEqual(landingLength.maxViewportHeights);
    expect(measurement.words).toBeLessThanOrEqual(landingLength.maxWords);
  });
}
