import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Locator } from "@playwright/test";
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
const populatedSearchPriceProof = {
  detailPath: itemDetailPath,
  identity: "Charizard",
  visiblePriceText: "From $389.00",
  prefixText: "From",
  valueText: "$389.00",
} as const;

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

function assertCandidateObservation(
  observed: { background: string; foreground: string },
  expected: { background: string; foreground: string },
) {
  expect(observed.background, "fixture-candidate background").toBe(expected.background);
  expect(observed.foreground, "fixture-candidate foreground").toBe(expected.foreground);
}

async function assertCandidatePalette(page: Page, mode: "light" | "dark") {
  const expected = {
    background: hexToRgbString(fixture[mode]["--background"]!.candidate),
    foreground: hexToRgbString(fixture[mode]["--foreground"]!.candidate),
  };
  await expect(page.locator("h1").first()).toBeVisible();
  const observed = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    foreground: getComputedStyle(document.querySelector("h1")!).color,
  }));
  console.log(`palette (${mode}): ${JSON.stringify({ observed, expected })}`);
  assertCandidateObservation(observed, expected);
}

function populatedCta(page: Page) {
  return page.url().includes("/search")
    ? page.locator(`article:has(> a[href='${populatedSearchPriceProof.detailPath}']) a.bg-accent`)
    : page.locator("main button.bg-accent:visible:enabled").first();
}

async function ctaObservation(cta: Locator) {
  await expect(cta, "populated state CTA must be visible").toBeVisible();
  await expect(cta, "populated state CTA must be enabled").toBeEnabled();
  await cta.scrollIntoViewIfNeeded();
  await expect(cta).toBeInViewport();
  return cta.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    foreground: getComputedStyle(element).color,
  }));
}

async function assertPopulatedCta(page: Page, mode: "light" | "dark") {
  if (!page.url().includes("/search")) {
    await expect(page.locator("h1")).toContainText("Charizard");
    const listing = page.getByRole("article", { name: /Listing .* from/i }).first();
    await expect(listing, "the item must show an actual listing, not an empty market state").toBeVisible();
    await listing.scrollIntoViewIfNeeded();
    await expect(listing).toBeInViewport();
    await expect(page.locator("[data-product-options-surface]")).not.toHaveAttribute("data-product-id", "");
  }
  const observed = await ctaObservation(populatedCta(page));
  const expected = {
    background: hexToRgbString(fixture[mode]["--primary"]!.candidate),
    foreground: hexToRgbString(fixture[mode]["--primary-foreground"]!.candidate),
  };
  console.log(`populated CTA (${mode}): ${JSON.stringify({ observed, expected })}`);
  assertCandidateObservation(observed, expected);
}

