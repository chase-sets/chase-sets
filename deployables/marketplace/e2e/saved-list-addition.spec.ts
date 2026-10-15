import { expect, test, type Page } from "@playwright/test";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eBuyerCredentials, marketplaceBrowserE2eSeedContract } from "./support/seed-contract";

const hosts = [
  {
    name: "Search",
    path: `/search?q=charizard&${marketplaceBrowserE2eSeedContract.itemDetail.selectedProductRoutePath.split("?")[1]}`,
  },
  { name: "Item Detail", path: marketplaceBrowserE2eSeedContract.itemDetail.routePath },
] as const;

async function openPicker(page: Page) {
  await page
    .getByRole("button", { name: /^Add Charizard .* to a Saved List$/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add to List", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Create a new Saved List/ })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(/Unexpected token|SyntaxError/)).toHaveCount(0);
  return dialog;
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
      await page
        .getByRole("button", { name: /^Add Charizard .* to a Saved List$/ })
        .first()
        .click();
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
  }
});
