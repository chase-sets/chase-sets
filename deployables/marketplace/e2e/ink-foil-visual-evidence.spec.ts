import { expect, test, type Page } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { marketplaceBrowserE2eSeedContract, marketplaceBrowserE2eBuyerCredentials } from "./support/seed-contract";
import { signInWithPassword } from "./support/auth";

// Ink & Foil visual evidence (#6015 AC-06, AC-11).
//
// Charter scope: this spec proves the re-founded palette and type roles reach real,
// populated, signed-in-where-required marketplace surfaces in both color modes. It
// does not re-test browse, item-detail or checkout behaviour, which item-detail.spec.ts,
// buyer-purchase-journey.spec.ts and account-payment.spec.ts own.
//
// Two evidence mechanisms are combined deliberately, because neither is sufficient:
//
//   * captureResponsiveEvidence supplies the fail-closed populated-target guard and
//     the sha256'd screenshot. Its Measurement.property union coerces
//     css-custom-property to pixels, so the shared contract structurally cannot assert
//     a colour or a font family. Widening it is #3852's mechanism work, not this slice.
//   * the getComputedStyle assertions below therefore carry the colour and type claim,
//     against literal Ink & Foil values. They are literals rather than a comparison
//     against the page's own token, because an assertion that reads --background and
//     compares it to the page background passes identically on the superseded palette.
//
// CI lane: the file carries @marketplace-browse and @marketplace-checkout so
// scripts/run-e2e-suite.mjs collects it by --grep against scripts/e2e-suites.mjs. An
// untagged spec is never collected and the suite still reports green.

const seededBuyer = marketplaceBrowserE2eBuyerCredentials();

// Computed values the browser reports for the ratified anchors. Every one of these
// differs from the superseded palette, so each assertion fails at the pre-change head.
const INK_FOIL = {
  light: {
    background: "rgb(247, 245, 241)",
    foreground: "rgb(33, 29, 51)",
    primaryToken: "#4845c6",
    primary: "rgb(72, 69, 198)",
  },
  dark: {
    background: "rgb(14, 12, 21)",
    foreground: "rgb(242, 239, 250)",
    primaryToken: "#8a97ff",
    primary: "rgb(138, 151, 255)",
  },
} as const;

type ColorMode = keyof typeof INK_FOIL;

function themeRoot(page: Page) {
  // ChaseRoot renders exactly one outermost [data-chase-theme] frame and every token
  // block keys off it. In DOM order the first match is that outermost frame.
  return page.locator("[data-chase-theme]").first();
}

async function openSeededRoute(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} did not return a page response`).not.toBeNull();
  expect(response!.status(), `${path} returned HTTP ${response!.status()}`).toBeLessThan(400);
}

// The ratified modes are driven through data-color-mode, which is the same attribute
// the product's own preference path writes and the attribute observeStripeAppearance
// watches. The post-set assertion is not decoration: a hydration re-render that reset
// the attribute would otherwise produce a light-mode screenshot filed as dark.
async function forceColorMode(page: Page, mode: ColorMode) {
  const root = themeRoot(page);
  await expect(root).toBeVisible();
  await root.evaluate((element, nextMode) => element.setAttribute("data-color-mode", nextMode), mode);
  await expect(root).toHaveAttribute("data-color-mode", mode);
}

async function assertInkFoilSurfaces(page: Page, mode: ColorMode) {
  const expected = INK_FOIL[mode];
  const root = themeRoot(page);

  await expect(root, `${mode}: page root background must be the mode's --background`).toHaveCSS(
    "background-color",
    expected.background,
  );

  const resolvedPrimary = await root.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--primary").trim(),
  );
  expect(resolvedPrimary, `${mode}: --primary must resolve to the ratified anchor`).toBe(expected.primaryToken);

  const heading = page.getByRole("heading", { level: 1 }).first();
  await expect(heading, `${mode}: the route must render a primary heading`).toBeVisible();
  await expect(heading, `${mode}: primary heading colour must be --foreground`).toHaveCSS("color", expected.foreground);

  const headingFontFamily = await heading.evaluate((element) => getComputedStyle(element).fontFamily);
  // Chrome quotes family names containing a space, so the leading quote is stripped
  // before the prefix comparison rather than asserted around.
  expect(
    headingFontFamily.replace(/^["']/, ""),
    `${mode}: primary heading must resolve the Space Grotesk display face`,
  ).toMatch(/^Space Grotesk/);
}

// AC-05's real-browser half: the faces must actually resolve, not degrade silently to
// a system fallback. document.fonts.load is issued first because check() reports false
// for a declared face the document has not yet needed.
async function assertRatifiedFacesResolve(page: Page) {
  const resolved = await page.evaluate(async () => {
    await document.fonts.load("1rem 'Space Grotesk'");
    await document.fonts.load("1rem 'IBM Plex Mono'");
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      spaceGrotesk: document.fonts.check("1rem 'Space Grotesk'"),
      ibmPlexMono: document.fonts.check("1rem 'IBM Plex Mono'"),
      monoFont: rootStyle.getPropertyValue("--mono-font").trim(),
      fontMono: rootStyle.getPropertyValue("--font-mono").trim(),
      fontDisplay: rootStyle.getPropertyValue("--font-display").trim(),
      fontHeading: rootStyle.getPropertyValue("--font-heading").trim(),
    };
  });

  expect(resolved.spaceGrotesk, "Space Grotesk must be resolvable in the browser").toBe(true);
  expect(resolved.ibmPlexMono, "IBM Plex Mono must be resolvable in the browser").toBe(true);
  expect(resolved.monoFont).toBe('"IBM Plex Mono", ui-monospace, monospace');
  expect(resolved.fontMono).toBe('"IBM Plex Mono"');
  expect(resolved.fontDisplay).toBe('"Space Grotesk"');
  expect(resolved.fontHeading).toBe('"Space Grotesk"');
}

