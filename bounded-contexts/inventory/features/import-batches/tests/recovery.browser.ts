import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { t } from "@chase-sets/localization";
import { identitySeedIds } from "@chase-sets/identity-seed";

export function registerImportRecoveryBrowserTests(
  signIn: (page: Page, baseUrl: string) => Promise<void>,
  captureAccessibilityEvidence: (input: { page: Page; testInfo: TestInfo; surface: string }) => Promise<void>,
) {
  test.describe("@marketplace-seller issue-7169-c3-upload-recovery", () => {
    test("real upload response loss restores one private acceptance without retaining or resending the file", async ({
      page,
    }, testInfo) => {
      await signIn(page, String(testInfo.project.use.baseURL));
      await page.goto("/account/inventory/imports");
      const form = page.locator("form").filter({ has: page.locator('input[name="intent"][value="create-batch"]') });
      const submit = form.getByRole("button", { name: "Validate import", exact: true });
      await expect(submit).toBeEnabled();
      const sentinel = `ignored-private-${randomUUID()}`;
      await form.locator('input[type="file"]').setInputFiles({
        name: "private-upload.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(`catalogItemId,totalQuantity,ignored\ncat_synthetic_missing,1,${sentinel}`),
      });
      let posts = 0;
      let attemptId = "";
      let finish!: () => void;
      const accepted = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const responseLoss = page.waitForEvent("requestfailed", {
        predicate: (request) =>
          request.method() === "POST" && new URL(request.url()).pathname === "/account/inventory/imports",
      });
      await page.route("**/account/inventory/imports", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posts++;
        attemptId =
          /name="inventoryMutationAttemptId"\r\n\r\n([a-f0-9-]{36})/.exec(route.request().postData() ?? "")?.[1] ?? "";
        expect(attemptId).toMatch(/^[a-f0-9-]{36}$/);
        const response = await route.fetch({ maxRedirects: 0 });
        expect(response.status()).toBe(302);
        await route.abort("failed");
        finish();
      });
      const abortedNavigation = page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
      });
      await submit.click();
      await accepted;
      await responseLoss;
      await abortedNavigation;
      await page.goto("/account/inventory/imports");
      const metadata = await page.evaluate(() =>
        Object.entries(sessionStorage).filter(([key]) => key.startsWith("inventory-mutation/v1:")),
      );
      expect(JSON.stringify(metadata)).not.toContain(sentinel);
      expect(JSON.stringify(metadata)).not.toContain("private-upload.csv");
      const status = page.getByRole("status").filter({ hasText: "original Inventory change is confirmed" });
      await expect(status).toBeVisible();
      await expect(status).toBeFocused();
      await expect(status).toHaveAttribute("aria-live", "polite");
      const receipt = await page.request.get(`/api/inventory/mutation-attempts/${attemptId}`);
      expect(receipt.status()).toBe(200);
      expect(receipt.headers()["cache-control"]).toBe("private, no-store");
      const result = await receipt.json();
      expect(result).toMatchObject({ version: 1, family: "import-create", targetId: "draft" });
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(JSON.stringify(result)).not.toContain("private-upload.csv");
      expect(posts).toBe(1);
      await page.reload();
      await expect(submit).toBeEnabled();
      expect(posts).toBe(1);
      await captureAccessibilityEvidence({ page, testInfo, surface: "inventory-import-confirmed" });
    });

    for (const recovery of ["ambiguous", "reauth-required", "different-user"] as const) {
      test(`restored upload ${recovery} is read-only, focused and responsive`, async ({ page }, testInfo) => {
        await signIn(page, String(testInfo.project.use.baseURL));
        await page.goto("/account/inventory/imports");
        const attemptId = randomUUID();
        await page.evaluate(
          ({ attemptId, recovery, accountId, userId }) => {
            sessionStorage.setItem(
              `inventory-mutation/v1:${encodeURIComponent(accountId)}:import-create`,
              JSON.stringify({
                version: 1,
                attemptId,
                accountId,
                actorUserId: recovery === "different-user" ? "usr_synthetic_other" : userId,
                family: "import-create",
                targetId: "draft",
                createdAt: new Date().toISOString(),
              }),
            );
          },
          { attemptId, recovery, accountId: identitySeedIds.demo.accountId, userId: identitySeedIds.demo.userId },
        );
        let reads = 0;
        await page.route(`**/api/inventory/mutation-attempts/${attemptId}`, async (route) => {
          reads++;
          await route.fulfill({
            status: recovery === "reauth-required" ? 401 : 404,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "not_found",
                message: t("inventory.features.importBatches.api.route.import.batch.not.found"),
              },
            }),
          });
        });
        const writes: string[] = [];
        page.on("request", (request) => {
          if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(request.url());
        });
        await page.reload();
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 850 });
          const message = recovery === "ambiguous" ? "result is uncertain" : "original account";
          const status = page.getByRole("status").filter({ hasText: message });
          await expect(status).toBeVisible();
          await expect(status).toBeFocused();
          await expect(page.getByRole("button", { name: "Validate import", exact: true })).toBeDisabled();
          await testInfo.attach(`import-${recovery}-${width}.png`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
          });
        }
        expect(writes).toEqual([]);
        expect(reads).toBe(recovery === "different-user" ? 0 : 1);
        await captureAccessibilityEvidence({ page, testInfo, surface: `inventory-import-${recovery}` });
      });
    }
  });
}
