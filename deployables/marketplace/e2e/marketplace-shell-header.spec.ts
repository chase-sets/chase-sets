import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { captureResponsiveEvidence } from "@chase-sets/playwright-evidence";
import { marketplaceBrowserE2eSeedContract } from "./support/seed-contract";

// Charter scope: this spec owns the real-browser proof of the MarketplaceShell
// search-row collapse (#5709) — the scroll-driven phase machine, the #6771
// route-policy equality, the focus reveal through real sequential keyboard
// traversal, constant document-flow contribution, the released vacated strip,
// and the responsive-evidence claims for the expanded/collapsed/always-expanded
// and md-breakpoint states. It does NOT re-test the resolver's full input
// matrix, hysteresis boundaries, or route-identity canonicalization, which the
// design-system and app-marketplace-web vitest suites own.
//
// CI lane: tagged @marketplace-browse so the change-scope `marketplace_browse`
// suite runs it; scripts/e2e-suites.mjs carries the ownership entry.

const COLLAPSE_FLOOR = 96;
const DIRECTION_DELTA = 24;
const phoneViewport = { width: 390, height: 844 };
const itemRoutePath = marketplaceBrowserE2eSeedContract.itemDetail.routePath;
const shellSelector = "[data-search-row-state]";
const slotSelector = "[data-search-row-slot]";
const paintedSelector = '[data-shell-header-box="painted"]';
const reservedSelector = '[data-shell-header-box="reserved"]';
const searchInputSelector = `${slotSelector} input[role='combobox']`;

type SearchRowObservationRecord = {
  startState: string | null;
  endState: string | null;
  mutations: Array<{ value: string | null; scrollY: number }>;
  scrollSamples: number[];
};

type ObservationWindow = {
  __searchRowObservation?: {
    record: Omit<SearchRowObservationRecord, "endState">;
    stop: () => void;
  };
};