test.describe("Ink & Foil visual evidence", () => {
  test("browse landing carries the Ink & Foil light palette at 390x844 @marketplace-browse @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSeededRoute(page, "/");
    await forceColorMode(page, "light");
    await assertInkFoilSurfaces(page, "light");
    await assertRatifiedFacesResolve(page);

    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-browse-mobile-light" });
  });

  test("browse landing carries the Ink & Foil dark palette at 390x844 @marketplace-browse @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSeededRoute(page, "/");
    await forceColorMode(page, "dark");
    await assertInkFoilSurfaces(page, "dark");

    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-browse-mobile-dark" });
  });

  test("browse landing carries the Ink & Foil light palette at 1280x900 @marketplace-browse @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSeededRoute(page, "/");
    await forceColorMode(page, "light");
    await assertInkFoilSurfaces(page, "light");

    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-browse-desktop-light" });
  });

  test("browse landing carries the Ink & Foil dark palette at 1280x900 @marketplace-browse @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSeededRoute(page, "/");
    await forceColorMode(page, "dark");
    await assertInkFoilSurfaces(page, "dark");

    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-browse-desktop-dark" });
  });

  test("item detail carries the Ink & Foil light palette at 1280x900 @marketplace-browse @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSeededRoute(page, marketplaceBrowserE2eSeedContract.itemDetail.routePath);
    await forceColorMode(page, "light");
    await assertInkFoilSurfaces(page, "light");

    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-item-detail-desktop-light" });
  });

  test("item detail carries the Ink & Foil dark palette at 1280x900 @marketplace-browse @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSeededRoute(page, marketplaceBrowserE2eSeedContract.itemDetail.routePath);
    await forceColorMode(page, "dark");
    await assertInkFoilSurfaces(page, "dark");

    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-item-detail-desktop-dark" });
  });

  test("the brand foil wordmark renders its gold gradient in light mode @marketplace-browse @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSeededRoute(page, "/");
    await forceColorMode(page, "light");

    const wordmark = page.locator("svg[data-color-mode='auto']").first();
    await expect(wordmark).toBeVisible();
    const stops = await wordmark.evaluate((element) =>
      [...element.querySelectorAll("stop")].map((stop) => getComputedStyle(stop).stopColor),
    );
    // The auto-mode wordmark reads the gradient through --chase-logo-*, so the resolved
    // stop colours are the light foil ramp, never the superseded teal/blue.
    expect(stops).toEqual(["rgb(138, 104, 42)", "rgb(201, 164, 78)", "rgb(168, 126, 47)"]);

    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-brand-foil-wordmark-light" });
  });

  test("the brand foil wordmark renders its gold gradient in dark mode @marketplace-browse @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSeededRoute(page, "/");
    await forceColorMode(page, "dark");

    const wordmark = page.locator("svg[data-color-mode='auto']").first();
    await expect(wordmark).toBeVisible();
    const stops = await wordmark.evaluate((element) =>
      [...element.querySelectorAll("stop")].map((stop) => getComputedStyle(stop).stopColor),
    );
    expect(stops).toEqual(["rgb(185, 134, 59)", "rgb(237, 210, 141)", "rgb(212, 169, 78)"]);

    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-brand-foil-wordmark-dark" });
  });

  test("checkout payment step carries the Ink & Foil light palette at 1280x900 @marketplace-checkout @browser-e2e-seed", async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signInWithPassword(page, baseURL!, seededBuyer);
    await openSeededRoute(page, `/checkout/buy/session/${marketplaceBrowserE2eSeedContract.cart.startedSessionId}`);
    await forceColorMode(page, "light");
    await assertInkFoilSurfaces(page, "light");

    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-checkout-payment-desktop-light" });
  });

  test("checkout payment step carries the Ink & Foil dark palette at 1280x900 @marketplace-checkout @browser-e2e-seed", async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signInWithPassword(page, baseURL!, seededBuyer);
    await openSeededRoute(page, `/checkout/buy/session/${marketplaceBrowserE2eSeedContract.cart.startedSessionId}`);
    await forceColorMode(page, "dark");
    await assertInkFoilSurfaces(page, "dark");

    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-checkout-payment-desktop-dark" });
  });

  // Negative control. A palette screenshot of an empty result set would look like
  // evidence and prove nothing, so the contract must refuse to capture before the
  // screenshot exists when the claimed state is not populated.
  test("refuses to capture an unpopulated browse result set @marketplace-browse", async ({ page }, testInfo) => {
    const emptyStateUrl = "http://ink-foil-evidence.test/ink-foil/empty-results";
    await page.route(emptyStateUrl, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><head><style>html,body{margin:0;padding:0}</style></head><body><main data-evidence-target="results"><h1>No results</h1></main></body></html>`,
      }),
    );
    await page.goto(emptyStateUrl, { waitUntil: "domcontentloaded" });

    await expect(
      captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-empty-results-negative-control" }),
    ).rejects.toThrow(/reason=target-population-empty/);
  });
});
