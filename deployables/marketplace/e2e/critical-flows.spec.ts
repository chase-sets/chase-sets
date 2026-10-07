import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  captureAccessibilityEvidence,
  captureResponsiveEvidence,
  expectAccessibleDisclosure,
  expectAccessibleMain,
} from "@chase-sets/playwright-evidence";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { registerSyntheticAccount, signInWithPassword, syntheticAccountFor } from "./support/auth";
import { marketplaceBrowserE2eSeedContract, marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

const configuredMarketplaceAccount = {
  email: process.env.MARKETPLACE_E2E_EMAIL?.trim() ?? "",
  password: process.env.MARKETPLACE_E2E_PASSWORD?.trim() ?? "",
};

const searchQuery = process.env.MARKETPLACE_E2E_SEARCH_QUERY ?? "charizard";
const authProjectionTimeoutMs = 90_000;

const accountCriticalRoutes = [
  { path: "/account/cart", heading: /^Your cart$/i, flow: "buy cart" },
  { path: "/account/sell-list", heading: /^Sell List$/i, flow: "sell list" },
  { path: "/account/listings", heading: /^Listings$/i, flow: "listings" },
  { path: "/account/repricing", heading: /^Repricing$/i, flow: "repricing" },
  { path: "/account/offers/submitted", heading: /^Submitted Offers$/i, flow: "submitted offers" },
  { path: "/account/offers/matches", heading: /^Offer Matches$/i, flow: "offer matches" },
  { path: "/account/inventory", heading: /^Inventory$/i, flow: "inventory" },
  { path: "/account/purchases", heading: /^Purchases$/i, flow: "purchases" },
  { path: "/account/sales", heading: /^Sales$/i, flow: "sales" },
  { path: "/account/desk/money", heading: /^Money$/i, flow: "money" },
] as const;

type AccountRoute = {
  path: string;
  heading: RegExp;
  flow: string;
};

const protectedAccountRoutes = [
  { path: "/account/listings", flow: "listings" },
  { path: "/account/security", flow: "security" },
  { path: "/account/shipping-addresses", flow: "shipping addresses" },
  { path: "/account/support", flow: "support" },
  { path: "/account/reviews/written", flow: "written reviews" },
] as const;

async function expectPageOk(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} did not return a page response`).not.toBeNull();
  expect(response!.status(), `${path} returned HTTP ${response!.status()}`).toBeLessThan(400);
}

async function expectAccountRouteReady(page: Page, route: AccountRoute) {
  await expect
    .poll(
      async () => {
        const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
        expect(response, `${route.path} did not return a page response`).not.toBeNull();
        expect(response!.status(), `${route.path} returned HTTP ${response!.status()}`).toBeLessThan(400);

        if (new URL(page.url()).pathname !== route.path) {
          return false;
        }

        await expect(page.getByRole("heading", { name: route.heading }).first()).toBeVisible();
        return true;
      },
      { intervals: [1_000, 2_000, 5_000], timeout: authProjectionTimeoutMs },
    )
    .toBe(true);
}

function marketplaceAccountFor(testInfo: TestInfo) {
  if (configuredMarketplaceAccount.email) {
    if (!configuredMarketplaceAccount.password) {
      throw new Error("MARKETPLACE_E2E_PASSWORD is required when MARKETPLACE_E2E_EMAIL is configured.");
    }

    return {
      email: configuredMarketplaceAccount.email,
      password: configuredMarketplaceAccount.password,
      displayName: "Marketplace E2E Account",
      shouldRegister: false,
    };
  }

  return syntheticAccountFor(testInfo);
}

async function authenticateAccount(page: Page, testInfo: TestInfo) {
  await expectPageOk(page, "/");
  const origin = new URL(page.url()).origin;
  const credentials = marketplaceAccountFor(testInfo);

  if (credentials.shouldRegister) {
    return {
      ...credentials,
      sessionToken: await registerSyntheticAccount(page, origin, credentials),
    };
  }

  return {
    ...credentials,
    sessionToken: await signInWithPassword(page, origin, credentials),
  };
}

async function waitForPreferences(
  page: Page,
  expected: Readonly<{
    colorMode?: string;
    reducedMotion?: string;
  }>,
) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/identity/preferences");
        expect(response.status()).toBe(200);
        return (await response.json()) as { colorMode?: string; reducedMotion?: string };
      },
      { timeout: authProjectionTimeoutMs },
    )
    .toMatchObject(expected);
}

async function openAccountColorThemeControl(page: Page) {
  const accountMenu = page.getByRole("button", { name: "Account menu" });
  const colorTheme = page.getByRole("group", { name: "Color theme" });

  await expect(accountMenu).toBeVisible();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await accountMenu.click();
    const opened = await colorTheme
      .waitFor({ state: "visible", timeout: 500 })
      .then(() => true)
      .catch(() => false);

    if (opened) {
      return colorTheme;
    }
  }

  await expect(colorTheme).toBeVisible();
  return colorTheme;
}

function expectFirstPaintChaseRoot(html: string, expected: Readonly<{ colorMode: string; reducedMotion: string }>) {
  const root = html.match(/<div\s[^>]*data-chase-theme=""[^>]*>/)?.[0] ?? "";

  expect(root, "first paint should include the design-system shell root").toContain('data-chase-theme=""');
  expect(root).toContain(`data-color-mode="${expected.colorMode}"`);
  expect(root).toContain(`data-reduced-motion="${expected.reducedMotion}"`);
  expect(root).not.toContain('data-color-mode="light"');
}

test.describe("marketplace critical flows", () => {
  test("6110 populated browse passes exclusion-free axe @marketplace-browse", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await expectPageOk(page, "/search?q=pokemon");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const response = await page.request.get("/api/marketplace/items?search=pokemon&includeTotal=true&limit=24");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { total: number; items: { catalog_item_id: string; slug: string }[] };
    expect(body.total).toBe(10);
    expect(body.items).toHaveLength(10);
    const orderedIds = body.items.map((item) => item.catalog_item_id);
    expect(new Set(orderedIds).size).toBe(10);
    expect([...orderedIds].sort()).toEqual(
      [
        catalogSeedIds.items.bulbasaurBaseSet,
        catalogSeedIds.items.charizardBaseSet,
        catalogSeedIds.items.japaneseCharizardBaseSet,
        catalogSeedIds.items.lugiaNeoGenesis,
        catalogSeedIds.items.mewtwoBlackStarPromo,
        catalogSeedIds.items.pikachuJungle,
        catalogSeedIds.items.pikachuPrismaticEvolutions,
        catalogSeedIds.items.prismaticEvolutionsBoosterPack,
        catalogSeedIds.items.surgingSparksBoosterBox,
        catalogSeedIds.items.twilightMasqueradeEliteTrainerBox,
      ].sort(),
    );
    expect(body.items.every((item) => typeof item.slug === "string" && item.slug.length > 0)).toBe(true);
    const expectedHrefs = body.items.map((item) => `/items/${item.slug}`).sort();
    const main = page.getByRole("main");
    const facets = main.locator('[data-facet-list-presentation="desktop"]');
    const cards = main.locator('article[data-card-layout="search-result"]');
    async function ready() {
      await expectAccessibleMain(page);
      await expect(facets).toBeVisible();
      for (const value of ["categories", "price-and-stock"]) {
        await expectAccessibleDisclosure(facets.locator(`[data-facet-item-value="${value}"]`));
      }
      await expect
        .poll(() =>
          facets
            .locator('input[role="spinbutton"]')
            .evaluateAll(
              (inputs) =>
                inputs.length === 2 &&
                inputs.every(
                  (input) =>
                    Array.from(document.querySelectorAll("label[for]")).filter(
                      (label) => label.getAttribute("for") === input.id,
                    ).length === 1 &&
                    Array.from(document.querySelectorAll("[id]")).filter((owner) => owner.id === input.id).length === 1,
                ),
            ),
        )
        .toBe(true);
      await expect(cards).toHaveCount(10);
      for (const card of await cards.all()) {
        await expect(card).toBeVisible();
        const link = card.getByRole("link", { name: /^View details for / });
        await expect(link).toHaveCount(1);
        await expect(link).toBeVisible();
      }
      await expect(cards.getByRole("link", { name: /^View details for / })).toHaveCount(10);
    }
    const snapshot = () =>
      cards.evaluateAll((elements) =>
        elements.map((card) => ({
          html: card.outerHTML,
          bounds: card.getBoundingClientRect().toJSON(),
          links: Array.from(card.querySelectorAll<HTMLAnchorElement>("a[aria-label]"))
            .filter((link) => /^View details for /.test(link.getAttribute("aria-label") ?? ""))
            .map((link) => ({
              href: link.getAttribute("href"),
              visible: link.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }),
            })),
          broadCount: card.querySelectorAll('a[href^="/items/"]').length,
          broadLinks: Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href^="/items/"]'), (link) => ({
            href: link.getAttribute("href"),
            visible: link.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }),
          })),
        })),
      );
    await ready();
    let previous: Awaited<ReturnType<typeof snapshot>> | undefined;
    await expect
      .poll(async () => {
        const current = await snapshot();
        const equal = JSON.stringify(current) === JSON.stringify(previous);
        previous = current;
        return equal;
      })
      .toBe(true);
    const stable = previous!;
    function assertCards(snapshot: typeof stable) {
      expect(snapshot, "ten populated cards").toHaveLength(10);
      for (const card of snapshot) {
        expect(card.links, "one detail link per card").toHaveLength(1);
        expect(card.links[0]!.visible).toBe(true);
      }
      const hrefs = snapshot.flatMap((card) => card.links.map((link) => link.href));
      expect(hrefs).toHaveLength(10);
      expect(new Set(hrefs).size, "unique detail destinations").toBe(10);
      expect([...hrefs].sort(), "exact API detail destinations").toEqual(expectedHrefs);
    }
    assertCards(stable);
    const hrefs = stable.flatMap((card) => card.links.map((link) => link.href));
    expect(() => assertCards(stable.map((card) => ({ ...card, links: card.broadLinks })))).toThrow(
      "one detail link per card",
    );
    for (const links of [[], [...stable[0]!.links, ...stable[0]!.links]]) {
      expect(() => assertCards([{ ...stable[0]!, links }, ...stable.slice(1)])).toThrow("one detail link per card");
    }
    for (const href of ["/items/6110-wrong-item", `${stable[0]!.links[0]!.href}?unexpected=1`]) {
      expect(() => assertCards([{ ...stable[0]!, links: [{ href, visible: true }] }, ...stable.slice(1)])).toThrow(
        "exact API detail destinations",
      );
    }
    expect(() => assertCards([{ ...stable[0]!, links: stable[1]!.links }, ...stable.slice(1)])).toThrow(
      "unique detail destinations",
    );
    expect(() => assertCards([])).toThrow("ten populated cards");
    await ready();
    expect(await snapshot()).toEqual(stable);
    await testInfo.attach("6110-browse-state", {
      body: JSON.stringify({
        status: response.status(),
        total: body.total,
        orderedIds,
        hrefs,
        cards: stable,
        facets: await facets.evaluate((element) => ({
          html: element.outerHTML,
          bounds: element.getBoundingClientRect().toJSON(),
          panels: Array.from(element.querySelectorAll('[role="region"]'), (panel) => ({
            id: panel.id,
            labelledBy: panel.getAttribute("aria-labelledby"),
            bounds: panel.getBoundingClientRect().toJSON(),
          })),
        })),
        viewport: page.viewportSize(),
        url: page.url(),
      }),
      contentType: "application/json",
    });
    await ready();
    expect(await snapshot()).toEqual(stable);
    await captureAccessibilityEvidence({ page, testInfo, surface: "6110-populated-browse" });
  });

  test("signed-out shoppers can browse, search, and reach auth entry points @marketplace-browse", async ({ page }) => {
    await expectPageOk(page, "/search");

    const searchBox = page.getByRole("searchbox").first();
    await expect(searchBox).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Find trading cards worth chasing.");
    await expect(searchBox).toHaveAttribute("placeholder", "Search Charizard, Black Lotus, Dark Magician, Luffy...");
    await expect(page.getByRole("link", { name: "Sign In" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Register" }).first()).toBeVisible();

    await searchBox.fill(searchQuery);
    await expect(searchBox).toHaveValue(searchQuery);
    await expect(page.getByRole("link", { name: /View details for/i }).first()).toBeVisible();

    await page.getByRole("link", { name: "Sign In" }).first().click();
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByText(/^Sign in$/i).first()).toBeVisible();
    await expect(page.getByLabel(/Email or phone/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();

    await page.getByRole("link", { name: "Register" }).first().click();
    await expect(page).toHaveURL(/\/register/);
    await expect(page.getByRole("heading", { name: "Create your account", exact: true })).toBeVisible();
    await expect(page.getByText("Passkey").first()).toBeVisible();
  });

  test("records sign-in method list and email option at 390x844 @marketplace-account", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expectPageOk(page, "/sign-in");
    await expect(page.getByLabel(/Email or phone/)).toHaveValue("");
    await expect(page.locator('main [role="listitem"]')).toHaveText([
      "Password",
      "Phone Code",
      "Email me a sign-in link",
      "Passkey",
    ]);
    await expect(page.getByRole("radiogroup")).toHaveCount(0);
    await captureResponsiveEvidence({ page, testInfo, claimId: "sign-in-methods-mobile" });

    await page.getByLabel(/Email or phone/).fill("evidence@example.com");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("radio", { name: "Email me a sign-in link", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Email me a sign-in link", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("radiogroup").evaluate(async (group) => {
      await Promise.all(group.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    await expect(page.getByText("We'll email you a one-time link.", { exact: true })).toBeVisible();
    const emailButton = page.getByRole("button", { name: "Email me a sign-in link", exact: true });
    await expect(emailButton).toBeEnabled();
    await expect(emailButton.locator("svg.lucide-mail")).toBeVisible();
    await captureResponsiveEvidence({ page, testInfo, claimId: "sign-in-email-option-mobile" });
  });

  test("records sign-in method list and email option at 1280x900 @marketplace-account", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectPageOk(page, "/sign-in");
    await expect(page.getByLabel(/Email or phone/)).toHaveValue("");
    await expect(page.locator('main [role="listitem"]')).toHaveText([
      "Password",
      "Phone Code",
      "Email me a sign-in link",
      "Passkey",
    ]);
    await expect(page.getByRole("radiogroup")).toHaveCount(0);
    await captureResponsiveEvidence({ page, testInfo, claimId: "sign-in-methods-desktop" });

    await page.getByLabel(/Email or phone/).fill("evidence@example.com");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("radio", { name: "Email me a sign-in link", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Email me a sign-in link", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("radiogroup").evaluate(async (group) => {
      await Promise.all(group.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    await expect(page.getByText("We'll email you a one-time link.", { exact: true })).toBeVisible();
    const emailButton = page.getByRole("button", { name: "Email me a sign-in link", exact: true });
    await expect(emailButton).toBeEnabled();
    await expect(emailButton.locator("svg.lucide-mail")).toBeVisible();
    await captureResponsiveEvidence({ page, testInfo, claimId: "sign-in-email-option-desktop" });
  });

  test("protected account routes preserve the requested return path @marketplace-account", async ({ page }) => {
    for (const route of protectedAccountRoutes) {
      await test.step(`open ${route.flow}`, async () => {
        await page.goto(route.path);
        await expect(page).toHaveURL(/\/sign-in/);

        const redirectedUrl = new URL(page.url());
        expect(redirectedUrl.searchParams.get("returnTo")).toBe(route.path);
        await expect(page.getByText(/^Sign in$/i).first()).toBeVisible();
      });
    }
  });

  test("signed-out checkout session access shows checkout recovery instead of root error @marketplace-checkout", async ({
    page,
  }) => {
    const response = await page.goto("/checkout/buy/session/chk_e2e_missing_access", {
      waitUntil: "domcontentloaded",
    });

    expect(response, "checkout recovery should return a page response").not.toBeNull();
    expect(response!.status(), "missing checkout access should not be a server error").toBe(401);
    await expect(page.getByRole("heading", { name: /^Checkout access required$/i })).toBeVisible();
    await expect(page.getByText("Your payment has not started.").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);
  });

  test("checkout recovery reentry follows a safe action instead of root error @marketplace-checkout", async ({
    page,
  }) => {
    const recoveryResponse = await page.goto("/checkout/buy/session/chk_e2e_missing_access", {
      waitUntil: "domcontentloaded",
    });

    expect(recoveryResponse, "checkout recovery should return a page response").not.toBeNull();
    expect(recoveryResponse!.status(), "expected checkout access recovery should not be a server error").toBe(401);
    await expect(page.getByRole("heading", { name: /^Checkout access required$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);

    const browseAction = page.getByRole("link", { name: /^Browse marketplace$/i });
    await expect(browseAction).toBeVisible();

    // The hydrated marketplace follows this link with client-side routing, so
    // the safe recovery contract must not depend on a full document request.
    await browseAction.click();

    await expect(page).toHaveURL(/\/search(?:$|\?)/);
    await expect(page.getByRole("searchbox").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Marketplace error$/i })).toHaveCount(0);
  });

  test("account can authenticate and review cart @marketplace-checkout", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    await authenticateAccount(page, testInfo);

    await expectAccountRouteReady(page, accountCriticalRoutes[0]);
    await expectAccountRouteReady(page, accountCriticalRoutes[2]);
  });

  test("seller add/remove receipt redirects keep Sell List and Desk current @marketplace-checkout", async ({
    page,
  }, testInfo) => {
    await authenticateAccount(page, testInfo);
    await expectPageOk(page, "/account/sell-list");
    await expect(page.getByText("Your Sell List is empty", { exact: true })).toBeVisible();
    const itemPath = marketplaceBrowserE2eSeedContract.itemDetail.selectedProductRoutePath;
    let lineId: string | null = null;
    const failures: unknown[] = [];
    const readLines = async () => {
      const response = await page.request.get("/api/marketplace/account/sell-list");
      expect(response.status(), "Sell List readback must succeed").toBe(200);
      const result: { items: Array<{ line_id: string }> } = await response.json();
      return result.items;
    };

    const submitAndFollow = async (path: string, fields: Record<string, string>, destination: string) => {
      const commandPromise = page.waitForResponse(
        (response) =>
          response.request().isNavigationRequest() &&
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === new URL(path, page.url()).pathname,
      );
      const documentPromise = page.waitForResponse((response) => {
        const request = response.request();
        if (!request.isNavigationRequest()) return false;
        const pathname = new URL(response.url()).pathname;
        return (
          (request.method() === "GET" && request.redirectedFrom()?.method() === "POST" && pathname === destination) ||
          (request.method() === "POST" && pathname === new URL(path, page.url()).pathname && response.status() !== 302)
        );
      });
      // Native document submission exposes the command and its followed redirect separately.
      await page.evaluate(
        ({ path, fields }) => {
          const form = document.createElement("form");
          form.method = "post";
          form.action = path;
          for (const [name, value] of Object.entries(fields)) {
            const input = document.createElement("input");
            input.type = "hidden";
            input.name = name;
            input.value = value;
            form.append(input);
          }
          document.body.append(form);
          form.submit();
        },
        { path, fields },
      );
      const [command, documentResponse] = await Promise.all([commandPromise, documentPromise]);
      expect(command.status(), "mutation command must redirect successfully").toBe(302);
      const location = new URL(command.headers().location, page.url());
      expect(location.pathname).toBe(destination);
      expect(
        location.searchParams.get("postWriteToken"),
        "the receipt-bearing redirect must not be stripped",
      ).toBeTruthy();
      expect(documentResponse, "redirect must return a document").not.toBeNull();
      expect(documentResponse!.status(), "receipt-bearing destination must succeed").toBe(200);
      expect(new URL(documentResponse!.url()).pathname).toBe(destination);
    };

    try {
      for (const destination of ["/account/sell-list", "/account/desk/offers"]) {
        await expectPageOk(page, itemPath);
        const productForm = page
          .locator('form:has(input[name="selectedOptions"]):has(input[name="productId"][value]:not([value=""]))')
          .first();
        const productId = await productForm.locator('input[name="productId"]').inputValue();
        const selectedOptions = await productForm.locator('input[name="selectedOptions"]').inputValue();
        const productSummary = await productForm.locator('input[name="productSummary"]').inputValue();
        await submitAndFollow(
          itemPath,
          {
            intent: "add-product-to-sell-list",
            productId,
            quantity: "1",
            selectedOptions,
            productSummary,
          },
          "/account/sell-list",
        );
        const productLines = await readLines();
        expect(productLines).toHaveLength(1);
        lineId = productLines[0].line_id;
        await expect(page.getByText("Your Sell List is empty", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Review items", exact: true })).toBeVisible();
        if (destination === "/account/desk/offers") {
          await expectPageOk(page, destination);
          expect(await readLines()).toEqual(productLines);
        }
        await submitAndFollow(destination, { intent: "remove-sell-list-line", lineId }, destination);
        lineId = null;
        await expect(page.getByText("Your Sell List is empty", { exact: true })).toBeVisible();
        expect(await readLines()).toEqual([]);
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      // Read back and remove only this journey's line, including after a failed destination.
      await expectPageOk(page, "/account/sell-list");
      const productLines = await readLines();
      if (lineId === null && productLines.length === 1) {
        lineId = productLines[0].line_id;
      }
      if (lineId !== null) {
        await submitAndFollow("/account/sell-list", { intent: "remove-sell-list-line", lineId }, "/account/sell-list");
      }
      await expect(page.getByText("Your Sell List is empty", { exact: true })).toBeVisible();
      expect(await readLines()).toEqual([]);
      await expectPageOk(page, "/account/desk/offers");
      await expect(page.getByText("Your Sell List is empty", { exact: true })).toBeVisible();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Sell List receipt journey or cleanup failed:\n${failures
          .map((error) => (error instanceof Error ? error.message : String(error)))
          .join("\n")}`,
      );
    }
  });

  test("signed-in presentation preferences persist across reloads and converge across sessions @marketplace-account", async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    const account = await authenticateAccount(page, testInfo);
    await expectAccountRouteReady(page, accountCriticalRoutes[0]);

    const colorTheme = await openAccountColorThemeControl(page);
    const preferencesResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/identity/preferences" && response.request().method() === "PUT";
    });
    await colorTheme
      .locator("label")
      .filter({ hasText: /^Dark$/ })
      .click();
    expect((await preferencesResponse).status()).toBe(200);
    await expect(colorTheme.locator('input[data-theme-choice="dark"]')).toBeChecked();

    await expect(page.locator('[data-color-mode="dark"]').first()).toBeVisible();
    await waitForPreferences(page, { colorMode: "dark" });

    const reducedMotionResponse = await page.request.put("/api/identity/preferences", {
      data: { reducedMotion: "always" },
    });
    expect(reducedMotionResponse.status()).toBe(200);
    await waitForPreferences(page, { colorMode: "dark", reducedMotion: "always" });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-color-mode="dark"]').first()).toBeVisible();
    await expect(page.locator('[data-reduced-motion="true"]').first()).toBeVisible();

    const firstPaintResponse = await page.request.get("/account/cart");
    expect(firstPaintResponse.status()).toBeLessThan(400);
    const firstPaintHtml = await firstPaintResponse.text();
    expectFirstPaintChaseRoot(firstPaintHtml, { colorMode: "dark", reducedMotion: "true" });

    const origin = new URL(page.url()).origin;
    const secondContext = await browser.newContext({ baseURL: origin });
    try {
      const secondPage = await secondContext.newPage();
      await signInWithPassword(secondPage, origin, account);
      await expectAccountRouteReady(secondPage, accountCriticalRoutes[0]);
      await expect(secondPage.locator('[data-color-mode="dark"]').first()).toBeVisible();
      await expect(secondPage.locator('[data-reduced-motion="true"]').first()).toBeVisible();
    } finally {
      await secondContext.close();
    }
  });

  test("seeded seller can reach critical marketplace commerce surfaces including repricing @marketplace-seller", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart");
    await signInWithPassword(page, new URL(page.url()).origin, marketplaceBrowserE2eSellerCredentials());
    await expectAccountRouteReady(page, accountCriticalRoutes[0]);

    for (const route of accountCriticalRoutes) {
      await test.step(`open ${route.flow}`, async () => {
        await expectAccountRouteReady(page, route);
      });
    }
  });
});
