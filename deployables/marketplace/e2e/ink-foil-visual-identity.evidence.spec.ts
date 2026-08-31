import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";

// Charter scope: rendered Ink & Foil evidence -- the display type, the brand
// foil, and the forced-colors fallback measured as rendered elements against
// expectations computed from the committed candidate-token fixture, never
// read from the live document. Colour and font-family assertions live here
// in-spec through getComputedStyle because the responsive-evidence harness
// coerces css-custom-property observations to pixels; every capture below is
// still registered fail-closed in responsive-evidence-manifest.json.
//
// CI lane: tagged @marketplace-browse so the change-scope `marketplace_browse`
// suite runs it alongside the browse specs.

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "design-system",
  "src",
  "theme",
  "__fixtures__",
  "ink-foil-candidate-tokens.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<
  "light" | "dark",
  Record<string, { shipped: string; candidate: string }>
>;

function hexToRgbString(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

function foilCandidates(mode: "light" | "dark"): string[] {
  return ["--chase-logo-start", "--chase-logo-mid", "--chase-logo-end"].map((name) =>
    hexToRgbString(fixture[mode][name]!.candidate),
  );
}

const itemDetailPath = "/items/charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp";

async function gotoAndSettle(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: "load" });
  expect(response, `${path} did not return a page response`).not.toBeNull();
  expect(response!.status(), `${path} returned HTTP ${response!.status()}`).toBeLessThan(400);
}

async function fontFaceObservations(page: Page) {
  return page.evaluate(async () => {
    const families = ["Space Grotesk", "IBM Plex Mono"];
    const weights = [400, 500, 600, 700];
    const observations: Record<string, { matched: number; loadedByWeight: Record<string, number> }> = {};
    for (const family of families) {
      const matched = [...document.fonts].filter((face) => face.family.replaceAll('"', "") === family).length;
      const loadedByWeight: Record<string, number> = {};
      for (const weight of weights) {
        const loaded = await document.fonts.load(`${weight} 1rem '${family}'`);
        loadedByWeight[String(weight)] = loaded.length;
      }
      observations[family] = { matched, loadedByWeight };
    }
    return observations;
  });
}

async function assertFontsInstalled(page: Page) {
  const observations = await fontFaceObservations(page);
  console.log(`document.fonts observations: ${JSON.stringify(observations, null, 2)}`);
  for (const [family, record] of Object.entries(observations)) {
    expect(record.matched, `${family} matched faces in document.fonts`).toBeGreaterThan(0);
    for (const [weight, count] of Object.entries(record.loadedByWeight)) {
      expect(count, `${family} weight ${weight} loaded faces`).toBeGreaterThan(0);
    }
  }
}

async function assertTypeRoles(page: Page) {
  const displayHeading = page.locator("h1.font-display").first();
  await expect(displayHeading, "an h1.font-display must be rendered").toHaveCount(1);
  const displayFamily = await displayHeading.evaluate((el) => getComputedStyle(el).fontFamily);
  console.log(`h1.font-display computed family: ${displayFamily}`);
  expect(displayFamily.startsWith('"Space Grotesk"') || displayFamily.startsWith("Space Grotesk")).toBe(true);

  const headingElement = page.locator(".font-heading").first();
  await expect(headingElement, "a .font-heading element must be rendered").toHaveCount(1);
  const headingFamily = await headingElement.evaluate((el) => getComputedStyle(el).fontFamily);
  console.log(`.font-heading computed family: ${headingFamily}`);
  expect(headingFamily.startsWith('"Space Grotesk"') || headingFamily.startsWith("Space Grotesk")).toBe(true);

  // The .ds-display rule's only component, NavigationHeader, has no
  // production route at this head, so the shipped rule is proven through its
  // shipped class against the real cascade on this real page.
  const dsDisplayFamily = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.className = "ds-display";
    document.body.append(probe);
    const family = getComputedStyle(probe).fontFamily;
    probe.remove();
    return family;
  });
  console.log(`.ds-display computed family (shipped class, real cascade): ${dsDisplayFamily}`);
  expect(dsDisplayFamily.startsWith('"Space Grotesk"') || dsDisplayFamily.startsWith("Space Grotesk")).toBe(true);
}

function brandStops(page: Page) {
  return page.locator("a[aria-label='Chase Sets'] svg[data-color-mode='auto'] stop");
}

