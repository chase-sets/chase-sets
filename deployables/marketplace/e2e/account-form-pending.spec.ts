import { expect, test, type TestInfo } from "@playwright/test";
import { registerSyntheticAccount, syntheticAccountFor } from "./support/auth";

const route = "/account/shipping-addresses";
const refusal = "Another account change is in progress. Wait for it to finish before trying again.";

function syntheticActor(testInfo: TestInfo) {
  return syntheticAccountFor({
    file: testInfo.file,
    project: { name: testInfo.project.name },
    titlePath: [...testInfo.titlePath, `retry:${testInfo.retry}`],
  });
}

test.describe("issue-7125 account form pending @marketplace-account", () => {
  test("identity shipping form double activation keeps the submitter busy and sibling interactive", async ({
    page,
    baseURL,
  }, testInfo) => {
    if (!baseURL) throw new Error("Marketplace base URL is required");
    await registerSyntheticAccount(page, baseURL, syntheticActor(testInfo), { freshReadRoute: "/account/security" });
    await expect
      .poll(async () => {
        const display = await page.request.get("/api/identity/current-actor-display");
        if (display.status() !== 200) return display.status();
        const actorDisplay = (await display.json()) as { user: { user_id: string } };
        const user = await page.request.get(`/api/identity/users/${encodeURIComponent(actorDisplay.user.user_id)}`);
        return user.status();
      })
      .toBe(200);
    await page.goto(route);

    const create = page.locator('form:has(input[name="intent"][value="create"])');
    const save = create.getByRole("button", { name: "Save address", exact: true });
    for (const label of ["Synthetic base", "Synthetic home", "Synthetic work"]) {
      for (const [name, value] of Object.entries({
        label,
        name: "Synthetic recipient",
        line1: "1 Test St",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      }))
        await create.locator(`input[name="${name}"]`).fill(value);
      await save.click();
      await expect(page.getByText(label, { exact: true })).toBeVisible();
      await expect(save).not.toHaveAttribute("aria-busy", "true");
    }

    const defaults = page.locator('form:has(input[name="intent"][value="default"])');
    await expect.poll(() => defaults.count()).toBeGreaterThanOrEqual(2);
    const [firstTarget, secondTarget] = await Promise.all(
      [0, 1].map((index) => defaults.nth(index).locator('input[name="shippingAddressId"]').inputValue()),
    );
    const setDefault = (target: string) =>
      page.locator(
        `form:has(input[name="intent"][value="default"]):has(input[name="shippingAddressId"][value="${target}"])`,
      );
    const submitter = setDefault(firstTarget).getByRole("button", { name: "Set default", exact: true });
    const sibling = setDefault(secondTarget).getByRole("button", { name: "Set default", exact: true });

    let posts = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**${route}.data`, async (request) => {
      if (request.request().method() !== "POST") return request.continue();
      posts++;
      await held;
      await request.continue();
    });
    try {
      await submitter.dblclick();
      await expect.poll(() => posts).toBe(1);
      await expect(submitter).toHaveAttribute("aria-busy", "true");
      await expect(submitter).toBeEnabled();
      await expect(submitter).toBeFocused();
      await expect(page.getByText(refusal, { exact: true })).toHaveCount(0);
      await expect(sibling).toBeEnabled();
      await expect(sibling).not.toHaveAttribute("aria-busy", "true");

      await sibling.click();
      await expect(page.locator('[role="status"][tabindex="-1"]').getByText(refusal, { exact: true })).toBeVisible();
      await expect(sibling).toBeEnabled();
      await expect(sibling).not.toHaveAttribute("aria-busy", "true");
      await expect(submitter).toHaveAttribute("aria-busy", "true");
      expect(posts).toBe(1);
    } finally {
      release();
    }

    await expect(page.getByText("Your change was saved", { exact: true })).toBeVisible();
    await expect(setDefault(firstTarget)).toHaveCount(0);
    await expect(page.getByText(refusal, { exact: true })).toHaveCount(0);
    await expect(sibling).toBeEnabled();
    await expect(sibling).not.toHaveAttribute("aria-busy", "true");
    expect(posts).toBe(1);
  });
});
