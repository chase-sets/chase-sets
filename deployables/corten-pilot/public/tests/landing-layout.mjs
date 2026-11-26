// Run against the public pilot with two titled promo messages, the first with a link:
// node deployables/corten-pilot/public/tests/landing-layout.mjs http://localhost:7792
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const transparent = "rgba(0, 0, 0, 0)";
const base = process.argv[2];
assert.ok(base, "pass the running public pilot's URL");

const browser = await chromium.launch();
try {
  const phone = await browser.newPage({ viewport: { width: 375, height: 900 } });
  assert.ok((await phone.goto(new URL("/", base).href)).ok());
  const phonePromo = phone.getByRole("region", { name: "Marketplace announcements" });
  const previous = phonePromo.locator('[data-promo-step="-1"]');
  await previous.waitFor();
  await phonePromo.locator("[data-promo-pause]").click();
  await phone.evaluate(() => document.fonts.ready.then(() => true));
  const phoneTitle = phonePromo.locator(".home-page__promo-title").filter({ visible: true });
  await requiredBox(phoneTitle);
  assert.ok(await phoneTitle.evaluate((node) => node.scrollWidth <= node.clientWidth), "phone promo title is readable");
  for (const width of [320, 375]) {
    await phone.setViewportSize({ width, height: 667 });
    const promoLink = phonePromo.getByRole("link");
    assert.ok((await requiredBox(promoLink)).height >= 44, `${width}px: promo action is a phone touch target`);
    for (const control of await phonePromo.getByRole("button").all()) {
      const box = await requiredBox(control);
      assert.ok(box.width >= 44 && box.height >= 44, `${width}px: promo controls are phone touch targets`);
    }
    for (const label of ["Order protection", "CollectorShippingCredit"]) {
      const { link, parts, control } = await promoLink.evaluate(measurePromoLink, label);
      assert.ok(parts.length >= 2, "visible promo link text and its decorative glyph");
      for (const part of parts) {
        assert.ok(
          part.right <= control.left || part.bottom <= control.top || part.top >= control.bottom,
          `${width}px: ${label} text and glyph stay clear of the previous-message button`,
        );
        assert.ok(part.left >= link.left && part.right <= link.right, `${width}px: ${label} stays inside its link`);
      }
      if (label === "Order protection") {
        assert.ok(
          link.top < control.bottom && link.bottom > control.top,
          `${width}px: the ordinary link still shares the pager row`,
        );
      }
    }
    for (const colorScheme of ["light", "dark"]) {
      await phone.emulateMedia({ colorScheme });
      await mobileRhythm(phone, width);
    }
  }
  await phone.close();

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
  const termsContents = main.getByRole("navigation", { name: "Terms sections" });
  await tinted(termsContents);
  const columns = () =>
    termsContents
      .getByRole("list")
      .evaluate(
        (list) => new Set(Array.from(list.children, (item) => Math.round(item.getBoundingClientRect().x))).size,
      );
  assert.equal(await columns(), 2, "wide terms contents list uses two columns");
  await page.setViewportSize({ width: 375, height: 900 });
  assert.equal(await columns(), 1, "phone terms contents list stays in a single column");
  console.log("terms: tinted contents change from one column to two");
} finally {
  await browser.close();
}

async function requiredBox(locator) {
  assert.equal(await locator.count(), 1, `exactly one target: ${locator}`);
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `visible target: ${locator}`);
  return box;
}

// Check the visible controls, not just the nav/section wrappers: matching wrapper
// edges can still conceal a second gutter or a CTA wrapped onto its own row.
async function mobileRhythm(page, width) {
  const nav = page.locator("nav").first();
  const hero = page.locator('main section[data-section="hero"]');
  const title = await requiredBox(hero.getByRole("heading", { level: 1 }).filter({ visible: true }));
  const brand = await requiredBox(nav.getByRole("link").first());
  const cta = await requiredBox(nav.locator('[data-cta="nav"]'));
  assert.ok(Math.abs(brand.x - title.x) <= 1, `${width}px: brand and hero share the leading gutter`);
  assert.ok(Math.abs(cta.x + cta.width - (width - title.x)) <= 1, `${width}px: nav CTA meets the trailing gutter`);
  assert.ok(Math.abs(brand.y + brand.height / 2 - (cta.y + cta.height / 2)) <= 1, `${width}px: a single nav row`);
  const heroTop = (await requiredBox(hero)).y;
  const navBottom = brand.y + brand.height;
  assert.ok(heroTop > navBottom && heroTop - navBottom <= title.x, `${width}px: only one gap before the hero`);
  const panel = hero.locator('[data-panel="hero"]');
  const email = await requiredBox(panel.locator('input[type="email"]'));
  const submit = await requiredBox(panel.locator('button[type="submit"]'));
  const inset = email.x - (await requiredBox(panel)).x;
  const rowGap = submit.y - (email.y + email.height);
  assert.ok(rowGap > 0 && inset >= rowGap * 2, `${width}px: outer card inset is distinct from its form-row gap`);
  assert.ok(cta.height >= 44, `${width}px: nav CTA keeps a phone touch target`);
  if (width === 375) assert.ok(submit.y + submit.height <= 667, "signup action fits the compact first viewport");
}

function measurePromoLink(link, label) {
  const text = Array.from(link.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.data.trim());
  const glyph = link.querySelector("svg");
  const previous = link.closest("section")?.querySelector('[data-promo-step="-1"]');
  if (!text || !glyph || !previous) throw new Error("expected a promo link, decorative glyph, and previous control");
  const original = text.data;
  try {
    text.data = label;
    const range = document.createRange();
    range.selectNodeContents(text);
    return {
      link: link.getBoundingClientRect().toJSON(),
      parts: [...range.getClientRects(), glyph.getBoundingClientRect()].map((rect) => rect.toJSON()),
      control: previous.getBoundingClientRect().toJSON(),
    };
  } finally {
    text.data = original;
  }
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
