import { expect, test } from "@playwright/test";
import { signInWithPassword } from "./support/auth";
import { marketplaceBrowserE2eBuyerCredentials, marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

const supportRequestPath = "/account/support/sup_seed_self_service_product_damaged";

test.describe("marketplace support case detail", () => {
  test("carries a damaged-item case from seller offer to buyer acceptance @marketplace-account", async ({
    browser,
  }) => {
    const sellerContext = await browser.newContext();
    const sellerPage = await sellerContext.newPage();
    await sellerPage.goto("/", { waitUntil: "domcontentloaded" });
    const origin = new URL(sellerPage.url()).origin;
    await signInWithPassword(sellerPage, origin, marketplaceBrowserE2eSellerCredentials());

    await sellerPage.goto(supportRequestPath, { waitUntil: "domcontentloaded" });
    await expect(sellerPage.getByRole("heading", { name: /^SUP-/ })).toBeVisible();
    await expect(sellerPage.getByText("Product arrived damaged")).toBeVisible();
    await expect(sellerPage.getByText("You need to act")).toBeVisible();
    await sellerPage.getByLabel("Response").selectOption("offer-partial-refund");
    await sellerPage.getByLabel("Partial refund amount").fill("5.00");
    await sellerPage.getByLabel("Response summary").fill("Keep the item and receive a partial refund.");
    await sellerPage.getByRole("button", { name: "Send response" }).click();
    await expect(sellerPage).toHaveURL(/action=response/);
    await expect(sellerPage.getByText("Response sent.")).toBeVisible();

    const buyerContext = await browser.newContext();
    const buyerPage = await buyerContext.newPage();
    await buyerPage.goto(origin, { waitUntil: "domcontentloaded" });
    await signInWithPassword(buyerPage, origin, marketplaceBrowserE2eBuyerCredentials());
    await buyerPage.goto(supportRequestPath, { waitUntil: "domcontentloaded" });
    await expect(buyerPage.getByRole("heading", { name: "Review the offer" })).toBeVisible();
    await expect(buyerPage.getByText("$5.00")).toBeVisible();
    await buyerPage.getByRole("button", { name: "Accept offer" }).click();
    await expect(buyerPage).toHaveURL(/action=offerAccepted/);
    await expect(buyerPage.getByText("Offer accepted.")).toBeVisible();
    await expect(buyerPage.getByText("Current status: Resolved")).toBeVisible();
    await expect(buyerPage.getByText("Resolution", { exact: true })).toBeVisible();

    await sellerPage.reload({ waitUntil: "domcontentloaded" });
    await expect(sellerPage.getByText("Current status: Resolved")).toBeVisible();
    await expect(sellerPage.getByRole("button", { name: "Send response" })).toHaveCount(0);

    await buyerContext.close();
    await sellerContext.close();
  });
});
