import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { registerSyntheticAccount, syntheticAccountFor } from "./support/auth";

const routes = ["/account", "/account/shipping-addresses", "/account/consents", "/account/security", "/account/team"];

// These real mutations return plaintext key secrets; never record their network or DOM sinks.
test.use({ trace: "off", video: "off", screenshot: "off" });

function syntheticActor(testInfo: TestInfo) {
  return syntheticAccountFor({
    file: testInfo.file,
    project: { name: testInfo.project.name },
    titlePath: [...testInfo.titlePath, `retry:${testInfo.retry}`],
  });
}

async function profileForm(page: Page) {
  const form = page.locator('form:has(input[name="intent"][value="update-profile"])');
  await expect(form.getByRole("button", { name: /^Update profile$/i })).toBeEnabled();
  await form.getByLabel("Legal Name", { exact: true }).fill("Synthetic legal name");
  return form;
}

test.describe("issue-7168-ac10-real-router @marketplace-account", () => {
  test.beforeEach(async ({ page, baseURL }, testInfo) => {
    if (!baseURL) throw new Error("Marketplace base URL is required");
    await registerSyntheticAccount(page, baseURL, syntheticActor(testInfo));
    await page.goto("/account");
    await expect
      .poll(async () => {
        const display = await page.request.get("/api/identity/current-actor-display");
        if (display.status() !== 200) return display.status();
        const actorDisplay = (await display.json()) as { user: { user_id: string } };
        const user = await page.request.get(`/api/identity/users/${encodeURIComponent(actorDisplay.user.user_id)}`);
        return user.status();
      })
      .toBe(200);
    page.on("response", (response) => {
      const route = routes.indexOf(new URL(response.url()).pathname.replace(/\.data$/, ""));
      if (route >= 0 && response.request().method() === "POST")
        console.log(`issue7168-router-response route=${route} status=${response.status()}`);
    });
    await page.goto("/account");
  });

  test("five actual routes reject native/no-JS writes; enhanced profile uses keyed .data and one token GET", async ({
    page,
    browser,
    baseURL,
  }) => {
    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator("main")).toBeVisible();
    }
    const noJs = await browser.newContext({
      javaScriptEnabled: false,
      storageState: await page.context().storageState(),
      baseURL,
    });
    try {
      const nativePage = await noJs.newPage();
      await nativePage.goto("/account");
      await expect(nativePage.getByRole("button", { name: /^Update profile$/i })).toBeDisabled();
      for (const [index, route] of routes.entries()) {
        const intent = ["update-profile", "create", "withdraw", "create-api-key", "create-invitation"][index];
        const response = await noJs.request.post(route, { form: { intent, name: "Must not commit" } });
        expect(response.status()).toBe(400);
      }
    } finally {
      await noJs.close();
    }
    await page.goto("/account");
    const form = await profileForm(page);
    const posts: { path: string; keyed: boolean }[] = [];
    const tokenReads: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname.startsWith("/account"))
        posts.push({ path: url.pathname, keyed: /^[a-f0-9-]{36}$/i.test(request.headers()["idempotency-key"] ?? "") });
      if (request.method() === "GET" && url.pathname === "/account.data" && url.searchParams.has("afterWrite"))
        tokenReads.push(url.pathname);
    });
    await form.getByLabel("Marketplace name", { exact: true }).fill("Interruption-safe synthetic account");
    await form.getByRole("button", { name: /^Update profile$/i }).click();
    await expect(page.getByText("Your change was saved", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/afterWrite=/);
    expect(posts).toEqual([{ path: "/account.data", keyed: true }]);
    expect(tokenReads).toHaveLength(1);
    await expect(page.locator('[role="status"][tabindex="-1"]')).toBeFocused();
    await page.reload();
    await expect(page.getByLabel("Marketplace name", { exact: true })).toHaveValue(
      "Interruption-safe synthetic account",
    );
  });

  test("response loss confirms the real commit once, never resubmits", async ({ page }) => {
    let posts = 0;
    let lookups = 0;
    await page.route("**/account.data", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("connectionreset");
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/identity/account-management/attempts") {
        expect(request.method()).toBe("GET");
        lookups++;
      }
    });
    const form = await profileForm(page);
    await form.getByLabel("Marketplace name", { exact: true }).fill("Recovered synthetic account");
    await form.getByRole("button", { name: /^Update profile$/i }).click();
    await expect(page.getByText("Your change was saved", { exact: true })).toBeVisible();
    expect(posts).toBe(1);
    expect(lookups).toBe(1);
    await page.reload();
    await expect(page.getByLabel("Marketplace name", { exact: true })).toHaveValue("Recovered synthetic account");
  });

  test("submitting and confirming preserve entered work and suppress double submits", async ({ page }) => {
    let releasePost!: () => void;
    let releaseLookup!: () => void;
    const postHeld = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const lookupHeld = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let posts = 0;
    let lookups = 0;
    await page.route("**/account.data", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      await postHeld;
      await route.abort("connectionreset");
    });
    await page.route("**/api/identity/account-management/attempts?*", async (route) => {
      lookups++;
      await lookupHeld;
      await route.fulfill({ json: { outcome: "not-recorded", code: "not-recorded" } });
    });
    const form = await profileForm(page);
    const name = form.getByLabel("Marketplace name", { exact: true });
    try {
      await name.fill("Preserved synthetic work");
      await form.getByRole("button", { name: /^Update profile$/i }).click();
      await expect(page.getByText("Saving your change", { exact: true })).toBeVisible();
      await expect(name).toHaveValue("Preserved synthetic work");
      await expect(form.locator('button[type="submit"]')).toBeDisabled();
      await form.evaluate((node: HTMLFormElement) =>
        node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(posts).toBe(1);
      releasePost();
      await expect(page.getByText("Checking whether your change was saved", { exact: true })).toBeVisible();
      await expect(name).toHaveValue("Preserved synthetic work");
      expect(lookups).toBe(1);
      releaseLookup();
      await expect(page.getByText("No change was recorded. Review and submit again.", { exact: true })).toBeVisible();
      await expect(name).toHaveValue("Preserved synthetic work");
      expect(posts).toBe(1);
    } finally {
      releasePost();
      releaseLookup();
    }
  });

  test("security profile and team invitation use the same real keyed router boundary", async ({ page }) => {
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/account")) {
        expect(request.headers()["idempotency-key"]).toMatch(/^[a-f0-9-]{36}$/i);
        writes.push(new URL(request.url()).pathname);
      }
    });
    await page.goto("/account/security");
    const profile = page.locator('form:has(input[name="intent"][value="update-user"])');
    await profile.getByLabel(/^Display name$/i).fill("Synthetic interruption user");
    await profile.getByRole("button", { name: /^Update profile$/i }).click();
    await expect(page.getByText("Your change was saved", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(/^Display name$/i)).toHaveValue("Synthetic interruption user");
    await page.goto("/account/team");
    const invitation = page.locator('form:has(input[name="intent"][value="create-invitation"])');
    await invitation.getByLabel("Email", { exact: true }).fill("synthetic-invite7168@example.test");
    await invitation.getByRole("button", { name: /^Invite$/i }).click();
    await expect(page.getByText("Your change was saved", { exact: true })).toBeVisible();
    expect(writes).toEqual(["/account/security.data", "/account/team.data"]);
    await page.reload();
    await expect(page.getByText("synthetic-invite7168@example.test", { exact: true })).toBeVisible();
  });

  for (const [outcome, status, message] of [
    ["not-recorded", 200, "No change was recorded. Review and submit again."],
    ["indeterminate", 200, "We could not confirm the result. Do not repeat this action yet."],
    ["conflict", 409, "The account changed. Review its current state before submitting again."],
    ["reauth", 401, "Sign in again to check this action's result."],
    ["denied", 403, "You no longer have access to this action."],
  ] as const) {
    test(`loss with bounded ${outcome} lookup has no retry or false success`, async ({ page }) => {
      let posts = 0;
      let reads = 0;
      await page.route("**/account.data", async (route) => {
        if (route.request().method() === "POST") {
          posts++;
          await route.abort("connectionreset");
        } else await route.continue();
      });
      await page.route("**/api/identity/account-management/attempts?*", async (route) => {
        reads++;
        expect(route.request().method()).toBe("GET");
        await route.fulfill({
          status,
          json: { outcome, code: outcome === "indeterminate" ? "INDETERMINATE" : outcome },
        });
      });
      const form = await profileForm(page);
      await form.getByRole("button", { name: /^Update profile$/i }).click();
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      expect(posts).toBe(1);
      expect(reads).toBe(1);
      await expect(page.getByText("Your change was saved", { exact: true })).toHaveCount(0);
      if (["indeterminate", "reauth", "denied"].includes(outcome))
        await expect(form.getByRole("button", { name: /^Update profile$/i })).toBeDisabled();
      await expect(page.locator('[role="status"][tabindex="-1"]')).toBeFocused();
    });
  }

  test.describe("plaintext recording exclusion", () => {
    test("key secret stays in controller memory, acknowledgement/unmount/account switch purge it and artifacts stay clean", async ({
      page,
      baseURL,
    }, testInfo) => {
      await page.goto("/account/security");
      await page.getByLabel(/^API key name$/i).fill("Synthetic interruption key");
      await page.getByRole("button", { name: /^Create API key$/i }).click();
      await expect(page.getByText("API key secret created", { exact: true })).toBeVisible();
      const secret = await page.locator("pre").last().textContent();
      expect(Boolean(secret && secret.startsWith("key_"))).toBe(true);
      if (!secret) throw new Error("Expected ephemeral secret");
      expect(page.url().includes(secret)).toBe(false);
      expect(
        await page.evaluate(
          (value) =>
            Object.values(localStorage).join("").includes(value) ||
            Object.values(sessionStorage).join("").includes(value),
          secret,
        ),
      ).toBe(false);
      await page.getByRole("button", { name: "I have stored this secret", exact: true }).click();
      expect((await page.textContent("body"))?.includes(secret)).toBe(false);
      await page.reload();
      expect((await page.textContent("body"))?.includes(secret)).toBe(false);
      await registerSyntheticAccount(page, baseURL!, {
        ...syntheticActor(testInfo),
        email: `switch-${syntheticActor(testInfo).email}`,
        displayName: `Switch ${syntheticActor(testInfo).displayName}`,
      });
      await page.goto("/account/security");
      expect((await page.textContent("body"))?.includes(secret)).toBe(false);
      async function scan(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await scan(file);
          else expect((await readFile(file)).includes(Buffer.from(secret!))).toBe(false);
        }
      }
      await scan(testInfo.outputDir);
    });
    test("lost first key response yields committed-secret-unrecoverable, not another write or plaintext", async ({
      page,
    }) => {
      await page.goto("/account/security");
      let writes = 0;
      let reads = 0;
      await page.route("**/account/security.data", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        writes++;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort("connectionreset");
      });
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/identity/account-management/attempts") reads++;
      });
      await page.getByLabel(/^API key name$/i).fill("Synthetic lost key");
      await page.getByRole("button", { name: /^Create API key$/i }).click();
      await expect(page.getByText("Your change was saved", { exact: true })).toBeVisible();
      await expect(page.getByText(/The key was saved, but its secret cannot be recovered/)).toBeVisible();
      await expect(page.getByText("API key secret created", { exact: true })).toHaveCount(0);
      expect(writes).toBe(1);
      expect(reads).toBe(1);
    });
  });
});
