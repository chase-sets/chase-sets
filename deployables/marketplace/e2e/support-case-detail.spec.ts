import { expect, test } from "@playwright/test";
import { signInWithPassword } from "./support/auth";
import { marketplaceBrowserE2eBuyerCredentials, marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

const supportRequestId = "sup_seed_self_service_product_damaged";
const supportRequestPath = `/account/support/${supportRequestId}`;

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
    await expect(sellerPage.getByRole("heading", { name: supportRequestId })).toBeVisible();
    await expect(sellerPage.getByText("Product arrived damaged")).toBeVisible();
    const responseSelect = sellerPage.getByLabel("Response", { exact: true });
    const sellerStatus = await sellerPage.getByText(/^Current status:/).textContent();
    if (sellerStatus === "Current status: Waiting on seller") {
      await expect(sellerPage.getByText("You need to act")).toBeVisible();
      const partialRefundAmount = sellerPage.getByLabel("Partial refund amount");
      await expect(async () => {
        await responseSelect.selectOption("offer-partial-refund");
        await expect(partialRefundAmount).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
      await partialRefundAmount.fill("5.00");
      await sellerPage.getByLabel("Response summary").fill("Keep the item and receive a partial refund.");
      await sellerPage.getByRole("button", { name: "Send response" }).click();
      await expect(sellerPage).toHaveURL(/action=response/);
      await expect(sellerPage.getByText("Response sent.")).toBeVisible();
    } else {
      expect(sellerStatus).toMatch(/^Current status: (Waiting on buyer|Resolved)$/);
    }

    const buyerContext = await browser.newContext();
    const buyerPage = await buyerContext.newPage();
    await buyerPage.goto(origin, { waitUntil: "domcontentloaded" });
    await signInWithPassword(buyerPage, origin, marketplaceBrowserE2eBuyerCredentials());
    await buyerPage.goto(supportRequestPath, { waitUntil: "domcontentloaded" });
    const reviewOfferHeading = buyerPage.getByRole("heading", { name: "Review the offer" });
    await expect(async () => {
      await buyerPage.reload({ waitUntil: "domcontentloaded" });
      const canReviewOffer = await reviewOfferHeading.isVisible();
      const isResolved = await buyerPage.getByText("Current status: Resolved").isVisible();
      expect(canReviewOffer || isResolved).toBe(true);
    }).toPass({ timeout: 20_000 });
    if (await reviewOfferHeading.isVisible()) {
      await expect(buyerPage.getByText("$5.00")).toBeVisible();
      await buyerPage.getByRole("button", { name: "Accept offer" }).click();
      await expect(buyerPage).toHaveURL(/action=offerAccepted/);
      await expect(buyerPage.getByText("Offer accepted.")).toBeVisible();
    }
    await expect(buyerPage.getByText("Current status: Resolved")).toBeVisible();
    await expect(buyerPage.getByText("Resolution", { exact: true })).toBeVisible();

    await expect(async () => {
      await sellerPage.reload({ waitUntil: "domcontentloaded" });
      await expect(sellerPage.getByText("Current status: Resolved")).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await expect(sellerPage.getByRole("button", { name: "Send response" })).toHaveCount(0);

    await buyerContext.close();
    await sellerContext.close();
  });
});
