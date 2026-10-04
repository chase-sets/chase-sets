import { existsSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { captureResponsiveEvidence, responsiveEvidenceArtifactPaths } from "@chase-sets/playwright-evidence";

const route = "/search?q=charizard";
type Presentation = "desktop" | "mobile";
const list = (presentation: Presentation) => `[data-facet-list-presentation="${presentation}"]`;

async function openFixture(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const response = await page.goto(route);
  expect(response?.ok()).toBe(true);
  const desktop = page.locator(list("desktop"));
  await expect(desktop).toHaveCount(1);
  await expect
    .poll(() => desktop.evaluate((root) => Object.keys(root).some((key) => key.startsWith("__reactProps$"))))
    .toBe(true);
  const presentation = width >= 1024 ? "desktop" : "mobile";
  if (presentation === "mobile") await page.getByRole("button", { name: "Open filters", exact: true }).click();
  const root = page.locator(list(presentation));
  await expect(root).toBeVisible();
  expect(JSON.parse((await root.getAttribute("data-facet-expanded-values"))!)).toEqual([
    "categories",
    "price-and-stock",
  ]);
  for (const value of ["categories", "price-and-stock", "language"]) {
    await root.locator(`[data-facet-item-value="${value}"]`).click();
  }
  await expect(root.locator('[data-facet-item-value][aria-expanded="true"]')).toHaveCount(1);
  await expect(root.locator('[data-facet-item-value="language"]')).toHaveAttribute("aria-expanded", "true");
  await root.locator('[data-facet-item-value="language"]').scrollIntoViewIfNeeded();
  return presentation;
}

async function inspectFacetList(page: Page, presentation: Presentation) {
  const ledger = await page.evaluate(
    ({ selector, presentation }) => {
      const roots = document.querySelectorAll<HTMLElement>(selector);
      if (roots.length !== 1) throw new Error("facet-evidence: root-count");
      const root = roots[0]!;
      const visible = (node: HTMLElement) =>
        node.checkVisibility({ checkVisibilityCSS: true }) &&
        node.getBoundingClientRect().width > 0 &&
        node.getBoundingClientRect().height > 0;
      if (!visible(root)) throw new Error("facet-evidence: hidden-presentation");
      if ((innerWidth >= 1024 ? "desktop" : "mobile") !== presentation)
        throw new Error("facet-evidence: wrong-presentation");
      const triggers = Array.from(root.querySelectorAll<HTMLElement>("[data-facet-item-value]"));
      const values = triggers.map((node) => node.dataset.facetItemValue);
      if (
        values.length < 4 ||
        new Set(values).size !== values.length ||
        values.slice(0, 4).join() !== "categories,price-and-stock,language,market-activity"
      )
        throw new Error("facet-evidence: section-inventory");
      const expanded = triggers.filter((node) => node.getAttribute("aria-expanded") === "true");
      if (expanded.length !== 1 || expanded[0]!.dataset.facetItemValue !== "language")
        throw new Error("facet-evidence: expanded-state");
      const ids = Array.from(document.querySelectorAll("[id]"), (node) => node.id);
      if (new Set(ids).size !== ids.length) throw new Error("facet-evidence: duplicate-id");
      for (const trigger of document.querySelectorAll<HTMLElement>("[data-facet-item-value]")) {
        const owner = trigger.closest<HTMLElement>("[data-facet-list-presentation]")!;
        const panel = document.getElementById(trigger.getAttribute("aria-controls")!);
        if (
          trigger.id !== `${owner.id}-trigger-${trigger.dataset.facetItemValue}` ||
          !panel ||
          panel.id !== `${owner.id}-panel-${trigger.dataset.facetItemValue}` ||
          panel.getAttribute("aria-labelledby") !== trigger.id
        )
          throw new Error("facet-evidence: aria-reference");
      }
      const panel = document.getElementById(expanded[0]!.getAttribute("aria-controls")!)!;
      const options = Array.from(panel.querySelectorAll<HTMLElement>("button[aria-pressed]"));
      if (options.length < 2 || options.some((node) => !visible(node)))
        throw new Error("facet-evidence: empty-options");
      const owners: HTMLElement[] = [];
      for (let parent = root.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) owners.push(parent);
      }
      if (
        owners.length !== 1 ||
        Array.from(root.querySelectorAll("*")).some((node) => /^(auto|scroll)$/.test(getComputedStyle(node).overflowY))
      )
        throw new Error("facet-evidence: scroll-owner");
      const owner = owners[0]!;
      const insetName = presentation === "desktop" ? "--sidebar-content-inset" : "--panel-content-inset";
      const inset = getComputedStyle(owner).getPropertyValue(insetName).trim();
      const expectedInset = presentation === "desktop" ? "0.75rem" : "1.25rem";
      if (inset !== expectedInset) throw new Error("facet-evidence: inset");
      if (presentation === "mobile" && !owner.classList.contains("panel-edge-scroll-area"))
        throw new Error("facet-evidence: edge-body");
      const bounds = () => {
        const r = root.getBoundingClientRect();
        const p = owner.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          ownerLeft: p.left + owner.clientLeft,
          ownerRight: p.left + owner.clientLeft + owner.clientWidth,
        };
      };
      const exactEdges = () => {
        const b = bounds();
        if (Math.abs(b.left - b.ownerLeft) > 1 || Math.abs(b.right - b.ownerRight) > 1)
          throw new Error("facet-evidence: clipped-or-overbleed");
      };
      exactEdges();
      const originalBounds = bounds();
      const oldInset = owner.style.getPropertyValue(insetName);
      try {
        owner.style.setProperty(insetName, "2rem");
        exactEdges();
      } finally {
        if (oldInset) owner.style.setProperty(insetName, oldInset);
        else owner.style.removeProperty(insetName);
      }
      const style = getComputedStyle(root);
      if (parseFloat(style.marginTop) < 0 || parseFloat(style.marginBottom) < 0)
        throw new Error("facet-evidence: vertical-bleed");
      if (style.overflowAnchor !== "none") throw new Error("facet-evidence: anchoring");
      const items = Array.from(root.querySelectorAll<HTMLElement>("[data-accordion-item-value]"));
      const corners = items.map((item) => {
        const css = getComputedStyle(item);
        return {
          top: parseFloat(css.borderTopLeftRadius),
          bottom: parseFloat(css.borderBottomLeftRadius),
          divider: parseFloat(css.borderBottomWidth),
        };
      });
      if (
        corners.some(
          (corner, index) =>
            (index > 0 && index < corners.length - 1 && (corner.top !== 0 || corner.bottom !== 0)) ||
            (index < corners.length - 1 && corner.divider !== 1) ||
            (index === corners.length - 1 && corner.divider !== 0),
        )
      )
        throw new Error("facet-evidence: divider-or-corner");
      if (
        root.scrollWidth > root.clientWidth ||
        owner.scrollWidth > owner.clientWidth ||
        document.documentElement.scrollWidth > document.documentElement.clientWidth
      )
        throw new Error("facet-evidence: horizontal-overflow");
      if (presentation === "mobile") {
        const other = document.querySelector<HTMLElement>('[data-facet-list-presentation="desktop"]')!;
        if (other.dataset.facetExpandedValues !== '["categories","price-and-stock"]')
          throw new Error("facet-evidence: shared-state");
      }
      return {
        presentation,
        viewport: { width: innerWidth, height: innerHeight },
        expanded: ["language"],
        values,
        options: options.length,
        inset,
        bounds: originalBounds,
        corners,
        scrollOwners: owners.length,
        scrollTop: owner.scrollTop,
        symbolicInsetProbe: "pass",
        horizontalOverflow: 0,
      };
    },
    { selector: list(presentation), presentation },
  );
  return ledger;
}

