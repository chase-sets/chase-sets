// Run against the public pilot with a titled promo message from its API:
// node deployables/corten-pilot/public/tests/landing-layout.mjs http://localhost:7792
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const transparent = "rgba(0, 0, 0, 0)";
const base = process.argv[2];
assert.ok(base, "pass the running public pilot's URL");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ javaScriptEnabled: false, colorScheme: "dark" });
  const main = page.locator("main#main-content");
  const hero = main.locator('section[data-section="hero"]');
  const promo = page.getByRole("region", { name: "Marketplace announcements" });
  const nav = page.getByRole("navigation");
  const footer = page.getByRole("contentinfo");

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok((await page.goto(new URL("/", base).href)).ok());
    const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
    const desktop = width >= 1024;
    const gutter = width < 768 ? 16 : 24;
    const frameInset = (viewportWidth - Math.min(viewportWidth, 1280)) / 2 + gutter;
    const image = hero.locator("img");

    for (const [name, node] of [
      ["promo", promo],
      ["nav", nav],
      ["footer", footer],
      ["game roster", main.locator('[data-section="game_roster"]')],
    ]) {
      await edges(node, frameInset, viewportWidth - frameInset, name);
    }
    const inset = desktop ? frameInset : 0;
    await edges(image, inset, viewportWidth - inset, "hero image");
    assert.equal(
      (await image.evaluate((node) => Number.parseFloat(getComputedStyle(node).borderTopLeftRadius))) > 0,
      desktop,
    );
    if (!desktop) {
      const title = await requiredBox(hero.getByRole("heading", { level: 1 }));
      assert.ok(Math.abs(title.x - frameInset) <= 1, "hero title starts on the page gutter");
    }

    const highlights = highlightGroup(hero, width);
    for (const node of [hero, nav, footer, highlights]) {
      const style = await surface(node);
      assert.deepEqual(style, { fill: transparent, border: "0px", shadow: "none" }, `flush surface: ${node}`);
    }
    const panel = await surface(hero.locator('[data-panel="hero"]'));
    assert.notEqual(panel.fill, transparent, "the signup panel has a fill");
    assert.notEqual(panel.shadow, "none", "the signup panel is raised");
    await readableFacts(highlights, width);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    console.log(`landing ${width}px: aligned shell, hero bleed, surface hierarchy and readable facts`);
  }

  assert.ok((await page.goto(new URL("/?utm_campaign=collectors", base).href)).ok());
  const buyerHighlights = highlightGroup(hero, 1440);
  assert.match(await buyerHighlights.textContent(), /Collector Shipping Credit/i, "buyer variant is visible");
  await readableFacts(buyerHighlights, 1440);
  console.log("buyer landing 1440px: readable facts");

  assert.ok((await page.goto(new URL("/compare/tcgplayer", base).href)).ok());
  const frame = await requiredBox(nav);
  await edges(
    main.locator('[data-public-presence-section="compare_table"]'),
    frame.x,
    frame.x + frame.width,
    "compare section",
  );
  await tinted(main.getByRole("heading", { name: "Why sellers join Chase Sets anyway" }).locator(".."));
  console.log("compare 1440px: align content edges, tint explanatory furniture");

  assert.ok((await page.goto(new URL("/terms", base).href)).ok());
  await tinted(main.getByRole("region", { name: "Policy metadata" }));
  await tinted(main.getByRole("navigation", { name: "Terms sections" }));
  console.log("terms: metadata and contents are tinted without chrome");
} finally {
  await browser.close();
}

async function requiredBox(locator) {
  assert.equal(await locator.count(), 1, `exactly one target: ${locator}`);
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `visible target: ${locator}`);
  return box;
}

async function edges(locator, left, right, name) {
  const box = await requiredBox(locator);
  assert.ok(Math.abs(box.x - left) <= 1, `${name} left edge: ${box.x} (expected ${left})`);
  assert.ok(Math.abs(box.x + box.width - right) <= 1, `${name} right edge: ${box.x + box.width} (expected ${right})`);
}

function surface(locator) {
  return locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return { fill: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow };
  });
}

async function tinted(locator) {
  const { fill, border, shadow } = await surface(locator);
  assert.notEqual(fill, transparent, `tinted fill: ${locator}`);
  assert.equal(border, "0px", `no border: ${locator}`);
  assert.equal(shadow, "none", `no shadow: ${locator}`);
}

function highlightGroup(hero, width) {
  return hero.getByRole("group", {
    name: width < 768 ? "Marketing highlight" : "Marketing highlights",
    exact: true,
  });
}

async function readableFacts(highlights, width) {
  const { count, clipped } = await highlights.evaluate((node) => {
    const facts = Array.from(node.querySelectorAll("span, div")).filter((item) => item.childElementCount === 0);
    return {
      count: facts.length,
      clipped: facts.filter((item) => item.scrollWidth > item.clientWidth).map((item) => item.textContent),
    };
  });
  assert.equal(count, width < 768 ? 2 : 6, "rendered highlight labels and values");
  assert.deepEqual(clipped, [], `clipped highlights at ${width}px`);
}