async function assertPopulatedSearchPriceRole(page: Page) {
  const card = page.locator(`article:has(> a[href='${populatedSearchPriceProof.detailPath}'])`);
  const prefix = card.locator("[data-listing-card-price-prefix]");
  const value = card.locator("[data-listing-card-price-value]");

  await expect(card, "the unchanged populated Search card must be rendered exactly once").toHaveCount(1);
  await expect(card.locator("h3"), "the populated Search card identity must stay byte-identical").toHaveText(
    populatedSearchPriceProof.identity,
  );
  await expect(card, "the populated Search card price phrase must stay byte-identical").toContainText(
    populatedSearchPriceProof.visiblePriceText,
  );
  await expect(prefix, "the indicative price prefix must render exactly once").toHaveCount(1);
  await expect(prefix).toHaveText(populatedSearchPriceProof.prefixText);
  await expect(prefix).not.toHaveAttribute("class");
  await expect(value, "the mono price value must render exactly once").toHaveCount(1);
  await expect(value).toHaveText(populatedSearchPriceProof.valueText);
  await expect(value).toHaveClass(/font-mono/);
  await expect(value).toHaveClass(/tabular-nums/);

  const exactMonoFontLoaded = await page.evaluate(async () => {
    await document.fonts.load("1rem 'IBM Plex Mono'");
    await document.fonts.ready;
    return document.fonts.check("1rem 'IBM Plex Mono'");
  });
  expect(exactMonoFontLoaded).toBe(true);

  const observations = await card.evaluate((element) => {
    const pricePrefix = element.querySelector<HTMLElement>("[data-listing-card-price-prefix]");
    const priceValue = element.querySelector<HTMLElement>("[data-listing-card-price-value]");
    const title = element.querySelector<HTMLElement>("h3");
    const adjacentCopy = element.querySelector<HTMLElement>("h3 + p");
    const valueStyle = priceValue ? getComputedStyle(priceValue) : null;

    return {
      visiblePriceText: priceValue?.parentElement?.textContent ?? null,
      literalSeparator: pricePrefix?.nextSibling?.textContent ?? null,
      value: valueStyle
        ? {
            fontFamily: valueStyle.fontFamily,
            fontVariantNumeric: valueStyle.fontVariantNumeric,
            fontSize: valueStyle.fontSize,
            fontWeight: valueStyle.fontWeight,
            lineHeight: valueStyle.lineHeight,
            color: valueStyle.color,
          }
        : null,
      prefixFontFamily: pricePrefix ? getComputedStyle(pricePrefix).fontFamily : null,
      titleFontFamily: title ? getComputedStyle(title).fontFamily : null,
      adjacentCopyFontFamily: adjacentCopy ? getComputedStyle(adjacentCopy).fontFamily : null,
      monoFontLoaded: document.fonts.check("1rem 'IBM Plex Mono'"),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  console.log(`populated Search price role: ${JSON.stringify(observations, null, 2)}`);

  expect(observations.visiblePriceText).toBe(populatedSearchPriceProof.visiblePriceText);
  expect(observations.literalSeparator).toBe(" ");
  expect(
    observations.value?.fontFamily.startsWith('"IBM Plex Mono"') ||
      observations.value?.fontFamily.startsWith("IBM Plex Mono"),
  ).toBe(true);
  expect(observations.value?.fontVariantNumeric).toContain("tabular-nums");
  expect(observations.value?.fontSize).toBe("18px");
  expect(observations.value?.fontWeight).toBe("700");
  expect(observations.value?.lineHeight).toBe("24px");
  for (const fontFamily of [
    observations.prefixFontFamily,
    observations.titleFontFamily,
    observations.adjacentCopyFontFamily,
  ]) {
    expect(fontFamily?.startsWith('"IBM Plex Sans"') || fontFamily?.startsWith("IBM Plex Sans")).toBe(true);
  }
  expect(observations.monoFontLoaded).toBe(true);
  expect(observations.horizontalOverflow).toBe(false);
}

test.describe("Ink & Foil rendered visual identity", () => {
  test("records browse Ink & Foil evidence at 390x844 light @marketplace-browse", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "light" });
    await gotoAndSettle(page, itemDetailPath);
    await assertFontsInstalled(page);
    await assertTypeRoles(page);
    await assertFoilStops(page, "light");
    await assertCandidatePalette(page, "light");
    await assertPopulatedCta(page, "light");
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-item-mobile-light" });
  });

  test("records browse Ink & Foil evidence at 1280x900 dark @marketplace-browse", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await gotoAndSettle(page, itemDetailPath);
    await assertFontsInstalled(page);
    await assertTypeRoles(page);
    await assertFoilStops(page, "dark");
    await assertCandidatePalette(page, "dark");
    await assertPopulatedCta(page, "dark");
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-item-desktop-dark" });
  });

  test("records search Ink & Foil evidence at 390x844 dark @marketplace-browse", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await gotoAndSettle(page, "/search");
    await assertFontsInstalled(page);
    await assertFoilStops(page, "dark");
    await assertCandidatePalette(page, "dark");
    await assertPopulatedCta(page, "dark");
    await assertPopulatedSearchPriceRole(page);
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-search-mobile-dark" });
  });

  test("records search Ink & Foil evidence at 1280x900 light @marketplace-browse", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await gotoAndSettle(page, "/search");
    await assertFontsInstalled(page);
    await assertFoilStops(page, "light");
    await assertCandidatePalette(page, "light");
    await assertPopulatedCta(page, "light");
    await assertPopulatedSearchPriceRole(page);
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-search-desktop-light" });

    // Single-variable controls exercise the same observation assertion and
    // registered capture after the successful, populated evidence is retained.
    const cta = populatedCta(page);
    const observed = await ctaObservation(cta);
    const expected = {
      background: hexToRgbString(fixture.light["--primary"]!.candidate),
      foreground: hexToRgbString(fixture.light["--primary-foreground"]!.candidate),
    };
    expect(() =>
      assertCandidateObservation(observed, {
        ...expected,
        background: hexToRgbString(fixture.light["--primary"]!.shipped),
      }),
    ).toThrow("fixture-candidate background");
    const previousStyle = await cta.getAttribute("style");
    await cta.evaluate((element, oldColor) => {
      (element as HTMLElement).style.backgroundColor = oldColor;
    }, fixture.light["--primary"]!.shipped);
    await expect(cta).toHaveCSS("background-color", hexToRgbString(fixture.light["--primary"]!.shipped));
    const staleCta = await ctaObservation(cta);
    expect(() => assertCandidateObservation(staleCta, expected)).toThrow("fixture-candidate background");
    await cta.evaluate((element, style) => {
      if (style === null) element.removeAttribute("style");
      else element.setAttribute("style", style);
    }, previousStyle);
    await expect(cta).toHaveCSS("background-color", expected.background);
    await assertPopulatedCta(page, "light");
    await page
      .locator(`article:has(> a[href='${populatedSearchPriceProof.detailPath}'])`)
      .evaluate((element) => element.remove());
    await expect(
      captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-search-empty-control" }),
    ).rejects.toThrow("target-population-empty");
  });

  test("records browse Ink & Foil evidence at 360x800 light @marketplace-browse", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: "light" });
    await gotoAndSettle(page, itemDetailPath);
    await assertFoilStops(page, "light");
    await assertCandidatePalette(page, "light");
    await assertPopulatedCta(page, "light");
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-item-mobile-360" });
  });

  test("records browse Ink & Foil evidence at 820x1180 light @marketplace-browse", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.emulateMedia({ colorScheme: "light" });
    await gotoAndSettle(page, itemDetailPath);
    await assertFoilStops(page, "light");
    await assertCandidatePalette(page, "light");
    await assertPopulatedCta(page, "light");
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-item-tablet-820" });
  });

  test("keeps the mark visible and named under forced colors @marketplace-browse", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
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
