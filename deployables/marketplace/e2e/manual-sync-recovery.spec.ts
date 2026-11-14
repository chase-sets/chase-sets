import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { createManualSyncBrowserRecovery } from "./support/manual-sync-recovery";
import type { MarketplaceListingDetail } from "@chase-sets/marketplace/server";
import {
  appendFreshWriteToken,
  attachResponseMetadata,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  classifyFreshWriteReadError,
  encodeFreshWriteReceipt,
  readFreshWriteToken,
} from "@chase-sets/http/responses";
import { signInThroughMarketplaceForm } from "./support/auth";
import { hasIdentifierSubmitHandler } from "./support/sign-in-readiness";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

test.describe("manual TCGplayer clamp recovery", () => {
  test("drives recovery, retry, download, and release on the real account route @marketplace-account @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    let fixtureCreated = false;
    let released = false;
    let routePath: string | undefined;
    let listingId: string | undefined;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/sign-in?returnTo=%2Faccount%2Fchannels", { waitUntil: "domcontentloaded" });
    await signInThroughMarketplaceForm(page, marketplaceBrowserE2eSellerCredentials());

    await withOwnedRecoveryCleanup(
      async () => {
        const createdAfter = new Date().toISOString();
        await hydratedChannelForm(page);
        await page.getByRole("combobox", { name: "Sales Channel", exact: true }).selectOption("tcgplayer");
        await page.getByRole("button", { name: "Connect a channel", exact: true }).click();
        await expect(page).toHaveURL(/\/account\/channels\/chn_[^/?]+(?:\?|$)/);
        routePath = new URL(page.url()).pathname;
        const location = page.getByRole("group", { name: "Storage locations" }).getByRole("checkbox").first();
        const locationId = await location.getAttribute("id");
        await page.locator(`label[for="${locationId}"]`).click();
        await expect(location).toBeChecked();
        const storageLocationId = await location.inputValue();
        const activate = page.getByRole("button", { name: "Activate", exact: true });
        await expect(activate).toBeEnabled();
        await activate.click();
        await expect(page.getByText("Active", { exact: true })).toBeVisible();
        const owned = await recoveryListing(page, storageLocationId, (id) => {
          listingId = id;
        });
        listingId = owned.listingId;
        const fixture = await createManualSyncBrowserRecovery(
          {
            ...owned,
            ownershipId: randomUUID(),
            createdAfter,
            connectionId: routePath.split("/").at(-1)!,
          },
          testInfo.config.metadata,
        );
        fixtureCreated = true;
        await page.goto(routePath, { waitUntil: "domcontentloaded" });
        await expect(page).toHaveURL(new RegExp(`${routePath.replaceAll("/", "\\/")}(?:\\?|$)`));
        await expect(page.getByRole("heading", { name: /^Manual TCGplayer sync$/i })).toBeVisible();
        const retryButton = page.getByRole("button", { name: /^Retry inbound clamp$/i });
        const releaseButton = page.getByRole("button", { name: /^Release before submission$/i });
        await expect(page.getByText(/^Inbound clamp recovery needs review$/i)).toBeVisible();
        await expect(retryButton).toBeVisible();
        await expect(page.getByText(/^Ready to download$/i)).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Clamp and download CSV$/i })).toHaveCount(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          "the recovery panel must fit the 390px account viewport",
        ).toBe(true);

        await retryButton.click();
        await expect(page.getByText(/^Ready to download$/i)).toBeVisible();
        await expect(page.getByText(/^Inbound clamp recovery needs review$/i)).toHaveCount(0);
        const downloadButton = page.getByRole("button", { name: /^Clamp and download CSV$/i });
        await expect(downloadButton).toBeVisible();

        const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
        expect(download.suggestedFilename()).toBe(`tcgplayer-staged-${fixture.runId}.csv`);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByText(/^Claimed$/i)).toBeVisible();
        await expect(page.getByRole("button", { name: /^Release before submission$/i })).toBeVisible();

        await page.getByRole("button", { name: /^Release before submission$/i }).click();
        await expect(page.getByText(/^Abandoned$/i)).toBeVisible();
        released = true;
        const panel = page.getByTestId("manual-sync-panel");
        await expect(panel.getByRole("button", { name: /^Compose Staged batch$/i })).toBeVisible();
        await expect(panel.getByRole("button", { name: /^Ingest Live export$/i })).toBeVisible();
        await expect(panel.getByRole("button", { name: /^Ingest Staged export$/i })).toBeVisible();
        await expect(panel.getByLabel("TCGplayer Live export", { exact: true })).toBeAttached();
        await expect(panel.getByLabel("TCGplayer Staged export", { exact: true })).toBeAttached();
        await expect(panel.getByTestId("manual-sync-lease-facts")).toContainText("Lease expires");
        await expect(panel.getByText(/^Lease remaining$/i)).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Clamp and download CSV$/i })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Release before submission$/i })).toHaveCount(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          "the released panel must fit the 390px account viewport",
        ).toBe(true);
        const panelBox = await panel.boundingBox();
        expect(panelBox, "the released panel must render a measurable box").not.toBeNull();
        expect(panelBox!.x).toBeGreaterThanOrEqual(0);
        expect(panelBox!.x + panelBox!.width, "the released panel must end inside 390px").toBeLessThanOrEqual(390);
        await panel.screenshot({ path: testInfo.outputPath("manual-sync-abandoned-390.png") });
      },
      [
        async () => {
          if (fixtureCreated && !released && routePath) {
            await page.goto(routePath, { waitUntil: "domcontentloaded" });
            const retry = page.getByRole("button", { name: /^Retry inbound clamp$/i });
            if (await retry.isVisible()) await retry.click();
            const download = page.getByRole("button", { name: /^Clamp and download CSV$/i });
            if (await download.isVisible()) await Promise.all([page.waitForEvent("download"), download.click()]);
            await page.getByRole("button", { name: /^Release before submission$/i }).click();
            await expect(page.getByText(/^Abandoned$/i)).toBeVisible();
          }
        },
        async () => {
          if (listingId) {
            const response = await page.request.post(`/api/marketplace/account/listings/${listingId}/withdraw`, {
              data: { idempotencyKey: `e2e_withdraw_${randomUUID().replaceAll("-", "")}` },
            });
            expect(response.ok(), "owned recovery Listing cleanup must succeed").toBe(true);
          }
        },
        async () => {
          if (routePath) {
            const response = await page.request.post(
              `/api/channels/connections/${routePath.split("/").at(-1)}/disconnect`,
            );
            expect(response.ok(), "owned recovery connection cleanup must succeed").toBe(true);
          }
        },
      ],
      (count) => {
        testInfo.annotations.push({ type: "owned-recovery-cleanup-failed", description: String(count) });
      },
    );
  });
});

