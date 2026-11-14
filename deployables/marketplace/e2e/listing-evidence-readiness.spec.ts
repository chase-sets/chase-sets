import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { signInWithPassword } from "./support/auth";

const seller = {
  email: process.env.MARKETPLACE_E2E_SELLER_EMAIL?.trim() || "demo@chasesets.test",
  password: process.env.MARKETPLACE_E2E_SELLER_PASSWORD?.trim() || "demo1234",
};

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pullRequestIdentity() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  expect(eventPath, "GITHUB_EVENT_PATH must identify the pull_request event payload").toBeTruthy();
  const event = JSON.parse(readFileSync(eventPath!, "utf8")) as {
    merge_group?: unknown;
    number?: number;
    pull_request?: { number?: number; head?: { sha?: string } };
  };
  if (Object.hasOwn(event, "merge_group")) {
    expect(Object.hasOwn(event, "pull_request"), "merge_group event must not contain pull_request").toBe(false);
    expect(typeof event.merge_group, "merge_group event payload must be an object").toBe("object");
    expect(event.merge_group, "merge_group event payload must not be null").not.toBeNull();
    expect(Array.isArray(event.merge_group), "merge_group event payload must not be an array").toBe(false);
    return null;
  }
  const pr = event.pull_request?.number ?? event.number;
  const head = event.pull_request?.head?.sha;
  expect(pr, "pull request number must be present in the event payload").toBeGreaterThan(0);
  expect(head, "pull_request.head.sha must be a full commit identity").toMatch(/^[0-9a-f]{40}$/);
  return { pr: pr!, head: head! };
}