async function assertFoilStops(page: Page, mode: "light" | "dark") {
  const stops = brandStops(page);
  await expect(stops, "the brand mark must render exactly three gradient stops").toHaveCount(3);
  const resolved = await stops.evaluateAll((els) => els.map((el) => getComputedStyle(el).stopColor));
  console.log(`brand foil stops (${mode}): ${JSON.stringify(resolved)}`);
  expect(resolved).toEqual(foilCandidates(mode));
}

async function assertShippedPalette(page: Page, mode: "light" | "dark") {
  // The two palette expectations read the fixture's SHIPPED values: the
  // render-time proof this candidate advanced no palette name. The palette
  // cutover rebaselines exactly these two expectations onto candidate.
  const expectedBackground = hexToRgbString(fixture[mode]["--background"]!.shipped);
  const expectedForeground = hexToRgbString(fixture[mode]["--foreground"]!.shipped);
  const observed = await page.evaluate(() => {
    const heading = document.querySelector("h1, h2, [class*='font-heading']");
    return {
      background: getComputedStyle(document.body).backgroundColor,
      foreground: heading ? getComputedStyle(heading).color : "",
    };
  });
  console.log(`palette-still-shipped (${mode}): ${JSON.stringify(observed)}`);
  expect(observed.background, `${mode} body background must stay the shipped palette`).toBe(expectedBackground);
  expect(observed.foreground, `${mode} heading colour must stay the shipped palette`).toBe(expectedForeground);
}

test.describe("Ink & Foil rendered visual identity", () => {
  test("records browse Ink & Foil evidence at 390x844 light @marketplace-browse", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "light" });
    await gotoAndSettle(page, itemDetailPath);
    await assertFontsInstalled(page);
    await assertTypeRoles(page);
    await assertFoilStops(page, "light");
    await assertShippedPalette(page, "light");
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-item-mobile-light" });
  });

  test("records browse Ink & Foil evidence at 1280x900 dark @marketplace-browse", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await gotoAndSettle(page, itemDetailPath);
    await assertFontsInstalled(page);
    await assertTypeRoles(page);
    await assertFoilStops(page, "dark");
    await assertShippedPalette(page, "dark");
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-item-desktop-dark" });
  });

  test("records search Ink & Foil evidence at 390x844 dark @marketplace-browse", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await gotoAndSettle(page, "/search");
    await assertFontsInstalled(page);
    await assertFoilStops(page, "dark");
    await assertShippedPalette(page, "dark");
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-search-mobile-dark" });
  });

  test("records search Ink & Foil evidence at 1280x900 light @marketplace-browse", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "light" });
    await gotoAndSettle(page, "/search");
    await assertFontsInstalled(page);
    await assertFoilStops(page, "light");
    await assertShippedPalette(page, "light");
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-search-desktop-light" });
  });

  test("records browse Ink & Foil evidence at 360x800 light @marketplace-browse", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "light" });
    await gotoAndSettle(page, itemDetailPath);
    await assertFoilStops(page, "light");
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-item-mobile-360" });
  });

  test("records browse Ink & Foil evidence at 820x1180 light @marketplace-browse", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "light" });
    await gotoAndSettle(page, itemDetailPath);
    await assertFoilStops(page, "light");
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-item-tablet-820" });
  });

  test("keeps the mark visible and named under forced colors @marketplace-browse", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "light", forcedColors: "active" });
    await gotoAndSettle(page, itemDetailPath);

    const stops = brandStops(page);
    await expect(stops, "the brand mark must render exactly three gradient stops").toHaveCount(3);
    const resolved = await stops.evaluateAll((els) => els.map((el) => getComputedStyle(el).stopColor));
    console.log(`brand foil stops (forced-colors): ${JSON.stringify(resolved)}`);
    for (const stopColor of resolved) {
      // Each stop must resolve to a visible system colour, never transparent
      // or absent paint, and never the gradient the mode may flatten.
      expect(stopColor).toMatch(/^rgb\(/);
      expect(stopColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(foilCandidates("light")).not.toContain(stopColor);
      expect(foilCandidates("dark")).not.toContain(stopColor);
    }
    // The three stops collapse to one system colour: a solid, visible mark.
    expect(new Set(resolved).size).toBe(1);

    const brandLink = page.locator("a[aria-label='Chase Sets']").first();
    await expect(brandLink, "brand link accessible name must survive forced colors").toHaveAttribute(
      "aria-label",
      "Chase Sets",
    );
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-item-forced-colors" });
  });
});
