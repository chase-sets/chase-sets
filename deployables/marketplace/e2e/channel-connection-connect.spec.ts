import { expect, test, type APIResponse, type Page } from "@playwright/test";
import sharp from "sharp";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { MarketplaceListingDetail } from "@chase-sets/marketplace/server";
import {
  appendFreshWriteToken,
  attachResponseMetadata,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
  readFreshWriteToken,
} from "@chase-sets/http/responses";
import { signInThroughMarketplaceForm } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

let pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
});
test.afterEach(async ({}, testInfo) => {
  await testInfo.attach("channel-connect-browser-errors", {
    body: JSON.stringify(pageErrors),
    contentType: "application/json",
  });
});

test("manual-sync-panel-round-trip: connects and activates an independent real channel @marketplace-account @browser-e2e-seed", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sign-in?returnTo=%2Faccount%2Fchannels", { waitUntil: "domcontentloaded" });
  await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSellerCredentials());
  await expect(page).toHaveURL(/\/account\/channels(?:\?|$)/);
  await expect(page.getByRole("button", { name: "Connect a channel", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("channels-connect-list-390.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath("channels-connect-list-1440.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "Sales Channel", exact: true }).selectOption("tcgplayer");
  await page.getByRole("button", { name: "Connect a channel", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/channels\/chn_[^/?]+(?:\?|$)/);
  const firstPath = new URL(page.url()).pathname;
  await expect(page.getByText("Pending setup", { exact: true })).toBeVisible();
  const activate = page.getByRole("button", { name: "Activate", exact: true });
  await expect(activate).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("channels-connect-setup-empty-selection-390.png"),
    fullPage: true,
  });
  const locations = page.getByRole("group", { name: "Storage locations" }).getByRole("checkbox");
  expect(await locations.count(), "the seeded seller must have an active Inventory storage location").toBeGreaterThan(
    0,
  );
  const locationControlId = await locations.first().getAttribute("id");
  await page.locator(`label[for="${locationControlId}"]`).click();
  await expect(locations.first()).toBeChecked();
  const storageLocationId = await locations.first().inputValue();
  await expect(activate).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("channels-connect-design-system-390.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath("channels-connect-setup-1440.png"), fullPage: true });
  await activate.click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Manual TCGplayer sync", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("channels-connect-design-system-desktop.png"), fullPage: true });
  await page.goto("/account/channels");
  await page.getByRole("button", { name: "Connect a channel", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/channels\/chn_[^/?]+(?:\?|$)/);
  expect(new URL(page.url()).pathname).not.toBe(firstPath);
  await expect(page.getByText("Pending setup", { exact: true })).toBeVisible();

  await publishTwoSellerListings(page, storageLocationId);
  await page.goto(firstPath.replace("/channels/", "/channels/publication/"));
  await page.getByLabel("Allowed category IDs, one per line").fill(catalogSeedIds.categories.onePieceCardGame);
  const configurationVersion = await page.locator('input[name="expectedStreamVersion"]').first().inputValue();
  await page.getByRole("button", { name: "Save publication settings", exact: true }).click();
  await expect
    .poll(
      async () =>
        Number(
          await page.evaluate(
            () => document.querySelector<HTMLInputElement>('input[name="expectedStreamVersion"]')?.value ?? "-1",
          ),
        ),
      { message: "the saved publication settings must become readable on the seller surface", timeout: 60_000 },
    )
    .toBeGreaterThan(Number(configurationVersion));
  await expect(page.getByText("Settings are required", { exact: true })).toHaveCount(0);
  await expect
    .poll(
      async () => {
        await page.goto(firstPath);
        return page.locator('[data-channels-outbound-operation-log="true"] tbody tr').count();
      },
      { message: "the publication pipeline must queue both published seller listings", timeout: 60_000 },
    )
    .toBe(2);
  const panel = page.getByTestId("manual-sync-panel");
  await expect(panel).toBeVisible({ timeout: 45_000 });
  await panel.getByLabel("TCGplayer Staged export", { exact: true }).setInputFiles({
    name: "two-seller-listings.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "TCGplayer Id,Total Quantity,Add to Quantity,TCG Marketplace Price\n987650,0,0,1.00\n987660,0,0,1.00\n",
    ),
  });
  const ingested = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname.startsWith(firstPath),
  );
  await panel.getByRole("button", { name: "Ingest Staged export", exact: true }).click();
  expect((await ingested).status(), "the staged export ingest must be accepted").toBeLessThan(400);
  await page.goto(firstPath);
  await expect(panel).toBeVisible({ timeout: 45_000 });
  await panel.getByRole("button", { name: "Compose Staged batch", exact: true }).click();
  await expect(panel.getByText("Ready to download", { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(panel.getByText("Composed listings", { exact: true }).locator("../..")).toContainText("2");
  await page.screenshot({ path: testInfo.outputPath("channels-connect-composed-1440.png"), fullPage: true });
});

async function successfulJson<Result = unknown>(response: APIResponse): Promise<Result> {
  expect(response.ok(), `${response.url()}: ${await response.text()}`).toBe(true);
  expect(response.headers()["content-type"]).toContain("application/json");
  return attachResponseMetadata(await response.json(), { headers: new Headers(response.headers()) });
}

function marketplaceFreshReadHeaders(source: unknown) {
  const receipt = readFreshWriteToken(appendFreshWriteToken("http://localhost/", source));
  expect(receipt, "seller preparation must retain the real command commit receipt").not.toBeNull();
  return {
    [CHASE_SETS_READ_AFTER_WRITE_HEADER]: encodeFreshWriteReceipt(receipt!),
    [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "marketplace",
  };
}

async function publishTwoSellerListings(page: Page, storageLocationId: string) {
  const selections = [
    {
      catalogItemId: catalogSeedIds.items.onePieceLuffyRomanceDawn,
      selectedOptions: [
        {
          dimensionId: catalogSeedIds.dimensions.form.dimensionId,
          optionId: catalogSeedIds.dimensions.form.optionIds.raw,
        },
        {
          dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
          optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
        },
      ],
    },
    { catalogItemId: catalogSeedIds.items.onePieceRomanceDawnBoosterBox, selectedOptions: [] },
  ];
  for (const selection of selections) {
    const item = await successfulJson<{ id: string }>(
      await page.request.post("/api/inventory/items", {
        data: { ...selection, storageLocationId, totalQuantity: 4 },
      }),
    );
    await expect
      .poll(async () => {
        const supply = await successfulJson<{ items: readonly { item_id: string }[] }>(
          await page.request.get(`/api/marketplace/account/listing-inventory?inventoryItemId=${item.id}`, {
            headers: marketplaceFreshReadHeaders(item),
          }),
        );
        return supply.items.some((candidate) => candidate.item_id === item.id);
      })
      .toBe(true);
    const listing = await successfulJson<{ id: string; feeQuoteFingerprint: string }>(
      await page.request.post("/api/marketplace/account/listings", {
        data: { inventoryItemId: item.id, priceAmount: "5.00", priceCurrencyCode: "USD", quantityCap: 2 },
      }),
    );
    const path = `/api/marketplace/account/listings/${listing.id}`;
    const detail = await successfulJson<MarketplaceListingDetail>(
      await page.request.get(path, { headers: marketplaceFreshReadHeaders(listing) }),
    );
    const requirements = detail.evidence_readiness.requirements;
    const count = Math.max(requirements.minimumPhotoCount, requirements.requiredSlots.length);
    for (let index = 0; index < count; index += 1) {
      const slot = requirements.requiredSlots[index];
      const image = await sharp({
        create: {
          width: Math.max(1200, slot?.minimumWidthPixels ?? 0),
          height: Math.max(1200, slot?.minimumHeightPixels ?? 0),
          channels: 3,
          background: { r: 40 + index * 20, g: 90, b: 140 },
        },
      })
        .png()
        .toBuffer();
      const uploaded = await successfulJson(
        await page.request.post(`${path}/photos`, {
          multipart: {
            evidence: { name: `seller-evidence-${index}.png`, mimeType: "image/png", buffer: image },
            listingPhotoAltText: `Browser fixture seller photo ${index + 1}`,
          },
        }),
      );
      const withPhoto = await successfulJson<MarketplaceListingDetail>(
        await page.request.get(path, { headers: marketplaceFreshReadHeaders(uploaded) }),
      );
      const photo = withPhoto.evidence.find(
        (candidate) => candidate.originalFilename === `seller-evidence-${index}.png`,
      );
      expect(photo).toBeDefined();
      await successfulJson(
        await page.request.post(`${path}/photos/${photo!.photoId}/classify`, {
          data: {
            slotId: slot?.slotId ?? null,
            viewKind: slot?.viewKind ?? null,
            altText: `Browser fixture seller photo ${index + 1}`,
            capturedAt: new Date().toISOString(),
          },
        }),
      );
    }
    await successfulJson(
      await page.request.post(`${path}/publish`, {
        data: { feeQuoteFingerprint: listing.feeQuoteFingerprint },
      }),
    );
  }
}
