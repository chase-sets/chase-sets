import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { captureAccessibilityEvidence } from "@chase-sets/playwright-evidence";
import { signInWithPassword } from "./support/auth";
import { marketplaceBrowserE2eSellerCredentials } from "./support/seed-contract";

test.describe("@marketplace-seller issue-7169-c1-boundary-recovery AC9/10/11/13", () => {
  test("real location action loses its response, restores privately and never posts again", async ({
    page,
  }, testInfo) => {
    await signInWithPassword(page, String(testInfo.project.use.baseURL), marketplaceBrowserE2eSellerCredentials());
    await page.goto("/account/inventory/locations");
    const form = page.locator("form").filter({ has: page.locator('input[name="intent"][value="create-location"]') });
    await expect(form.getByRole("button", { name: "Create location", exact: true })).toBeEnabled();
    const name = `C1 recovery ${randomUUID()}`;
    for (const [field, value] of Object.entries({
      name,
      shipFromCode: name,
      shipFromName: "Synthetic C1",
      shipFromLine1: "1 Test St",
      shipFromCity: "Chicago",
      shipFromState: "IL",
      shipFromPostalCode: "60601",
      shipFromCountry: "US",
    })) {
      await form.locator(`[name="${field}"]`).fill(value);
    }
    let posts = 0;
    let attemptId = "";
    let finish!: () => void;
    const committed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await page.route("**/account/inventory/locations", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      attemptId = new URLSearchParams(route.request().postData() ?? "").get("inventoryMutationAttemptId") ?? "";
      expect(attemptId).toMatch(/^[a-f0-9-]{36}$/);
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.status()).toBe(303);
      await route.abort("failed");
      finish();
    });
    await form.getByRole("button", { name: "Create location", exact: true }).click();
    await committed;
    await page.goto("/account/inventory/locations");
    const status = page.getByRole("status").filter({ hasText: "original Inventory change is confirmed" });
    await expect(status).toBeVisible();
    await expect(status).toBeFocused();
    await expect(status).toHaveAttribute("aria-live", "polite");
    expect(posts).toBe(1);
    const receipt = await page.request.get(`/api/inventory/mutation-attempts/${attemptId}`);
    expect(receipt.status()).toBe(200);
    expect(receipt.headers()["cache-control"]).toBe("private, no-store");
    expect(await receipt.json()).toMatchObject({
      version: 1,
      family: "location-create",
      targetId: "draft",
      result: { version: 1 },
    });
    const records = await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith("inventory-mutation/v1:")),
    );
    expect(records).toEqual([]);
    await captureAccessibilityEvidence({ page, testInfo, surface: "inventory-recovery-confirmed" });
  });

  test("unavailable restore is focused, responsive and disables writes without auto-submit", async ({
    page,
  }, testInfo) => {
    await signInWithPassword(page, String(testInfo.project.use.baseURL), marketplaceBrowserE2eSellerCredentials());
    await page.goto("/account/inventory/locations");
    const actorResponse = await page.request.get("/api/auth/session");
    expect(actorResponse.ok()).toBe(true);
    const actorBody = await actorResponse.json();
    const actor = actorBody.actor ?? actorBody;
    expect(actor.accountId).toBeTruthy();
    expect(actor.userId).toBeTruthy();
    const attemptId = randomUUID();
    await page.evaluate(
      ({ actor, attemptId }) => {
        sessionStorage.setItem(
          `inventory-mutation/v1:${encodeURIComponent(actor.accountId)}:location-create`,
          JSON.stringify({
            version: 1,
            attemptId,
            accountId: actor.accountId,
            actorUserId: actor.userId,
            family: "location-create",
            targetId: "draft",
            createdAt: new Date().toISOString(),
          }),
        );
      },
      { actor, attemptId },
    );
    const writes: string[] = [];
    page.on("request", (request) => {
      if (["POST", "PATCH"].includes(request.method())) writes.push(request.url());
    });
    await page.reload();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      const status = page.getByRole("status").filter({ hasText: "result is uncertain" });
      await expect(status).toBeVisible();
      await expect(status).toBeFocused();
      await expect(page.getByRole("button", { name: "Create location", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Check original result", exact: true })).toBeVisible();
      await testInfo.attach(`inventory-recovery-ambiguous-${width}.png`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
    expect(writes).toEqual([]);
    await captureAccessibilityEvidence({ page, testInfo, surface: "inventory-recovery-ambiguous" });
  });
});
