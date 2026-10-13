import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { encodeFreshWriteReceipt } from "@chase-sets/http/responses";
import { seedBrowserConsent } from "../../../bounded-contexts/identity/features/account-management/tests/browser-test-support";
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
    await registerSyntheticAccount(page, baseURL, syntheticActor(testInfo), { freshReadRoute: "/account/security" });
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
    await expect(page).toHaveURL(/\/account\?afterWrite=/);
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
    await expect(page).toHaveURL(/\/account\/security\?afterWrite=/);
    await page.reload();
    await expect(page.getByLabel(/^Display name$/i)).toHaveValue("Synthetic interruption user");
    await page.goto("/account/team");
    const invitation = page.locator('form:has(input[name="intent"][value="create-invitation"])');
    await invitation.getByLabel("Email", { exact: true }).fill("synthetic-invite7168@example.test");
    await invitation.getByRole("button", { name: /^Invite$/i }).click();
    await expect(page.getByText("Your change was saved", { exact: true })).toBeVisible();
    expect(writes).toEqual(["/account/security.data", "/account/team.data"]);
    await expect(page).toHaveURL(/\/account\/team\?afterWrite=/);
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
    test("in-flight Account switch discards the late key response and recovery state", async ({
      page,
      baseURL,
    }, testInfo) => {
      await page.goto("/account/security");
      let release!: () => void;
      let committed!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const recorded = new Promise<void>((resolve) => {
        committed = resolve;
      });
      let writes = 0;
      await page.route("**/account/security.data", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        writes++;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        committed();
        await held;
        await route.fulfill({ response });
      });
      const otherPage = await page.context().newPage();
      try {
        await page.getByLabel(/^API key name$/i).fill("Synthetic held key");
        await page.getByRole("button", { name: /^Create API key$/i }).click();
        await recorded;
        await expect(page.getByText("Saving your change", { exact: true })).toBeVisible();
        const other = {
          ...syntheticActor(testInfo),
          email: `inflight-${syntheticActor(testInfo).email}`,
          displayName: `In flight ${syntheticActor(testInfo).displayName}`,
        };
        await registerSyntheticAccount(otherPage, baseURL!, other, { freshReadRoute: "/account/security" });
        // Drive the real browser router without a document reload, so the actor-generation fence is exercised.
        await page.evaluate(() => {
          history.replaceState(history.state, "", "/account/security?accountSwitch=synthetic");
          window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        });
        await expect(page.getByLabel(/^Display name$/i)).toHaveValue(other.displayName);
        await expect(page.getByText("Saving your change", { exact: true })).toHaveCount(0);
        const response = page.waitForResponse(
          (value) => new URL(value.url()).pathname === "/account/security.data" && value.request().method() === "POST",
        );
        release();
        await response;
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );
        await expect(page.getByText("Your change was saved", { exact: true })).toHaveCount(0);
        await expect(page.getByText("API key secret created", { exact: true })).toHaveCount(0);
        await expect(page.locator("pre")).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Create API key$/i })).toBeEnabled();
        expect(writes).toBe(1);
        expect(
          await page.evaluate(() =>
            Object.keys(localStorage)
              .concat(Object.keys(sessionStorage))
              .some((name) => /attempt|descriptor/i.test(name)),
          ),
        ).toBe(false);
      } finally {
        release();
        await otherPage.close();
      }
    });
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

  test("keyed Consent withdrawal uses one token read and immutable replay/lookup after response loss", async ({
    page,
  }, testInfo) => {
    const session = await page.request.get("/api/auth/session");
    expect(session.status()).toBe(200);
    const actor = (await session.json()).actor;
    const fixture = await seedBrowserConsent(testInfo.config.metadata.catalogDatabaseUrl, actor);
    const receipt = encodeFreshWriteReceipt({ observedAtMs: Date.now(), sources: fixture.sources });
    await page.goto(`/account/consents?afterWrite=${encodeURIComponent(receipt)}`);
    const posts: { key: string; body: string; contentType: string }[] = [];
    const tokens: string[] = [];
    let lookups = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/account/consents.data" && url.searchParams.has("afterWrite"))
        tokens.push(url.pathname);
      if (url.pathname === "/api/identity/account-management/attempts") lookups++;
    });
    await page.route("**/account/consents.data", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts.push({
        key: route.request().headers()["idempotency-key"] ?? "",
        body: route.request().postData() ?? "",
        contentType: route.request().headers()["content-type"],
      });
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("connectionreset");
    });
    await page.getByRole("button", { name: "Withdraw", exact: true }).last().click();
    const form = page.locator('form:has(input[name="intent"][value="withdraw"])');
    const target = await form.locator('input[name="consentId"]').inputValue();
    await form.getByRole("button", { name: "Confirm withdrawal", exact: true }).click();
    await expect(page.getByText("Your change was saved", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/account\/consents\?afterWrite=/);
    expect(posts).toHaveLength(1);
    expect(posts[0].key).toMatch(/^[a-f0-9-]{36}$/i);
    expect(tokens).toHaveLength(1);
    expect(lookups).toBe(1);
    const headers = { "Idempotency-Key": posts[0].key, Accept: "text/x-script", "Content-Type": posts[0].contentType };
    const replay = await page.request.post("/account/consents.data", { headers, data: posts[0].body });
    expect(replay.status()).toBe(200);
    const lookup = await page.request.get(
      `/api/identity/account-management/attempts?action=withdraw&target=${encodeURIComponent(target)}`,
      { headers: { "Idempotency-Key": posts[0].key } },
    );
    expect(await lookup.json()).toMatchObject({
      outcome: "committed",
      newlyCommitted: false,
      receipt: { action: "withdraw", target },
      current: { status: "withdrawn" },
    });
    await page.reload();
    await expect(page.getByText("Withdrawn", { exact: true }).first()).toBeVisible();
  });

  test("keyed shipping create, update, default and archive use the accepted sandbox provider and one token read each", async ({
    page,
  }) => {
    await page.goto("/account/shipping-addresses");
    const writes: string[] = [];
    let tokens = 0;
    page.on("request", async (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname === "/account/shipping-addresses.data") {
        expect(request.headers()["idempotency-key"]).toMatch(/^[a-f0-9-]{36}$/i);
        const form = await new Response(request.postData(), {
          headers: { "Content-Type": request.headers()["content-type"] },
        }).formData();
        writes.push(String(form.get("intent")));
      }
      if (
        request.method() === "GET" &&
        url.pathname === "/account/shipping-addresses.data" &&
        url.searchParams.has("afterWrite")
      )
        tokens++;
    });
    const create = page.locator('form:has(input[name="intent"][value="create"])');
    for (const [name, value] of Object.entries({
      name: "Synthetic recipient",
      line1: "1 Test St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    }))
      await create.locator(`input[name="${name}"]`).fill(value);
    await create.locator('input[name="label"]').fill("Synthetic home");
    await create.getByRole("button", { name: "Save address", exact: true }).click();
    await expect(page).toHaveURL(/\/account\/shipping-addresses\?afterWrite=/);
    await expect(page.getByText("Synthetic home", { exact: true })).toBeVisible();
    expect(tokens).toBe(1);
    await page.getByRole("button", { name: "Update address", exact: true }).first().click();
    const update = page.locator('form:has(input[name="intent"][value="update"])');
    await update.locator('input[name="label"]').fill("Updated synthetic home");
    await update.getByRole("button", { name: "Update address", exact: true }).click();
    await expect(page.getByText("Updated synthetic home", { exact: true })).toBeVisible();
    expect(tokens).toBe(2);
    await page.getByRole("button", { name: "Set default", exact: true }).click();
    await expect(page.getByText("Default", { exact: true }).last()).toBeVisible();
    await expect(page.getByRole("button", { name: "Set default", exact: true })).toHaveCount(0);
    expect(tokens).toBe(3);
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await page
      .locator('form:has(input[name="intent"][value="archive"])')
      .getByRole("button", { name: "Archive", exact: true })
      .click();
    await expect(page.getByText("No saved shipping addresses", { exact: true })).toBeVisible();
    expect(tokens).toBe(4);
    expect(writes).toEqual(["create", "update", "default", "archive"]);
  });

  test("injected actor props in the real profile form are refused before mutation work", async ({ page }) => {
    const form = await profileForm(page);
    const original = await form.getByLabel("Marketplace name", { exact: true }).inputValue();
    await form.evaluate((node: HTMLFormElement) => {
      const injected = document.createElement("input");
      injected.type = "hidden";
      injected.name = "accountId";
      injected.value = "acc_synthetic_foreign";
      node.append(injected);
    });
    await form.getByLabel("Marketplace name", { exact: true }).fill("Must not be saved");
    const response = page.waitForResponse(
      (value) => new URL(value.url()).pathname === "/account.data" && value.request().method() === "POST",
    );
    await form.getByRole("button", { name: /^Update profile$/i }).click();
    expect((await response).status()).toBe(400);
    await expect(page.getByText("No change was recorded. Review and submit again.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Marketplace name", { exact: true })).toHaveValue(original);
  });

  test("an ambiguous team revoke visibly holds only that control and still sends an invitation", async ({ page }) => {
    await page.goto("/account/team");
    const methods: string[] = [];
    await page.route("**/account/team.data", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      methods.push("POST");
      const form = await new Response(route.request().postData(), {
        headers: { "Content-Type": route.request().headers()["content-type"] },
      }).formData();
      if (form.get("intent") === "revoke") return route.abort("connectionreset");
      await route.continue();
    });
    await page.route("**/api/identity/account-management/attempts?*", async (route) => {
      methods.push("GET");
      await route.fulfill({ json: { outcome: "indeterminate", code: "INDETERMINATE" } });
    });
    await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
    const revoke = page.locator('form:has(input[name="intent"][value="revoke"])');
    await revoke.getByRole("button", { name: "Confirm revoke", exact: true }).click();
    await expect(
      page.getByText("We could not confirm the result. Do not repeat this action yet.", { exact: true }),
    ).toBeVisible();
    await expect(revoke.locator('button[type="submit"]')).toBeDisabled();
    await page.getByRole("dialog").getByRole("button", { name: /close/i }).click();
    const invite = page.locator('form:has(input[name="intent"][value="create-invitation"])');
    await expect(invite.getByRole("button", { name: "Invite", exact: true })).toBeEnabled();
    await invite.getByLabel("Email", { exact: true }).fill("synthetic-held-invite@example.test");
    await invite.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(page.getByText("Your change was saved", { exact: true })).toBeVisible();
    expect(methods).toEqual(["POST", "GET", "POST"]);
  });
});
