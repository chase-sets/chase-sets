import { readFileSync } from "node:fs";
import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";
import { marketplaceBrowserE2eSeedContract } from "./seed-contract";
import { onCortenMarketplace } from "./system";

// Read the final design-system CSS independently of the pilot's export and runtime tokens.
const stylesheet = readFileSync(
  new URL("../../../../packages/design-system/src/styles/styles.css", import.meta.url),
  "utf8",
);

function designToken(name: string) {
  const value = stylesheet.match(new RegExp(`^\\s*--${name}:\\s*([^;]+);`, "m"))?.[1]?.trim();
  if (!value || value.includes("var(")) throw new Error(`Missing literal design-system token --${name}`);
  return value;
}

const gradient = stylesheet.match(/\.ds-brand-foil-text\s*{\s*background-image:\s*(linear-gradient\([^;]+\));/)?.[1];
const logoStops = /var\(--(chase-logo-(?:start|mid|end))\)/g;
if (!gradient || [...gradient.matchAll(logoStops)].length !== 3) {
  throw new Error("Missing the design system's three-stop brand foil gradient");
}
const themes = (["light", "dark"] as const).map((mode) => ({
  mode,
  gradient: gradient.replace(logoStops, (_, token: string) => designToken(mode === "light" ? token : `dark-${token}`)),
}));

function primaryFamily(role: "body" | "display" | "mono") {
  const family = designToken(`${role}-font`).split(",")[0]?.trim().replaceAll('"', "");
  if (!family) throw new Error(`Missing design-system ${role} font`);
  return family;
}

async function expectPaintedFont(cdp: CDPSession, text: Locator, role: "body" | "display" | "mono") {
  await expect(text).toBeVisible();
  const family = primaryFamily(role);
  const { cssFamily, selector } = await text.evaluate(async (element) => {
    await document.fonts.ready;
    const path: string[] = [];
    for (let current: Element | null = element; current.parentElement; current = current.parentElement) {
      const index = Array.from(current.parentElement.children).indexOf(current) + 1;
      path.unshift(`:nth-child(${index})`);
    }
    return {
      cssFamily: getComputedStyle(element).fontFamily.split(",")[0]?.trim().replaceAll('"', ""),
      selector: [":root", ...path].join(" > "),
    };
  });
  expect(cssFamily, `${role} must select the design-system face first`).toBe(family);

  // CSS and document.fonts.check() alone can pass while the text paints in a fallback face.
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  const painted = fonts.filter(({ glyphCount }) => glyphCount > 0);
  expect(painted, `${role} must paint text`).not.toHaveLength(0);
  expect(
    painted.filter(
      ({ familyName, isCustomFont }) =>
        !isCustomFont || (familyName !== family && !familyName.startsWith(`${family} `)),
    ),
    `${role} must paint with the downloaded ${family}, not a fallback`,
  ).toEqual([]);
}

async function expectHero(page: Page, cdp: CDPSession, main: Locator) {
  const headline = main.getByRole("heading", { level: 1, name: "Find trading cards worth chasing." });
  const foil = headline.locator(":scope > span").filter({ hasText: /^chasing$/ });
  await expectPaintedFont(cdp, headline, "display");
  await expectPaintedFont(cdp, foil, "display");
  await expectPaintedFont(cdp, main.getByText(/^Search live supply, compare active markets/), "body");

  for (const theme of themes) {
    await page.emulateMedia({ colorScheme: theme.mode, forcedColors: "none" });
    const field = main.getByRole("searchbox", { name: "Marketplace search" });
    await expect(field).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(field.locator("..")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const expectedGradient = await page.evaluate((value) => {
      const sample = document.createElement("span");
      Object.assign(sample.style, { backgroundImage: value, position: "absolute", visibility: "hidden" });
      document.body.append(sample);
      const resolved = getComputedStyle(sample).backgroundImage;
      sample.remove();
      return resolved;
    }, theme.gradient);
    expect(expectedGradient, `${theme.mode} design-system gradient resolves`).toMatch(/^linear-gradient\(/);
    await expect(foil, `${theme.mode} foil paints all three canonical stops`).toHaveCSS(
      "background-image",
      expectedGradient,
    );
    await expect(foil).toHaveCSS("background-clip", "text");
    await expect(foil).toHaveCSS("color", "rgba(0, 0, 0, 0)");
  }

  await page.emulateMedia({ colorScheme: "light", forcedColors: "active" });
  try {
    await expect(foil).toBeVisible();
    await expect(foil).toHaveCSS("background-image", "none");
    const colors = await foil.evaluate((element) => {
      const sample = document.createElement("span");
      Object.assign(sample.style, { color: "CanvasText", backgroundColor: "Canvas", position: "absolute" });
      element.after(sample);
      const { color: canvasText, backgroundColor: canvas } = getComputedStyle(sample);
      const { color, webkitTextFillColor } = getComputedStyle(element);
      sample.remove();
      return { canvasText, canvas, color, webkitTextFillColor };
    });
    expect(colors.canvasText).toMatch(/^rgb\(/);
    expect(colors.canvasText).not.toBe(colors.canvas);
    expect(colors.color).toBe(colors.canvasText);
    expect(colors.webkitTextFillColor).toBe(colors.canvasText);
  } finally {
    await page.emulateMedia({ forcedColors: "none" });
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "the hero must fit the viewport").toBeLessThanOrEqual(0);
}

export const registerMarketplaceInkFoilTests = () =>
  test.describe("Corten Marketplace Ink & Foil", () => {
    test.skip(
      !onCortenMarketplace,
      "The required Corten Marketplace Browser Tests gate owns this Corten-only journey.",
    );
    test.use({ locale: "en-US", colorScheme: "light" });

    for (const [name, width, height, tag] of [
      ["desktop", 1280, 900, ["@browser-e2e-seed"]],
      ["phone", 390, 844, ["@browser-e2e-seed", "@mobile"]],
    ] as const) {
      test(`paints populated Home and Browse on ${name}`, { tag: [...tag] }, async ({ page, context }) => {
        await page.setViewportSize({ width, height });
        const response = await page.goto("/", { waitUntil: "domcontentloaded" });
        expect(response?.ok(), "Home responds successfully").toBe(true);
        const cdp = await context.newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const main = page.getByRole("main");
        await expect(main).toHaveCount(1);

        const featured = main.getByRole("region", { name: "Featured categories" });
        await expect(featured.getByRole("link", { name: /^Browse / }).first()).toBeVisible();
        const arrivals = main.getByRole("region", { name: "New arrivals" });
        await expect(arrivals.getByRole("link", { name: "View item", exact: true }).first()).toBeVisible();
        await expectHero(page, cdp, main);

        await main.getByRole("link", { name: "All", exact: true }).click();
        await expect(page).toHaveURL((url) => url.pathname === "/search" && !url.search);
        await expect(featured).toHaveCount(0);
        await expect(arrivals).toHaveCount(0);
        await expect(main.getByRole("link", { name: /^View details for / }).first()).toBeVisible();
        await expectHero(page, cdp, main);

        const query = marketplaceBrowserE2eSeedContract.browse.searchQuery;
        const search = main.getByRole("searchbox", { name: "Marketplace search" });
        await search.fill(query);
        await search.press("Enter");
        await expect(page).toHaveURL((url) => url.pathname === "/search" && url.searchParams.get("q") === query);
        const { routePath } = marketplaceBrowserE2eSeedContract.itemDetail;
        const card = main.getByRole("listitem").filter({ has: page.locator(`h3 a[href^="${routePath}"]`) });
        const prefix = card.getByText("From", { exact: true });
        const amount = card.getByText("$389.00", { exact: true });
        await expectPaintedFont(cdp, prefix, "body");
        await expectPaintedFont(cdp, amount, "mono");
        await expect(amount).toHaveCSS("font-variant-numeric", "tabular-nums");
      });
    }
  });