async function attachLayout(page: Page, testInfo: TestInfo, presentation: Presentation) {
  const ledger = await inspectFacetList(page, presentation);
  await testInfo.attach("facet-layout", { body: JSON.stringify(ledger, null, 2), contentType: "application/json" });
}

function artifactsAbsent(testInfo: TestInfo, claimId: string) {
  const paths = responsiveEvidenceArtifactPaths(testInfo, claimId);
  expect(existsSync(paths.screenshot)).toBe(false);
  expect(existsSync(paths.manifest)).toBe(false);
}

test("captures one expanded populated desktop facet list @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 1280, 900);
  await attachLayout(page, testInfo, "desktop");
  await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-desktop" });
});

test("captures one expanded populated mobile facet list at 360 @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 360, 800);
  await attachLayout(page, testInfo, "mobile");
  await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-mobile-360" });
});

test("captures one expanded populated mobile facet list at 390 @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 390, 844);
  await attachLayout(page, testInfo, "mobile");
  await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-mobile-390" });
});

test("captures one expanded populated tablet facet list @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 820, 900);
  await attachLayout(page, testInfo, "mobile");
  await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-tablet" });
});

test("rejects the hidden desktop sibling before facet capture @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 390, 844);
  await inspectFacetList(page, "mobile");
  await expect(async () => {
    await inspectFacetList(page, "desktop");
    await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-hidden" });
  }).rejects.toThrow("facet-evidence: hidden-presentation");
  artifactsAbsent(testInfo, "facet-list-hidden");
});

