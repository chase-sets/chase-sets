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
