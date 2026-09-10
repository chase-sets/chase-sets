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

// #7205 Ink & Foil Home/browse hierarchy. The no-query hero renders on both the
// Home landing (`/`) and the browse Result Set (`/search`); only the Home landing
// carries the Featured Categories / New Arrivals payload (the route loader binds
// it to pathname `/`), so Home-section anchors are proven on `/` and the two
// registered `/search` claims capture the hero, count, rail branch, and the
// unchanged populated Search card.
const heroHeadline = "Find cards, comics, figures, sneakers, and memorabilia worth chasing.";
const heroFoilWord = "chasing";
const heroDescription =
  "Search live supply, compare active markets, and move from discovery to item detail with buyer confidence built in.";
// SearchResultsLayout shows the desktop Facet rail from Tailwind `lg` upward.
const desktopRailMinWidth = 1024;

type InkFoilViewport = Readonly<{ width: number; height: number }>;

function homeHero(page: Page) {
  return page.locator("[data-search-home-hero]");
}

function desktopFacetRail(page: Page) {
  return page.locator("aside[aria-label='Desktop search filters']");
}

async function assertNoDocumentOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: horizontal document overflow in px`).toBeLessThanOrEqual(0);
}

async function assertInkFoilHero(page: Page, viewport: InkFoilViewport) {
  const hero = homeHero(page);
  await expect(hero, "the no-query hero must render exactly once").toHaveCount(1);
  await expect(hero).toBeVisible();

  const headline = page.locator("h1");
  await expect(headline, "exactly one page h1").toHaveCount(1);
  await expect(headline).toHaveClass(/font-display/);
  await expect(headline).toBeVisible();
  await expect(headline).toHaveText(heroHeadline);
  const foilSites = page.locator(".ds-brand-foil-text");
  await expect(foilSites, "exactly one brand-foil site on the page").toHaveCount(1);
  await expect(headline.locator(".ds-brand-foil-text")).toHaveText(heroFoilWord);
  await expect(foilSites).toBeVisible();
  const headlineNodes = await headline.evaluate((element) =>
    Array.from(element.childNodes).map((node) => [node.nodeType, node.textContent]),
  );
  expect(headlineNodes, "the foil wraps only the treated word; punctuation stays outside").toEqual([
    [Node.TEXT_NODE, "Find cards, comics, figures, sneakers, and memorabilia worth "],
    [Node.ELEMENT_NODE, heroFoilWord],
    [Node.TEXT_NODE, "."],
  ]);

  await expect(hero.getByText("Marketplace", { exact: true })).toBeVisible();
  await expect(hero.getByText("Verified supply", { exact: true })).toBeVisible();
  await expect(hero.getByText(heroDescription, { exact: true })).toBeVisible();
  await expect(hero.getByRole("searchbox", { name: "Marketplace search" })).toBeVisible();

  const categoryActions = hero.getByRole("button");
  await expect(categoryActions.first()).toHaveText("All");
  expect(await categoryActions.count(), "featured Category actions beside All").toBeGreaterThan(1);
  for (const action of await categoryActions.all()) {
    await expect(action).toBeVisible();
  }

  const count = page.locator("[data-search-result-set-count]");
  await expect(count, "one resolved inline Result Set count").toHaveCount(1);
  await expect(count).toBeVisible();
  await expect(count).toHaveText(/^\d+ results in All Categories$/);

  // The retired Stat surface is absent as markup, not merely hidden.
  await expect(page.getByText("Catalog depth", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/\d+ tracked items/)).toHaveCount(0);
  await expect(page.getByText("Results", { exact: true })).toHaveCount(0);

  // Desktop rail versus focused-only mobile Filter bar: the hidden sibling is
  // named explicitly rather than inferred from a visibility-dependent role.
  const rail = desktopFacetRail(page);
  await expect(rail, "one desktop Facet rail in the DOM").toHaveCount(1);
  if (viewport.width >= desktopRailMinWidth) {
    await expect(rail, `desktop Facet rail visible at ${viewport.width}px`).toBeVisible();
    const railSections = rail.locator("h3");
    expect(await railSections.count(), "canonical desktop Facet section list").toBeGreaterThan(0);
    await expect(railSections.first()).toBeVisible();
  } else {
    await expect(rail, `desktop Facet rail hidden at ${viewport.width}px`).toBeHidden();
  }
  await expect(page.getByRole("button", { name: "Open filters" }), "focused-only mobile Filter bar").toHaveCount(0);

  await assertNoDocumentOverflow(page, `hero at ${viewport.width}x${viewport.height}`);
}

async function assertHomeMerchandising(page: Page, viewport: InkFoilViewport) {
  const categoriesHeading = page.getByRole("heading", { level: 2, name: "Featured categories" });
  await expect(categoriesHeading).toBeVisible();
  const categoriesSection = categoriesHeading.locator("xpath=ancestor::section[1]");
  const categoryLinks = categoriesSection.getByRole("link", { name: /^Browse / });
  expect(await categoryLinks.count(), "authoritative Category links").toBeGreaterThan(0);
  await expect(categoryLinks.first()).toBeVisible();
  await expect(categoriesSection.locator("img"), "Featured Categories stay text-led").toHaveCount(0);

  const arrivalsHeading = page.getByRole("heading", { level: 2, name: "New arrivals" });
  await expect(arrivalsHeading).toBeVisible();
  const arrivalsSection = arrivalsHeading.locator("xpath=ancestor::section[1]");
  const arrivalCards = arrivalsSection.locator("article[data-card-layout='search-result']");
  expect(await arrivalCards.count(), "New Arrival Product cards").toBeGreaterThan(0);
  await arrivalCards.first().scrollIntoViewIfNeeded();
  await expect(arrivalCards.first()).toBeVisible();
  const arrivalImages = arrivalsSection.locator("article img");
  expect(await arrivalImages.count(), "an image-bearing New Arrival").toBeGreaterThan(0);
  const firstImage = arrivalImages.first();
  await firstImage.scrollIntoViewIfNeeded();
  await expect(firstImage).toBeVisible();
  await expect
    .poll(
      () =>
        firstImage.evaluate((element) => {
          const image = element as HTMLImageElement;
          return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
        }),
      { message: "the New Arrival image must actually load" },
    )
    .toBe(true);

  const browseAll = arrivalsSection.getByRole("link", { name: "Browse all new arrivals" });
  await expect(browseAll).toHaveCount(1);
  await browseAll.scrollIntoViewIfNeeded();
  await expect(browseAll).toBeVisible();
  await expect(browseAll).toHaveAttribute("href", "/search?sort=newest");
  const browseAllBox = await browseAll.boundingBox();
  const firstCardBox = await arrivalCards.first().boundingBox();
  expect(
    browseAllBox && firstCardBox && browseAllBox.y + browseAllBox.height <= firstCardBox.y + 1,
    "Browse all new arrivals sits in the section header ahead of the grid",
  ).toBe(true);

  // On the Home landing the Product cards are the New Arrivals alone: no
  // headless browse grid trails the merchandising sections.
  const allCards = page.locator("main article[data-card-layout='search-result']");
  expect(await allCards.count()).toBe(await arrivalCards.count());
  await assertNoDocumentOverflow(page, `Home at ${viewport.width}x${viewport.height}`);
}

// Exactly one main landmark and one h1 on every Ink & Foil route.
async function assertLandmarks(page: Page) {
  const landmarks = await page.evaluate(() => ({
    mains: document.querySelectorAll("main").length,
    h1Count: document.querySelectorAll("h1").length,
  }));
  expect(landmarks.mains, "exactly one main landmark").toBe(1);
  expect(landmarks.h1Count, "exactly one h1").toBe(1);
}

// The Home landing additionally keeps unique section headings in a monotonic
// order inside the content column (the Facet rail is the #5865/#6110-owned
// baseline and is excluded from the ordering).
async function assertHeadingAndLandmarkStructure(page: Page) {
  await assertLandmarks(page);
  const structure = await page.evaluate(() => {
    const main = document.querySelector("main");
    const rail = document.querySelector("aside[aria-label='Desktop search filters']");
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      text: (heading.textContent ?? "").trim(),
      inContent: Boolean(main?.contains(heading)) && !rail?.contains(heading),
    }));
    return { content: headings.filter((heading) => heading.inContent) };
  });
  console.log(`heading structure: ${JSON.stringify(structure)}`);
  const sectionTitles = structure.content.filter((heading) => heading.level === 2).map((heading) => heading.text);
  expect(new Set(sectionTitles).size, "unique section headings").toBe(sectionTitles.length);
  let previousLevel = 0;
  for (const heading of structure.content) {
    expect(heading.level, `heading "${heading.text}" must not skip a level`).toBeLessThanOrEqual(previousLevel + 1);
    previousLevel = heading.level;
  }
}

async function assertVisibleFocus(page: Page) {
  const searchbox = homeHero(page).getByRole("searchbox", { name: "Marketplace search" });
  const restingShadow = await searchbox.evaluate((element) => getComputedStyle(element).boxShadow);
  await searchbox.focus();
  const focused = await searchbox.evaluate((element) => ({
    active: document.activeElement === element,
    focusVisible: element.matches(":focus-visible"),
    boxShadow: getComputedStyle(element).boxShadow,
    outlineStyle: getComputedStyle(element).outlineStyle,
  }));
  console.log(`visible focus: ${JSON.stringify({ restingShadow, focused })}`);
  expect(focused.active).toBe(true);
  expect(focused.focusVisible).toBe(true);
  expect(
    focused.boxShadow !== restingShadow || focused.outlineStyle !== "none",
    "focus must paint a visible ring",
  ).toBe(true);
  await page.keyboard.press("Tab");
}

async function assertForcedColorsContinuity(page: Page, viewport: InkFoilViewport) {
  await page.emulateMedia({ forcedColors: "active" });
  await gotoAndSettle(page, "/");
  await expect(page.locator("h1")).toHaveText(heroHeadline);
  const foil = page.locator("h1 .ds-brand-foil-text");
  await expect(foil).toHaveCount(1);
  await expect(foil).toBeVisible();
  const paint = await foil.evaluate((element) => ({
    color: getComputedStyle(element).color,
    backgroundImage: getComputedStyle(element).backgroundImage,
  }));
  console.log(`forced-colors foil paint: ${JSON.stringify(paint)}`);
  expect(paint.backgroundImage).toBe("none");
  expect(paint.color).toMatch(/^rgb\(/);
  expect(paint.color).not.toBe("rgba(0, 0, 0, 0)");
  await assertHomeMerchandising(page, viewport);
  await page.emulateMedia({ forcedColors: "none" });
}

async function assertReducedMotionContinuity(page: Page, viewport: InkFoilViewport) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoAndSettle(page, "/");
  await assertInkFoilHero(page, viewport);
  await assertHomeMerchandising(page, viewport);
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

// The exact seeded Home state, asserted at the lifecycle moment before any
// geometry or capture: hero, count, Category and New Arrival anchors, image,
// rail branch, structure, focus, and layout.
async function assertInkFoilHome(page: Page, viewport: InkFoilViewport) {
  await gotoAndSettle(page, "/");
  await assertInkFoilHero(page, viewport);
  await assertHomeMerchandising(page, viewport);
  await assertHeadingAndLandmarkStructure(page);
  await assertVisibleFocus(page);
}

// The registered `/search` claim state: the same hero and count over the
// unchanged populated browse Result Set, with no Home merchandising payload.
async function assertInkFoilSearch(page: Page, viewport: InkFoilViewport) {
  await gotoAndSettle(page, "/search");
  await assertInkFoilHero(page, viewport);
  await expect(page.getByRole("heading", { name: "Featured categories" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "New arrivals" })).toHaveCount(0);
  await assertLandmarks(page);
}

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
    const viewport = { width: 390, height: 844 };
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: "dark" });
    await assertInkFoilHome(page, viewport);
    await assertInkFoilSearch(page, viewport);
    await assertFontsInstalled(page);
    await assertFoilStops(page, "dark");
    await assertCandidatePalette(page, "dark");
    await assertPopulatedCta(page, "dark");
    await assertPopulatedSearchPriceRole(page);
    await captureResponsiveEvidence({ page, testInfo, claimId: "ink-foil-search-mobile-dark" });
  });

  test("records search Ink & Foil evidence at 1280x900 light @marketplace-browse", async ({ page }, testInfo) => {
    const viewport = { width: 1280, height: 900 };
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: "light" });
    await assertInkFoilHome(page, viewport);
    await assertInkFoilSearch(page, viewport);
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

  test("asserts search Ink & Foil geometry at 360x800 light @marketplace-browse", async ({ page }) => {
    const viewport = { width: 360, height: 800 };
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: "light" });
    await assertInkFoilHome(page, viewport);
    await assertInkFoilSearch(page, viewport);
    await assertPopulatedSearchPriceRole(page);
    await assertForcedColorsContinuity(page, viewport);
    await assertReducedMotionContinuity(page, viewport);
  });

  test("asserts search Ink & Foil geometry at 820x1180 light @marketplace-browse", async ({ page }) => {
    const viewport = { width: 820, height: 1180 };
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: "light" });
    await assertInkFoilHome(page, viewport);
    await assertInkFoilSearch(page, viewport);
    await assertPopulatedSearchPriceRole(page);
    await assertForcedColorsContinuity(page, viewport);
    await assertReducedMotionContinuity(page, viewport);
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