test("rejects empty facet options before capture @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 390, 844);
  await inspectFacetList(page, "mobile");
  await page
    .locator("#search-facets-mobile-panel-language button[aria-pressed]")
    .evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await expect(async () => {
    await inspectFacetList(page, "mobile");
    await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-empty" });
  }).rejects.toThrow("facet-evidence: empty-options");
  artifactsAbsent(testInfo, "facet-list-empty");
});

test("rejects per-section facet roots before capture @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 390, 844);
  await inspectFacetList(page, "mobile");
  await page
    .locator("#search-facets-mobile [data-accordion-item-value]")
    .first()
    .evaluate((node) => node.setAttribute("data-facet-list-presentation", "mobile"));
  await expect(async () => {
    await inspectFacetList(page, "mobile");
    await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-per-root" });
  }).rejects.toThrow("facet-evidence: root-count");
  artifactsAbsent(testInfo, "facet-list-per-root");
});

test("rejects clipped facet edges before capture @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 390, 844);
  await inspectFacetList(page, "mobile");
  await page.locator(list("mobile")).evaluate((node) => {
    (node as HTMLElement).style.width = "100%";
  });
  await expect(async () => {
    await inspectFacetList(page, "mobile");
    await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-clipped" });
  }).rejects.toThrow("facet-evidence: clipped-or-overbleed");
  artifactsAbsent(testInfo, "facet-list-clipped");
});

test("rejects duplicate facet ids before capture @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 390, 844);
  await inspectFacetList(page, "mobile");
  await page.evaluate(() => {
    const node = document.createElement("span");
    node.id = "search-facets-mobile-panel-language";
    document.body.append(node);
  });
  await expect(async () => {
    await inspectFacetList(page, "mobile");
    await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-duplicate-id" });
  }).rejects.toThrow("facet-evidence: duplicate-id");
  artifactsAbsent(testInfo, "facet-list-duplicate-id");
});

test("rejects frozen responsive facet insets before capture @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 390, 844);
  await inspectFacetList(page, "mobile");
  await page.locator(list("mobile")).evaluate((node) => {
    const root = node as HTMLElement;
    root.style.marginInline = "-20px";
    root.style.width = "calc(100% + 40px)";
  });
  await expect(async () => {
    await inspectFacetList(page, "mobile");
    await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-frozen-inset" });
  }).rejects.toThrow("facet-evidence: clipped-or-overbleed");
  artifactsAbsent(testInfo, "facet-list-frozen-inset");
});