async function withOwnedRecoveryCleanup(
  run: () => Promise<void>,
  cleanups: readonly (() => Promise<void>)[],
  record: (count: number) => void,
) {
  let failed = false;
  let primary: unknown;
  try {
    await run();
  } catch (error) {
    failed = true;
    primary = error;
  }
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    try {
      record(failures.length);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failed) throw primary;
  if (failures.length) throw new AggregateError(failures, "owned-recovery-cleanup-failed");
}

async function hydratedChannelForm(page: Page) {
  const form = page.locator("form").filter({ has: page.getByRole("combobox", { name: "Sales Channel", exact: true }) });
  await expect.poll(() => form.evaluate(hasIdentifierSubmitHandler)).toBe(true);
  const loaded = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/account/channels.data",
  );
  await page.locator('main a[href="/account/channels?status=active"]').click();
  await loaded;
  await expect(page).toHaveURL(/\/account\/channels\?status=active$/);
  const returned = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/account/channels.data",
  );
  await page.locator('main a[href="/account/channels"]').click();
  await returned;
  await expect(page).toHaveURL(/\/account\/channels$/);
  await expect(page.getByRole("combobox", { name: "Sales Channel", exact: true })).toBeVisible();
}

async function readFreshListing<Result>(
  page: Page,
  path: string,
  source: unknown,
  accepts: (result: Result) => boolean,
) {
  const request = appendFreshWriteToken(new URL(path, page.url()).href, source);
  const receipt = readFreshWriteToken(request);
  expect(receipt, "owned recovery requires the command receipt").not.toBeNull();
  const headers = {
    [CHASE_SETS_READ_AFTER_WRITE_HEADER]: encodeFreshWriteReceipt(receipt!),
    [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "marketplace",
  };
  let result: Result | undefined;
  let failed = false;
  let failure: unknown;
  await expect
    .poll(async () => {
      try {
        const response = await page.request.get(request, { headers });
        if (!response.ok()) {
          const body: unknown = await response.json().catch(() => null);
          const { kind, status, errorCode } = classifyFreshWriteReadError({
            request,
            error: response,
            getStatus: () => response.status(),
            getBody: () => body,
          });
          if (kind === "transient-projection-timeout") return false;
          throw new Error(`Owned recovery fresh read rejected: ${kind}/${status}/${errorCode}`);
        }
        const value = await responseJson<Result>(response);
        if (!accepts(value)) throw new Error("owned-recovery-listing-read-mismatch");
        result = value;
        return true;
      } catch (error) {
        failed = true;
        failure = error;
        return true;
      }
    })
    .toBe(true);
  if (failed) throw failure;
  return result!;
}

async function responseJson<Result>(response: APIResponse): Promise<Result> {
  expect(response.ok()).toBe(true);
  return attachResponseMetadata(await response.json(), { headers: new Headers(response.headers()) });
}

async function recoveryListing(page: Page, storageLocationId: string, created: (id: string) => void) {
  const itemResponse = await page.request.post("/api/inventory/items", {
    headers: { "Inventory-Mutation-Attempt": randomUUID() },
    data: {
      catalogItemId: catalogSeedIds.items.onePieceRomanceDawnBoosterBox,
      selectedOptions: [],
      storageLocationId,
      totalQuantity: 2,
    },
  });
  expect(itemResponse.ok()).toBe(true);
  const item = await responseJson<{ id: string }>(itemResponse);
  await readFreshListing<{ items: readonly { item_id: string }[] }>(
    page,
    `/api/marketplace/account/listing-inventory?inventoryItemId=${item.id}`,
    item,
    (supply) => supply.items.some((candidate) => candidate.item_id === item.id),
  );
  const createdResponse = await page.request.post("/api/marketplace/account/listings", {
    data: {
      idempotencyKey: `e2e_create_${randomUUID().replaceAll("-", "")}`,
      inventoryItemId: item.id,
      priceAmount: "5.00",
      priceCurrencyCode: "USD",
      quantityCap: 1,
    },
  });
  expect(createdResponse.ok()).toBe(true);
  const listing = await responseJson<{ id: string; feeQuoteFingerprint: string }>(createdResponse);
  created(listing.id);
  const listingPath = `/api/marketplace/account/listings/${listing.id}`;
  const ownedListing = (value: MarketplaceListingDetail) =>
    value.listing_id === listing.id && value.inventory_item_id === item.id;
  const detail = await readFreshListing<MarketplaceListingDetail>(page, listingPath, listing, ownedListing);
  const requirements = detail.evidence_readiness.requirements;
  for (let index = 0; index < Math.max(requirements.minimumPhotoCount, requirements.requiredSlots.length); index++) {
    const slot = requirements.requiredSlots[index];
    const buffer = await sharp({
      create: {
        width: Math.max(1200, slot?.minimumWidthPixels ?? 0),
        height: Math.max(1200, slot?.minimumHeightPixels ?? 0),
        channels: 3,
        background: { r: 40, g: 90, b: 140 },
      },
    })
      .png()
      .toBuffer();
    const name = `owned-recovery-${index}.png`;
    const upload = await page.request.post(`${listingPath}/photos`, {
      multipart: {
        evidence: { name, mimeType: "image/png", buffer },
        listingPhotoAltText: "Owned recovery fixture photo",
      },
    });
    expect(upload.ok()).toBe(true);
    const updated = await readFreshListing<MarketplaceListingDetail>(
      page,
      listingPath,
      await responseJson(upload),
      ownedListing,
    );
    const photo = updated.evidence.find((entry) => entry.originalFilename === name);
    expect(photo).toBeDefined();
    const classified = await page.request.post(`${listingPath}/photos/${photo!.photoId}/classify`, {
      data: {
        slotId: slot?.slotId ?? null,
        viewKind: slot?.viewKind ?? null,
        altText: "Owned recovery fixture photo",
        capturedAt: new Date().toISOString(),
      },
    });
    expect(classified.ok()).toBe(true);
  }
  const published = await page.request.post(`${listingPath}/publish`, {
    data: {
      idempotencyKey: `e2e_publish_${randomUUID().replaceAll("-", "")}`,
      feeQuoteFingerprint: listing.feeQuoteFingerprint,
    },
  });
  expect(published.ok()).toBe(true);
  return { listingId: listing.id, inventoryItemId: item.id };
}
