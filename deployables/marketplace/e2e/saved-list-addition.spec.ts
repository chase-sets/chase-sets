import { expect, test, type Page, type Route } from "@playwright/test";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eBuyerCredentials, marketplaceBrowserE2eSeedContract } from "./support/seed-contract";

const hosts = [
  {
    name: "Search",
    path: `/search?q=charizard&${marketplaceBrowserE2eSeedContract.itemDetail.selectedProductRoutePath.split("?")[1]}`,
  },
  { name: "Item Detail", path: marketplaceBrowserE2eSeedContract.itemDetail.routePath },
] as const;
const itemDetailHost = hosts[1];

// Synthetic single-fetch wire faults: a network rejection, an undecodable body,
// and an error status without the X-Remix-Response marker of a real route error.
const wireFaults = [
  { name: "connection reset", apply: (route: Route) => route.abort("connectionreset") },
  {
    name: "undecodable response",
    apply: (route: Route) =>
      route.fulfill({ status: 200, contentType: "text/x-script", body: "SYNTHETIC_DECODE_5623" }),
  },
  {
    name: "502 without X-Remix-Response",
    apply: (route: Route) => route.fulfill({ status: 502, contentType: "text/plain", body: "SYNTHETIC_502_5623" }),
  },
] as const;
const technicalText = /Failed to fetch|NetworkError|Unable to decode|Bad Gateway|TypeError|SYNTHETIC_/;

// Add to List is a client-only fetcher control: a click that lands before
// hydration attaches its handler is a no-op, so wait for the hydrated element.
async function clickHydratedAddToList(page: Page) {
  const button = page.getByRole("button", { name: /^Add Charizard .* to a Saved List$/ }).first();
  await expect
    .poll(() => button.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps$"))))
    .toBe(true);
  await button.click();
}

async function openPicker(page: Page) {
  await clickHydratedAddToList(page);
  const dialog = page.getByRole("dialog", { name: "Add to List", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Create a new Saved List/ })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(/Unexpected token|SyntaxError/)).toHaveCount(0);
  return dialog;
}

// Faults only POST route-data requests carrying the intent; every other request,
// including GET revalidation, continues. Returns the faulted request paths.
async function faultIntentPosts(page: Page, intent: string, fault: (route: Route) => Promise<void>) {
  const faulted: string[] = [];
  await page.route(
    (url) => url.pathname.endsWith(".data"),
    async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.postData()?.includes(intent)) return route.continue();
      faulted.push(new URL(request.url()).pathname);
      await fault(route);
    },
  );
  return faulted;
}

async function expectLocalizedRootError(page: Page) {
  await expect(page.getByRole("heading", { name: "Marketplace error", exact: true })).toBeVisible();
  await expect(page.getByText("Something went wrong. Please try again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse marketplace" })).toHaveAttribute("href", "/search");
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(technicalText);
}

function hostDataPath(path: string) {
  return `${new URL(path, "https://marketplace.invalid").pathname}.data`;
}

test.describe("marketplace Add to List route data", () => {
  for (const host of hosts) {
    test(`${host.name} opens recent Lists and commits a new List @marketplace-browse`, async ({ page }, testInfo) => {
      await page.goto(`/sign-in?returnTo=${encodeURIComponent(host.path)}`, { waitUntil: "domcontentloaded" });
      await signInThroughMarketplaceForm(page, marketplaceBrowserE2eBuyerCredentials());
      await expect(page).toHaveURL(new URL(host.path, page.url()).href);

      const dialog = await openPicker(page);
      const title = `Saved List ${testInfo.testId} ${Date.now()}`;
      await dialog.getByRole("radio", { name: /Create a new Saved List/ }).click();
      await dialog.getByRole("textbox", { name: "New Saved List title" }).fill(title);
      await dialog.getByRole("button", { name: "Add Product", exact: true }).click();
      const success = page.getByRole("dialog", { name: `Added to ${title}`, exact: true });
      await expect(success).toBeVisible();
      await expect(success.getByRole("status")).toContainText(`Added to ${title}`);
      await expect(success.getByRole("link", { name: "View in My Collection" })).toHaveAttribute(
        "href",
        /section=lists/,
      );
      await expect(success.getByRole("alert")).toHaveCount(0);
      await success.getByRole("button", { name: "Cancel", exact: true }).click();

      const reopened = await openPicker(page);
      await expect(reopened.getByRole("radio", { name: new RegExp(title) })).toBeVisible();
      await expect(page).toHaveURL(new URL(host.path, page.url()).href);
    });

    test(`${host.name} anonymous preparation preserves the owner cookie and registration return path @marketplace-browse`, async ({
      page,
      context,
    }) => {
      await page.goto(host.path, { waitUntil: "domcontentloaded" });
      await clickHydratedAddToList(page);
      await expect(page).toHaveURL(/\/register\?returnTo=/);
      const registration = new URL(page.url());
      expect(registration.pathname).toBe("/register");
      const returnTo = new URL(registration.searchParams.get("returnTo")!, registration.origin);
      const source = new URL(host.path, registration.origin);
      expect(returnTo.pathname).toBe(source.pathname);
      expect(returnTo.pathname).not.toContain(".data");
      expect(returnTo.searchParams.get("claimSavedListIntent")).toBeTruthy();
      returnTo.searchParams.delete("claimSavedListIntent");
      expect(returnTo.search).toBe(source.search);
      const owner = (await context.cookies()).find((cookie) => cookie.name === "chase_sets_anonymous_saved_lists");
      expect(owner?.value).toMatch(/^anon_/);
      expect(owner?.httpOnly).toBe(true);
    });

    for (const fault of wireFaults) {
      test(`${host.name} preparation ${fault.name} shows localized root copy, not technical text @marketplace-browse`, async ({
        page,
      }) => {
        await page.goto(host.path, { waitUntil: "domcontentloaded" });
        const faulted = await faultIntentPosts(page, "prepare-saved-list", fault.apply);
        await clickHydratedAddToList(page);
        await expectLocalizedRootError(page);
        expect(faulted).toEqual([hostDataPath(host.path)]);
      });
    }
  }

  test("Item Detail aborted commit shows localized root copy, not technical text @marketplace-browse", async ({
    page,
  }, testInfo) => {
    await page.goto(`/sign-in?returnTo=${encodeURIComponent(itemDetailHost.path)}`, { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eBuyerCredentials());
    await expect(page).toHaveURL(new URL(itemDetailHost.path, page.url()).href);

    const faulted = await faultIntentPosts(page, "commit-saved-list", (route) => route.abort("connectionreset"));
    const dialog = await openPicker(page);
    await dialog.getByRole("radio", { name: /Create a new Saved List/ }).click();
    await dialog
      .getByRole("textbox", { name: "New Saved List title" })
      .fill(`Saved List ${testInfo.testId} ${Date.now()}`);
    await dialog.getByRole("button", { name: "Add Product", exact: true }).click();
    await expectLocalizedRootError(page);
    expect(faulted).toEqual([hostDataPath(itemDetailHost.path)]);
  });
});
