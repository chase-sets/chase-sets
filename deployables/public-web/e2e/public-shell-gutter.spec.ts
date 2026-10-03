import { expect, test, type Locator } from "@playwright/test";

// Real-browser proof that the public shell renders exactly one horizontal
// content gutter (#8499). The promo bar, nav and the first section inside
// `main` must share the same left and right edges at phone and desktop widths,
// so page content never sits narrower than the furniture above it.
//
// This spec runs on the public-web Playwright project against PUBLIC_WEB_URL
// (deployed target only) and is advisory; hosted CI gates the rendered-class
// contract in public-pages.test.tsx. The promo-message response is stubbed in
// the browser so the populated promo-bar state is always exercised; every
// target must be present and visible, never conditionally skipped.

const edgeToleranceCssPx = 1;
const shellContainerMaxWidthCssPx = 1280;
const promoMessages = {
  items: [
    {
      id: "public-shell-gutter-evidence",
      title: "Public shell gutter evidence",
      description: "Stubbed promo message for the shell gutter alignment check.",
      tone: "info",
    },
  ],
};

const routes = ["/", "/compare/tcgplayer"] as const;
const viewports = [
  { name: "phone", width: 375, height: 800, gutter: 16 },
  { name: "desktop", width: 1440, height: 900, gutter: 24 },
] as const;

async function requireEdges(locator: Locator, name: string) {
  await expect(locator, `${name} is present exactly once`).toHaveCount(1);
  await expect(locator, `${name} is visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${name} has observable layout`).not.toBeNull();
  expect(box!.width, `${name} has width`).toBeGreaterThan(0);
  return { left: box!.x, right: box!.x + box!.width };
}

for (const route of routes) {
  for (const viewport of viewports) {
    test(`${route} shell edges align at ${viewport.name} ${viewport.width}px @public-web-public-presence`, async ({
      page,
      baseURL,
    }, testInfo) => {
      expect(testInfo.project.name).toBe("public-web-chromium");
      expect(baseURL).toBe(process.env.PUBLIC_WEB_URL);
      await page.route("**/api/public-presence/promo-bar-messages", (request) =>
        request.fulfill({ json: promoMessages }),
      );
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(route, { waitUntil: "domcontentloaded" });

      const promo = await requireEdges(page.locator('section[aria-label="Marketplace announcements"]'), "promo bar");
      const nav = await requireEdges(page.locator("nav"), "nav");
      const firstSection = await requireEdges(
        page.locator("main#main-content > :first-child > :first-child"),
        "first section inside main",
      );

      for (const [name, edges] of [
        ["promo bar", promo],
        ["first section", firstSection],
      ] as const) {
        expect(Math.abs(edges.left - nav.left), `${name} left edge matches nav`).toBeLessThanOrEqual(
          edgeToleranceCssPx,
        );
        expect(Math.abs(edges.right - nav.right), `${name} right edge matches nav`).toBeLessThanOrEqual(
          edgeToleranceCssPx,
        );
      }

      // One gutter, not two: the content edge sits one `Page` gutter inside the
      // shell's centered max-width container.
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      const containerLeft = (clientWidth - Math.min(clientWidth, shellContainerMaxWidthCssPx)) / 2;
      expect(Math.abs(firstSection.left - (containerLeft + viewport.gutter))).toBeLessThanOrEqual(edgeToleranceCssPx);
      expect(Math.abs(clientWidth - containerLeft - viewport.gutter - firstSection.right)).toBeLessThanOrEqual(
        edgeToleranceCssPx,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true);

      await page.screenshot({ path: testInfo.outputPath("shell-gutter.png"), fullPage: true });
    });
  }
}