async function openAtViewport(
  page: Page,
  path: string,
  viewport: { width: number; height: number },
  expectedStatus?: number,
) {
  // Render at the claim's viewport from the first paint so the phase machine
  // never initializes inside the wrong breakpoint.
  await page.setViewportSize(viewport);
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} did not return a page response`).not.toBeNull();
  if (expectedStatus !== undefined) {
    expect(response!.status(), `${path} returned HTTP ${response!.status()}`).toBe(expectedStatus);
  } else {
    expect(response!.status(), `${path} returned HTTP ${response!.status()}`).toBeLessThan(400);
  }
}

// The state attribute appears only after hydration resolves the first mount
// event, so waiting on it is the exact rendered-control wait; never
// networkidle.
async function waitForSearchRowPhase(page: Page, phase: "expanded" | "collapsed") {
  await expect(page.locator(`[data-search-row-state="${phase}"]`)).toHaveCount(1, { timeout: 15_000 });
}

async function assertScrollableForCollapseDrive(page: Page) {
  const scrollable = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  expect(
    scrollable,
    `route must be scrollable past COLLAPSE_FLOOR + DIRECTION_DELTA (${COLLAPSE_FLOOR + DIRECTION_DELTA}px); a short page can never pass by never moving`,
  ).toBeGreaterThan(COLLAPSE_FLOOR + DIRECTION_DELTA);
}

async function scrollWindowTo(page: Page, target: number) {
  await page.evaluate(async (y) => {
    window.scrollTo(0, y);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, target);
}

async function currentScrollY(page: Page) {
  return page.evaluate(() => window.scrollY);
}

// Past the floor with at least DIRECTION_DELTA of downward travel in one drive.
async function driveDownwardPastFloor(page: Page) {
  await assertScrollableForCollapseDrive(page);
  await scrollWindowTo(page, COLLAPSE_FLOOR + 104);
}

async function resolvedHeaderHeightPx(page: Page) {
  return page.evaluate(() => {
    const shell =
      document.querySelector("[data-search-row-state]") ?? document.querySelector('div[class*="--shell-header-height"]');
    if (!shell) {
      throw new Error("marketplace shell element not found");
    }
    const raw = getComputedStyle(shell).getPropertyValue("--shell-header-height").trim();
    const match = /^([\d.]+)(px|rem)$/.exec(raw);
    if (!match) {
      throw new Error(`unresolvable --shell-header-height token: ${raw || "<empty>"}`);
    }
    const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return match[2] === "rem" ? Number.parseFloat(match[1]!) * rootPx : Number.parseFloat(match[1]!);
  });
}

// Criterion 8 instrumentation: records every data-search-row-state mutation and
// every scroll sample between install and drain, so a transient state change
// restored before a capture returns is visible even though before-and-after
// assertions stay green.
async function installSearchRowObservation(page: Page) {
  await page.evaluate(() => {
    const shell = document.querySelector("[data-search-row-state]");
    if (!shell) {
      throw new Error("search-row shell not present; cannot install observation");
    }
    const record: { startState: string | null; mutations: Array<{ value: string | null; scrollY: number }>; scrollSamples: number[] } = {
      startState: shell.getAttribute("data-search-row-state"),
      mutations: [],
      scrollSamples: [],
    };
    const observer = new MutationObserver((entries) => {
      for (const entry of entries) {
        if (entry.type === "attributes" && entry.attributeName === "data-search-row-state") {
          record.mutations.push({
            value: (entry.target as Element).getAttribute("data-search-row-state"),
            scrollY: window.scrollY,
          });
        }
      }
    });
    observer.observe(shell, { attributes: true, attributeFilter: ["data-search-row-state"] });
    const onScroll = () => {
      record.scrollSamples.push(window.scrollY);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    (window as unknown as ObservationWindow).__searchRowObservation = {
      record,
      stop() {
        observer.disconnect();
        window.removeEventListener("scroll", onScroll);
      },
    };
  });
}

async function drainSearchRowObservation(page: Page): Promise<SearchRowObservationRecord> {
  return page.evaluate(() => {
    const observationWindow = window as unknown as ObservationWindow;
    const observation = observationWindow.__searchRowObservation;
    if (!observation) {
      throw new Error("search-row observation was never installed");
    }
    observation.stop();
    delete observationWindow.__searchRowObservation;
    return {
      ...observation.record,
      endState:
        document.querySelector("[data-search-row-state]")?.getAttribute("data-search-row-state") ?? null,
    };
  });
}

async function publishRecord(testInfo: TestInfo, name: string, record: unknown) {
  await testInfo.attach(name, {
    body: JSON.stringify(record, null, 2),
    contentType: "application/json",
  });
}

test.describe("marketplace shell search-row collapse (#5709)", () => {
  test("publishes the expanded search row before scrolling on the pinned item route @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openAtViewport(page, itemRoutePath, phoneViewport);
    await waitForSearchRowPhase(page, "expanded");
    await expect(page.locator(searchInputSelector)).toBeVisible();
    expect(await resolvedHeaderHeightPx(page)).toBeCloseTo(124, 0);

    await installSearchRowObservation(page);
    await captureResponsiveEvidence({ page, testInfo, claimId: "marketplace-shell-search-row-expanded-390" });
    const observation = await drainSearchRowObservation(page);
    await publishRecord(testInfo, "search-row-expanded-observation", observation);
    expect(observation.startState).toBe("expanded");
    expect(observation.endState).toBe("expanded");
    expect(observation.mutations).toEqual([]);
    for (const sample of observation.scrollSamples) {
      expect(sample, "expanded capture must stay in the pre-floor regime").toBeLessThan(COLLAPSE_FLOOR);
    }

    // The same route collapses after the downward drive: control not visible,
    // geometry 64px. The collapsed claim itself is captured by the
    // observation-binding test below.
    await driveDownwardPastFloor(page);
    await waitForSearchRowPhase(page, "collapsed");
    // The input keeps its clipped box while the slot row itself has a zero box;
    // Playwright visibility therefore proves the row hidden through the slot.
    await expect(page.locator(slotSelector)).not.toBeVisible();
    expect(await resolvedHeaderHeightPx(page)).toBeCloseTo(64, 0);
  });

  test("binds the search-row state observed across the responsive capture @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openAtViewport(page, itemRoutePath, phoneViewport);
    await waitForSearchRowPhase(page, "expanded");
    await driveDownwardPastFloor(page);
    await waitForSearchRowPhase(page, "collapsed");
    // Let the 200ms grid-rows transition settle so the claim capture observes
    // the steady collapsed geometry, not a mid-transition frame.
    await expect(page.locator(slotSelector)).not.toBeVisible();
    const scrollBefore = await currentScrollY(page);
    expect(scrollBefore).toBeGreaterThanOrEqual(COLLAPSE_FLOOR);

    await installSearchRowObservation(page);
    await captureResponsiveEvidence({ page, testInfo, claimId: "marketplace-shell-search-row-collapsed-390" });
    const observation = await drainSearchRowObservation(page);
    await publishRecord(testInfo, "search-row-collapsed-observation", observation);

    // Pre-state, screenshot-time state, and post-state are all collapsed, with
    // zero intermediate mutations and every scroll sample in the collapsed
    // regime — the capture cannot have transiently revealed the row.
    expect(observation.startState).toBe("collapsed");
    expect(observation.endState).toBe("collapsed");
    expect(observation.mutations).toEqual([]);
    for (const sample of observation.scrollSamples) {
      expect(sample, "collapsed capture must stay past COLLAPSE_FLOOR").toBeGreaterThanOrEqual(COLLAPSE_FLOOR);
    }
    expect(await currentScrollY(page)).toBe(scrollBefore);
    await expect(page.locator(`[data-search-row-state="collapsed"]`)).toHaveCount(1);
  });

  test("fails the search-row observation when a transient full-page shim changes state during capture @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openAtViewport(page, itemRoutePath, phoneViewport);
    await waitForSearchRowPhase(page, "expanded");
    await driveDownwardPastFloor(page);
    await waitForSearchRowPhase(page, "collapsed");
    const priorScrollY = await currentScrollY(page);

    // Deliberately labelled TEST-ONLY SHIM reproducing the transient-scroll
    // defect shape: scroll to the top (revealing the row), take a full-page
    // image, and restore the prior offset before returning, so plain
    // before-and-after assertions stay green.
    await installSearchRowObservation(page);
    await scrollWindowTo(page, 0);
    await waitForSearchRowPhase(page, "expanded");
    await page.screenshot({ path: testInfo.outputPath("transient-shim-full-page.png"), fullPage: true });
    await scrollWindowTo(page, priorScrollY);
    await waitForSearchRowPhase(page, "collapsed");
    const shimObservation = await drainSearchRowObservation(page);
    await publishRecord(testInfo, "transient-shim-observation", shimObservation);

    // Before-and-after alone is green (collapsed -> collapsed) — and the
    // observation still reports the intermediate transition, which is exactly
    // what turns criterion 8 red against this defect.
    expect(shimObservation.startState).toBe("collapsed");
    expect(shimObservation.endState).toBe("collapsed");
    expect(shimObservation.mutations.length).toBeGreaterThan(0);
    expect(shimObservation.mutations.map((mutation) => mutation.value)).toContain("expanded");
    expect(shimObservation.scrollSamples.some((sample) => sample < COLLAPSE_FLOOR)).toBe(true);

    // The canonical path over the same claim stays green with zero intermediate
    // mutations and a collapsed post-state.
    await expect(page.locator(slotSelector)).not.toBeVisible();
    await installSearchRowObservation(page);
    await captureResponsiveEvidence({ page, testInfo, claimId: "marketplace-shell-search-row-collapsed-390" });
    const canonicalObservation = await drainSearchRowObservation(page);
    await publishRecord(testInfo, "canonical-collapsed-observation", canonicalObservation);
    expect(canonicalObservation.startState).toBe("collapsed");
    expect(canonicalObservation.endState).toBe("collapsed");
    expect(canonicalObservation.mutations).toEqual([]);
  });

  test("reveals the collapsed search row through sequential keyboard focus @marketplace-browse", async ({
    page,
  }, testInfo) => {
    // Signed-out session: the layout renders no header actions, so the complete
    // sequential order below md is SkipLink, brand link, search input, search
    // trigger, first main-content focusable. Every stop below is produced by a
    // real Tab or Shift+Tab key press; no scripted focus() appears anywhere.
    await openAtViewport(page, itemRoutePath, phoneViewport);
    await waitForSearchRowPhase(page, "expanded");

    type TraceStop = {
      direction: "tab" | "shift-tab" | "drive";
      phase: string | null;
      activeElement: string;
      headerHeightPx: number;
    };
    const trace: TraceStop[] = [];

    async function describeActiveElement() {
      return page.evaluate(() => {
        const active = document.activeElement;
        if (!active || active === document.body) {
          return "body";
        }
        const tag = active.tagName.toLowerCase();
        const label = active.getAttribute("aria-label") ?? active.getAttribute("href") ?? active.textContent?.trim();
        const inHeader = active.closest('[data-shell-header-box="reserved"]') !== null;
        const inSlot = active.closest("[data-search-row-slot]") !== null;
        const inMain = active.closest("#main-content") !== null;
        return `${tag}[${label ?? ""}] header=${String(inHeader)} slot=${String(inSlot)} main=${String(inMain)}`;
      });
    }

    async function recordStop(direction: TraceStop["direction"]) {
      trace.push({
        direction,
        phase: await page.locator(shellSelector).getAttribute("data-search-row-state"),
        activeElement: await describeActiveElement(),
        headerHeightPx: await resolvedHeaderHeightPx(page),
      });
    }

    // Forward: Tab from the unfocused document stops on the SkipLink, which is
    // outside the header element and position: fixed when focused, so it
    // neither pins the row nor restores scroll.
    await page.keyboard.press("Tab");
    const skipLinkFacts = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLAnchorElement)) {
        return null;
      }
      return {
        href: active.getAttribute("href"),
        position: getComputedStyle(active).position,
        inHeader: active.closest('[data-shell-header-box="reserved"]') !== null,
      };
    });
    expect(skipLinkFacts).toEqual({ href: "#main-content", position: "fixed", inHeader: false });
    await recordStop("tab");

    // Drive past the floor with at least DIRECTION_DELTA of downward travel
    // while focus stays on the SkipLink; the row collapses to 64px.
    await driveDownwardPastFloor(page);
    await waitForSearchRowPhase(page, "collapsed");
    expect(await resolvedHeaderHeightPx(page)).toBeCloseTo(64, 0);
    await recordStop("drive");

    // The next Tab stops on the brand link — the first header stop — where the
    // row expands to 124px.
    await page.keyboard.press("Tab");
    await waitForSearchRowPhase(page, "expanded");
    const brandFacts = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        isBrandLink: active instanceof HTMLAnchorElement && active.getAttribute("href") === "/",
        inHeader: active?.closest('[data-shell-header-box="reserved"]') !== null,
      };
    });
    expect(brandFacts).toEqual({ isBrandLink: true, inHeader: true });
    expect(await page.locator(shellSelector).getAttribute("data-search-row-state")).toBe("expanded");
    expect(await resolvedHeaderHeightPx(page)).toBeCloseTo(124, 0);
    await recordStop("tab");

    // The Tab after it stops on the search input, still expanded at 124px.
    await page.keyboard.press("Tab");
    const inputFacts = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        isSearchInput: active instanceof HTMLInputElement,
        inSlot: active?.closest("[data-search-row-slot]") !== null,
      };
    });
    expect(inputFacts).toEqual({ isSearchInput: true, inSlot: true });
    expect(await page.locator(shellSelector).getAttribute("data-search-row-state")).toBe("expanded");
    expect(await resolvedHeaderHeightPx(page)).toBeCloseTo(124, 0);
    await recordStop("tab");

    // Reverse: Tab until focus reaches the first focusable inside
    // #main-content, which the trace names.
    let reachedMain = false;
    for (let press = 0; press < 40 && !reachedMain; press += 1) {
      await page.keyboard.press("Tab");
      reachedMain = await page.evaluate(() => document.activeElement?.closest("#main-content") !== null);
    }
    expect(reachedMain, "sequential Tab must reach a focusable inside #main-content").toBe(true);
    await recordStop("tab");

    // Drive back past the floor while focus stays there; the row collapses with
    // the active element outside the header.
    const beyond = await page.evaluate(() => window.scrollY + 200);
    await scrollWindowTo(page, beyond);
    await scrollWindowTo(page, beyond + DIRECTION_DELTA + 8);
    await waitForSearchRowPhase(page, "collapsed");
    expect(
      await page.evaluate(() => document.activeElement?.closest('[data-shell-header-box="reserved"]') === null),
    ).toBe(true);
    expect(await resolvedHeaderHeightPx(page)).toBeCloseTo(64, 0);
    await recordStop("drive");

    // The next Shift+Tab stops on the search trigger — the last header
    // focusable when signed out — expanding the row to 124px.
    await page.keyboard.press("Shift+Tab");
    await waitForSearchRowPhase(page, "expanded");
    const triggerFacts = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        isButton: active instanceof HTMLButtonElement,
        inSlot: active?.closest("[data-search-row-slot]") !== null,
      };
    });
    expect(triggerFacts).toEqual({ isButton: true, inSlot: true });
    expect(await resolvedHeaderHeightPx(page)).toBeCloseTo(124, 0);
    await recordStop("shift-tab");

    // And the one after it on the search input, still expanded at 124px.
    await page.keyboard.press("Shift+Tab");
    const reverseInputFacts = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        isSearchInput: active instanceof HTMLInputElement,
        inSlot: active?.closest("[data-search-row-slot]") !== null,
      };
    });
    expect(reverseInputFacts).toEqual({ isSearchInput: true, inSlot: true });
    expect(await page.locator(shellSelector).getAttribute("data-search-row-state")).toBe("expanded");
    expect(await resolvedHeaderHeightPx(page)).toBeCloseTo(124, 0);
    await recordStop("shift-tab");

    await publishRecord(testInfo, "keyboard-focus-reveal-trace", trace);
  });

  test("keeps the search row expanded on the search route under the same downward scroll @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openAtViewport(page, "/search?q=charizard", phoneViewport);
    await waitForSearchRowPhase(page, "expanded");

    // The identical downward drive that collapses the item route leaves the
    // registered result route expanded at any distance.
    await driveDownwardPastFloor(page);
    await expect(page.locator(`[data-search-row-state="expanded"]`)).toHaveCount(1);
    await expect(page.locator(searchInputSelector)).toBeVisible();
    expect(await resolvedHeaderHeightPx(page)).toBeCloseTo(124, 0);

    await installSearchRowObservation(page);
    await captureResponsiveEvidence({ page, testInfo, claimId: "marketplace-shell-search-row-search-route-390" });
    const observation = await drainSearchRowObservation(page);
    await publishRecord(testInfo, "search-route-observation", observation);
    expect(observation.startState).toBe("expanded");
    expect(observation.endState).toBe("expanded");
    expect(observation.mutations).toEqual([]);
  });

  test("collapses every pathname that is not exactly /search @marketplace-browse", async ({ page }, testInfo) => {
    // Closed published table: armed, high-scroll, unfocused outcomes per route,
    // plus focus-inside-header expanded on all of them, with the header search
    // slot present on every one. The account pathname redirects signed-out to
    // the sign-in route, which is equally a non-/search pathname.
    const table = [
      { path: "/search?q=charizard", expected: "expanded" as const, expectedStatus: undefined },
      // The layout catch-all serves this unregistered pathname under the shell;
      // the dev server answers 200 for it, and the criterion binds route policy,
      // not the status code.
      { path: "/search/charizard-does-not-exist", expected: "collapsed" as const, expectedStatus: undefined },
      { path: itemRoutePath, expected: "collapsed" as const, expectedStatus: undefined },
      { path: "/categories/pokemon", expected: "collapsed" as const, expectedStatus: undefined },
      { path: "/account/listings", expected: "collapsed" as const, expectedStatus: undefined },
    ];
    const observed: Array<{ path: string; landedPathname: string; phase: string | null; focusPhase: string | null }> =
      [];

    for (const row of table) {
      await openAtViewport(page, row.path, phoneViewport, row.expectedStatus);
      await expect(page.locator(shellSelector)).toHaveCount(1, { timeout: 15_000 });
      // I5: no route omits the header search slot.
      await expect(page.locator(slotSelector)).toHaveCount(1);
      await driveDownwardPastFloor(page);
      await expect(page.locator(`[data-search-row-state="${row.expected}"]`)).toHaveCount(1);

      // Focus inside the header expands every route regardless of policy; this
      // is not criterion 5's unscripted trace, so a direct focus is fine here.
      await page.locator(searchInputSelector).focus();
      await waitForSearchRowPhase(page, "expanded");
      const focusPhase = await page.locator(shellSelector).getAttribute("data-search-row-state");
      observed.push({
        path: row.path,
        landedPathname: await page.evaluate(() => window.location.pathname),
        phase: row.expected,
        focusPhase,
      });
    }
    await publishRecord(testInfo, "route-policy-table", observed);
    expect(observed.every((row) => row.focusPhase === "expanded")).toBe(true);

    // Synthetic opposite-policy control: a policy that lets /search collapse
    // and every other pathname resist cannot satisfy the observed table — the
    // /search row alone rejects it while every route retained the header slot.
    const oppositePolicyExpectation = table.map((row) => ({
      path: row.path,
      phase: row.path.startsWith("/search?") ? "collapsed" : "expanded",
    }));
    const observedPhases = observed.map((row) => ({ path: row.path, phase: row.phase }));
    expect(observedPhases).not.toEqual(oppositePolicyExpectation);
    expect(observedPhases[0]).toEqual({ path: "/search?q=charizard", phase: "expanded" });
  });

  test("keeps page content anchored across the search-row collapse @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openAtViewport(page, itemRoutePath, phoneViewport);
    await waitForSearchRowPhase(page, "expanded");
    await driveDownwardPastFloor(page);
    await waitForSearchRowPhase(page, "collapsed");

    const collapsedFacts = await page.evaluate(() => {
      const anchor = document.querySelector("#main-content h1");
      const reserved = document.querySelector('[data-shell-header-box="reserved"]');
      if (!anchor || !reserved) {
        throw new Error("anchor heading or reserved header box not found");
      }
      return {
        scrollY: window.scrollY,
        anchorY: anchor.getBoundingClientRect().y,
        reservedHeight: reserved.getBoundingClientRect().height,
      };
    });

    // Reveal at the same scroll offset through the focus pin, so only the phase
    // differs between the two measurements.
    await page.locator(searchInputSelector).focus();
    await waitForSearchRowPhase(page, "expanded");
    const expandedFacts = await page.evaluate(() => {
      const anchor = document.querySelector("#main-content h1");
      const reserved = document.querySelector('[data-shell-header-box="reserved"]');
      if (!anchor || !reserved) {
        throw new Error("anchor heading or reserved header box not found");
      }
      return {
        scrollY: window.scrollY,
        anchorY: anchor.getBoundingClientRect().y,
        reservedHeight: reserved.getBoundingClientRect().height,
      };
    });

    await publishRecord(testInfo, "content-anchoring-measurements", { collapsedFacts, expandedFacts });
    expect(expandedFacts.scrollY).toBe(collapsedFacts.scrollY);
    expect(Math.abs(expandedFacts.anchorY - collapsedFacts.anchorY)).toBeLessThanOrEqual(1);
    expect(collapsedFacts.reservedHeight).toBe(expandedFacts.reservedHeight);
  });

  test("releases the vacated header strip to page content @marketplace-browse", async ({ page }, testInfo) => {
    await openAtViewport(page, itemRoutePath, phoneViewport);
    await waitForSearchRowPhase(page, "expanded");
    await driveDownwardPastFloor(page);
    await waitForSearchRowPhase(page, "collapsed");

    const probe = await page.evaluate(() => {
      const painted = document.querySelector('[data-shell-header-box="painted"]');
      const reserved = document.querySelector('[data-shell-header-box="reserved"]');
      if (!painted || !reserved) {
        throw new Error("painted or reserved header box not found");
      }
      const paintedBottom = painted.getBoundingClientRect().bottom;
      const reservedBottom = reserved.getBoundingClientRect().bottom;
      const probeY = paintedBottom + Math.min(10, (reservedBottom - paintedBottom) / 2);
      const probeX = window.innerWidth / 2;
      const element = document.elementFromPoint(probeX, probeY);
      const elementBox = element?.getBoundingClientRect() ?? null;
      return {
        paintedBottom,
        reservedBottom,
        probeX,
        probeY,
        resolvedElement: element
          ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${element.className
              .toString()
              .split(/\s+/)
              .slice(0, 3)
              .join(".")}`
          : null,
        resolvedBox: elementBox ? { x: elementBox.x, y: elementBox.y, width: elementBox.width, height: elementBox.height } : null,
        insideHeader: element ? element.closest('[data-shell-header-box="reserved"]') !== null : null,
      };
    });

    await publishRecord(testInfo, "vacated-strip-probe", probe);
    expect(probe.probeY).toBeGreaterThan(probe.paintedBottom);
    expect(probe.probeY).toBeLessThan(probe.reservedBottom);
    expect(probe.resolvedElement).not.toBeNull();
    // The strip resolves to page content: neither the header nav nor any
    // descendant of it.
    expect(probe.insideHeader).toBe(false);
  });

  test("keeps the search row inline in a single header row at 768 @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await openAtViewport(page, itemRoutePath, { width: 768, height: 1024 });
    const nav = page.locator('nav[aria-label="Primary navigation"]');
    await expect(nav).toBeVisible();
    const navInput = page.locator('nav[aria-label="Primary navigation"] input[role="combobox"]');
    await expect(navInput).toBeVisible();

    // At or above md the shell is inert: no phase attribute is ever published,
    // while the stable structure keeps the search row mounted inline.
    await expect(page.locator(shellSelector)).toHaveCount(0);
    await expect(page.locator(slotSelector)).toHaveCount(1);
    expect(await resolvedHeaderHeightPx(page)).toBeCloseTo(64, 0);

    // Scrolling collapses nothing.
    await assertScrollableForCollapseDrive(page);
    await scrollWindowTo(page, COLLAPSE_FLOOR + 104);
    await expect(navInput).toBeVisible();
    await expect(page.locator(shellSelector)).toHaveCount(0);
    expect(await resolvedHeaderHeightPx(page)).toBeCloseTo(64, 0);

    await captureResponsiveEvidence({ page, testInfo, claimId: "marketplace-shell-search-row-desktop-768" });
  });
});
