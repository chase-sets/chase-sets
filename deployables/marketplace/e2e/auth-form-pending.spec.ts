import { expect, test, type Page } from "@playwright/test";
import { marketplaceBrowserE2eBuyerCredentials } from "./support/seed-contract";
import { hasIdentifierSubmitHandler } from "./support/sign-in-readiness";

async function withHeldSignInPost(page: Page, exercise: (posts: () => number, release: () => void) => Promise<void>) {
  let posts = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handlers: Promise<void>[] = [];
  let failed = false;
  await page.route("**/sign-in*", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    const completed = (async () => {
      expect(route.request().isNavigationRequest()).toBe(false);
      expect(new URL(route.request().url()).pathname).toBe("/sign-in.data");
      await held;
      await route.continue();
    })();
    handlers.push(completed);
    return completed.catch(() => {});
  });
  try {
    await exercise(() => posts, release);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    release();
    const cleanup = await Promise.allSettled([page.unrouteAll({ behavior: "wait" }), ...handlers]);
    const rejected = cleanup.find((result) => result.status === "rejected");
    if (!failed && rejected?.status === "rejected") throw rejected.reason;
  }
}

test.describe("marketplace auth form pending state", () => {
  test("sign-in pointer submit blocks double submission and keeps focus on the submitter @marketplace-account @browser-e2e-seed", async ({
    page,
  }) => {
    const account = marketplaceBrowserE2eBuyerCredentials();
    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart", { waitUntil: "domcontentloaded" });
    const identifier = page.getByLabel(/Email or phone/i);
    const identifierForm = identifier.locator("xpath=ancestor::form");
    await expect.poll(() => identifierForm.evaluate(hasIdentifierSubmitHandler)).toBe(true);
    await identifier.fill(account.email);
    await page.getByRole("button", { name: /^Continue$/i }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/sign-in" && !url.searchParams.has("signInIdentifier"));
    await page.getByRole("radio", { name: /^Password$/i }).click();
    const password = page.getByLabel(/^Password$/i);
    const form = password.locator("xpath=ancestor::form");
    await expect.poll(() => form.evaluate(hasIdentifierSubmitHandler)).toBe(true);
    await password.fill(account.password);
    const submitter = form.getByRole("button", { name: /^Sign in$/i });
    await withHeldSignInPost(page, async (posts, release) => {
      await submitter.click();
      await expect(form).toHaveAttribute("aria-busy", "true");
      await expect(submitter).toHaveAttribute("aria-busy", "true");
      await expect(submitter).toBeEnabled();
      await expect(submitter).toBeFocused();
      await submitter.click();
      expect(posts()).toBe(1);
      release();
      await expect(page).toHaveURL(/\/account\/cart(?:\?|$)/);
      expect(posts()).toBe(1);
    });
  });

  test("sign-in Enter submit blocks double submission and keeps focus on the password field @marketplace-account @browser-e2e-seed", async ({
    page,
  }) => {
    const account = marketplaceBrowserE2eBuyerCredentials();
    await page.goto("/sign-in?returnTo=%2Faccount%2Fcart", { waitUntil: "domcontentloaded" });
    const identifier = page.getByLabel(/Email or phone/i);
    const identifierForm = identifier.locator("xpath=ancestor::form");
    await expect.poll(() => identifierForm.evaluate(hasIdentifierSubmitHandler)).toBe(true);
    await identifier.fill(account.email);
    await page.getByRole("button", { name: /^Continue$/i }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/sign-in" && !url.searchParams.has("signInIdentifier"));
    await page.getByRole("radio", { name: /^Password$/i }).click();
    const password = page.getByLabel(/^Password$/i);
    const form = password.locator("xpath=ancestor::form");
    await expect.poll(() => form.evaluate(hasIdentifierSubmitHandler)).toBe(true);
    await password.fill(account.password);
    await withHeldSignInPost(page, async (posts, release) => {
      await password.press("Enter");
      await expect(form).toHaveAttribute("aria-busy", "true");
      await expect(password).toBeFocused();
      await password.press("Enter");
      expect(posts()).toBe(1);
      release();
      await expect(page).toHaveURL(/\/account\/cart(?:\?|$)/);
      expect(posts()).toBe(1);
    });
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