test("rejects browser-anchored facets before capture @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 390, 844);
  await inspectFacetList(page, "mobile");
  await page.locator(list("mobile")).evaluate((node) => {
    (node as HTMLElement).style.overflowAnchor = "auto";
  });
  await expect(async () => {
    await inspectFacetList(page, "mobile");
    await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-anchoring" });
  }).rejects.toThrow("facet-evidence: anchoring");
  artifactsAbsent(testInfo, "facet-list-anchoring");
});

test("rejects shared facet state before capture @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 390, 844);
  await inspectFacetList(page, "mobile");
  await page
    .locator(list("desktop"))
    .evaluate((node) => node.setAttribute("data-facet-expanded-values", '["language"]'));
  await expect(async () => {
    await inspectFacetList(page, "mobile");
    await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-shared-state" });
  }).rejects.toThrow("facet-evidence: shared-state");
  artifactsAbsent(testInfo, "facet-list-shared-state");
});

test("rejects the wrong visible facet presentation before capture @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 390, 844);
  await inspectFacetList(page, "mobile");
  await page.locator(list("desktop")).evaluate((node) => {
    node.closest("aside")!.parentElement!.style.display = "block";
  });
  await expect(async () => {
    await inspectFacetList(page, "desktop");
    await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-wrong-presentation" });
  }).rejects.toThrow("facet-evidence: wrong-presentation");
  artifactsAbsent(testInfo, "facet-list-wrong-presentation");
});

test("rejects over-bleeding facet edges before capture @marketplace-browse", async ({ page }, testInfo) => {
  await openFixture(page, 390, 844);
  await inspectFacetList(page, "mobile");
  await page.locator(list("mobile")).evaluate((node) => {
    (node as HTMLElement).style.width = "calc(100% + 80px)";
  });
  await expect(async () => {
    await inspectFacetList(page, "mobile");
    await captureResponsiveEvidence({ page, testInfo, claimId: "facet-list-overbleed" });
  }).rejects.toThrow("facet-evidence: clipped-or-overbleed");
  artifactsAbsent(testInfo, "facet-list-overbleed");
});

test("facet toggles retain both scroll positions and mobile reopen state @marketplace-browse", async ({
  page,
}, testInfo) => {
  const transitions = [];
  for (const width of [1280, 390]) {
    const presentation = await openFixture(page, width, 800);
    const root = page.locator(list(presentation));
    for (const value of ["categories", "price-and-stock"]) {
      await root.locator(`[data-facet-item-value="${value}"]`).evaluate((node: HTMLElement) => node.click());
    }
    const scrollPositions = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-facet-list-presentation]")).map((root) => {
          let owner = root.parentElement!;
          while (owner !== document.body && !/^(auto|scroll)$/.test(getComputedStyle(owner).overflowY))
            owner = owner.parentElement!;
          return { presentation: root.dataset.facetListPresentation, top: owner.scrollTop };
        }),
      );
    await root.evaluate((node) => {
      let owner = node.parentElement!;
      while (!/^(auto|scroll)$/.test(getComputedStyle(owner).overflowY)) owner = owner.parentElement!;
      owner.scrollTop = 24;
      if (owner.scrollTop !== 24) throw new Error("scroll fixture must exercise a populated overflowing owner");
    });
    const before = await scrollPositions();
    await root.locator('[data-facet-item-value="market-activity"]').evaluate((node: HTMLElement) => node.click());
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const after = await scrollPositions();
    expect(after).toEqual(before);
    transitions.push({ presentation, before, after });
    if (presentation === "mobile") {
      const values = await root.getAttribute("data-facet-expanded-values");
      await page.getByRole("button", { name: "Close filters", exact: true }).click();
      await page.getByRole("button", { name: "Open filters", exact: true }).click();
      await expect(page.locator(list("mobile"))).toHaveAttribute("data-facet-expanded-values", values!);
    }
  }
  await testInfo.attach("facet-scroll-transitions", {
    body: JSON.stringify(transitions, null, 2),
    contentType: "application/json",
  });
});
