import { expect, test } from "@playwright/test";
import { marketplaceBrowserE2eBuyerCredentials } from "./support/seed-contract";

test.describe("marketplace auth form pending state", () => {
  test("sign-in pointer submit blocks double submission and keeps focus on the submitter @marketplace-account @browser-e2e-seed", async ({
    page,
  }) => {
    const account = marketplaceBrowserE2eBuyerCredentials();
    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart", { waitUntil: "domcontentloaded" });
    await page.getByLabel(/Email or phone/i).fill(account.email);
    await page.getByRole("button", { name: /^Continue$/i }).click();
    await page.getByRole("radio", { name: /^Password$/i }).click();
    const password = page.getByLabel(/^Password$/i);
    await password.fill(account.password);
    const form = password.locator("xpath=ancestor::form");
    const submitter = form.getByRole("button", { name: /^Sign in$/i });
    let posts = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/sign-in*", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      await held;
      await route.continue();
    });
    await submitter.click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(submitter).toBeFocused();
    await submitter.click();
    expect(posts).toBe(1);
    release();
    await expect(page).toHaveURL(/\/account\/cart(?:\?|$)/);
  });

  test("sign-in Enter submit blocks double submission and keeps focus on the password field @marketplace-account @browser-e2e-seed", async ({
    page,
  }) => {
    const account = marketplaceBrowserE2eBuyerCredentials();
    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart", { waitUntil: "domcontentloaded" });
    await page.getByLabel(/Email or phone/i).fill(account.email);
    await page.getByRole("button", { name: /^Continue$/i }).click();
    await page.getByRole("radio", { name: /^Password$/i }).click();
    const password = page.getByLabel(/^Password$/i);
    await password.fill(account.password);
    const form = password.locator("xpath=ancestor::form");
    let posts = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/sign-in*", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      await held;
      await route.continue();
    });
    await password.press("Enter");
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(password).toBeFocused();
    await password.press("Enter");
    expect(posts).toBe(1);
    release();
    await expect(page).toHaveURL(/\/account\/cart(?:\?|$)/);
  });

  test("sign-in without JavaScript completes through a document POST @marketplace-account @browser-e2e-seed", async ({
    browser,
    baseURL,
  }) => {
    const account = marketplaceBrowserE2eBuyerCredentials();
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: baseURL ?? undefined });
    const page = await context.newPage();
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") posts.push(new URL(request.url()).pathname);
    });
    try {
      await page.goto("/sign-in?returnTo=%2Faccount%2Fcart", { waitUntil: "domcontentloaded" });
      await page.getByLabel(/Email or phone/i).fill(account.email);
      await page.getByRole("button", { name: /^Continue$/i }).click();
      await page.getByLabel(/^Password$/i).fill(account.password);
      await page.getByRole("button", { name: /^Sign in$/i }).click();
      await expect(page).toHaveURL(/\/account\/cart(?:\?|$)/);
      expect(posts).toContain("/sign-in");
    } finally {
      await context.close();
    }
  });
});