async function setAuthenticatedColorMode(page: import("@playwright/test").Page, mode: "light" | "dark") {
  const themeRoot = page.locator("[data-chase-theme]").first();
  await expect(themeRoot).toBeVisible();
  await expect(themeRoot).toHaveAttribute("data-chase-theme", "");
  await themeRoot.evaluate((element, nextMode) => element.setAttribute("data-color-mode", nextMode), mode);
  await expect(themeRoot).toHaveAttribute("data-color-mode", mode);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

test.describe("seller Listing Evidence readiness", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await signInWithPassword(page, new URL(page.url()).origin, seller);
  });

  test.describe("listing hydration smoke", () => {
    const routeKeys = new WeakMap<import("@playwright/test").Page, string>();
    const hydrationErrors = new WeakMap<import("@playwright/test").Page, string[]>();

    const retryActionAndEffect = async (actionAndEffect: () => Promise<void>) => {
      await expect(actionAndEffect).toPass({ timeout: 15_000, intervals: [250, 500, 1_000] });
    };

    const asyncHooksError = (error: string) =>
      /AsyncLocalStorage|node:async_hooks|externalized for browser compatibility/.test(error);

    const emitSmokeRecord = (page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo) => {
      const errors = hydrationErrors.get(page) ?? [];
      const firstErrors = errors.slice(0, 5).map((error) => error.slice(0, 300));
      console.log(
        `LISTING_HYDRATION_SMOKE ${JSON.stringify({
          routeKey: routeKeys.get(page) ?? "unknown",
          retry: testInfo.retry,
          status: testInfo.status,
          consoleErrorCount: errors.length,
          asyncHooksErrorCount: errors.filter(asyncHooksError).length,
          firstErrors,
        })}`,
      );
    };

    test.afterEach(async ({ page }, testInfo) => {
      emitSmokeRecord(page, testInfo);
      expect((hydrationErrors.get(page) ?? []).filter((error) => asyncHooksError(error))).toEqual([]);
      expect((hydrationErrors.get(page) ?? []).filter((error) => error.startsWith("Blocked business write:"))).toEqual(
        [],
      );
    });

    test.beforeEach(async ({ page }, testInfo) => {
      const errors: string[] = [];
      hydrationErrors.set(page, errors);
      routeKeys.set(
        page,
        testInfo.title.startsWith("Create listing")
          ? "create-listing"
          : testInfo.title.startsWith("seller detail")
            ? "seller-detail"
            : "seller-desk",
      );
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      // The smoke permits only reads and the existing read-only fee preview action.
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.continue();
        const pathname = new URL(request.url()).pathname;
        if (
          pathname === "/api/marketplace/account/listings/evidence-readiness/preview" ||
          (pathname === "/account/listings/new" && request.postData()?.includes("preview-listing"))
        ) {
          return route.continue();
        }
        errors.push(`Blocked business write: ${request.method()} ${pathname}`);
        await route.abort();
      });
    });

    test("Create listing catalog and fee preview respond @marketplace-seller @browser-e2e-seed", async ({ page }) => {
      await page.goto("/account/listings/new", { waitUntil: "domcontentloaded" });
      const catalog = page.getByRole("combobox", { name: "Search catalog" });
      await retryActionAndEffect(async () => {
        await catalog.fill("cat_seed_surging_sparks_booster_box");
        const option = page.getByRole("option", { name: /Surging Sparks Booster Box/ });
        await expect(option).toBeVisible();
        await option.click();
        await expect(catalog).toHaveValue("Surging Sparks Booster Box");
      });
      await page.getByLabel("Price", { exact: true }).fill("25.00");
      await page.getByLabel("Price currency code", { exact: true }).fill("USD");
      await page.getByRole("button", { name: "Preview fees", exact: true }).click();
      await expect(page.getByText("Listing fee preview", { exact: true })).toBeVisible();
    });

    test("seller detail withdraw dialog and evidence controls respond @marketplace-seller @browser-e2e-seed", async ({
      page,
    }) => {
      await page.goto("/account/listings/lst_seed_lugia_neo_genesis_draft", { waitUntil: "domcontentloaded" });
      await retryActionAndEffect(async () => {
        await page.getByRole("button", { name: "Withdraw listing", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Withdraw listing", exact: true })).toBeVisible();
      });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const evidence = page.getByLabel("Add seller-supplied evidence", { exact: true });
      const dropzone = page.locator("label").filter({ has: evidence });
      await retryActionAndEffect(async () => {
        await dropzone.dispatchEvent("dragenter");
        await expect(dropzone).toHaveClass(/border-accent/);
      });
      await dropzone.dispatchEvent("dragleave");
      await expect(dropzone).toHaveClass(/border-muted/);
    });

    test("Seller Desk Sell menu responds @marketplace-seller @browser-e2e-seed", async ({ page }) => {
      await page.goto("/account/desk", { waitUntil: "domcontentloaded" });
      const sell = page
        .getByRole("navigation", { name: "Primary navigation" })
        .getByRole("button", { name: "Sell", exact: true });
      await retryActionAndEffect(async () => {
        await sell.click();
        await expect(sell).toHaveAttribute("aria-expanded", "true");
      });
      const popup = page.locator(`[id="${await sell.getAttribute("aria-controls")}"]`);
      await expect(popup.getByRole("link", { name: "Inventory", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sell).toHaveAttribute("aria-expanded", "false");
    });
  });

  test("shows active compliance from server-owned slots @marketplace-seller @browser-e2e-seed", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/account/listings/lst_seed_charizard_base_set_psa_8", { waitUntil: "domcontentloaded" });

    const listingRoot = page
      .locator("main")
      .filter({ has: page.getByRole("heading", { name: "Charizard", exact: true }) });
    const assertListingEvidenceState = async () => {
      await expect(page).toHaveURL(/\/account\/listings\/lst_seed_charizard_base_set_psa_8$/);
      await expect(listingRoot).toBeVisible();
      await expect(listingRoot.getByRole("img").first()).toBeVisible();
      await expect(listingRoot.getByText("$749.00", { exact: true }).first()).toBeVisible();
      await expect(listingRoot.getByRole("heading", { name: "Listing readiness" })).toBeVisible();
      await expect(listingRoot.getByText("Evidence ready")).toBeVisible();
      await expect(listingRoot.getByText("Required view: front")).toBeVisible();
      await expect(listingRoot.getByText("Required view: back")).toBeVisible();
      await expect(listingRoot.getByText("Required view: slab")).toBeVisible();
      await expect(listingRoot.getByText("Seller-supplied evidence", { exact: true })).toBeVisible();
    };

    await assertListingEvidenceState();
    const identity = pullRequestIdentity();
    for (const [offset, theme] of ["light", "dark"].entries()) {
      await setAuthenticatedColorMode(page, theme as "light" | "dark");
      await assertListingEvidenceState();
      const imageName = `issue-6020-listing-evidence-${theme}.png`;
      const png = await page.screenshot({ fullPage: true });
      expect(png.length, `${imageName} must contain a bounded PNG payload`).toBeGreaterThan(8);
      expect(png.length, `${imageName} must stay within the 20 MiB evidence bound`).toBeLessThanOrEqual(
        20 * 1024 * 1024,
      );
      expect(
        png.subarray(0, pngSignature.length).equals(pngSignature),
        `${imageName} must have the PNG signature`,
      ).toBe(true);
      const pngSha256 = createHash("sha256").update(png).digest("hex");
      await testInfo.attach(imageName, { body: png, contentType: "image/png" });
      if (!identity) continue;
      console.log(
        `ISSUE_6020_HOSTED_EVIDENCE ${JSON.stringify({
          schemaVersion: "issue-6020-hosted-evidence/v1",
          entryIndex: offset + 1,
          entryCount: 4,
          pr: identity.pr,
          head: identity.head,
          suite: "marketplace_seller",
          spec: "deployables/marketplace/e2e/listing-evidence-readiness.spec.ts",
          state: "listing-evidence",
          theme,
          route: "/account/listings/lst_seed_charizard_base_set_psa_8",
          anchors: [
            "seeded-listing-root",
            "visible-listing-image",
            "price-$749.00",
            "evidence-ready",
            "listing-readiness",
          ],
          imageName,
          pngBytes: png.length,
          pngSha256,
        })}`,
      );
    }
  });

  test("keeps the draft path available with mobile camera capture @marketplace-seller @browser-e2e-seed", async ({
    page,
  }) => {
    await page.goto("/account/listings/lst_seed_lugia_neo_genesis_draft", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Listing readiness" })).toBeVisible();
    await expect(page.getByLabel("Add seller-supplied evidence")).toHaveAttribute("capture", "environment");
    await expect(page.getByRole("button", { name: "Upload evidence" })).toBeVisible();
  });
});
