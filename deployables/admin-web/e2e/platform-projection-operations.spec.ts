import { expect, test, type Page } from "@playwright/test";
import { authenticateAdmin, expectAdminPageReady, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

type StreamProbeResult = Readonly<{
  status: number;
  contentType: string;
  textStart: string;
  error: string | null;
}>;

async function probeStreamEndpoint(page: Page, path: string): Promise<StreamProbeResult> {
  return page.evaluate(async (streamPath) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);

    try {
      const response = await window.fetch(streamPath, {
        credentials: "include",
        headers: { Accept: "text/event-stream, application/json" },
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      const textStart = contentType.includes("text/event-stream") ? "" : (await response.text()).slice(0, 240);
      return { status: response.status, contentType, textStart, error: null };
    } catch (error) {
      return {
        status: 0,
        contentType: "",
        textStart: "",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      window.clearTimeout(timeout);
    }
  }, path);
}

function expectControlledStreamProbe(path: string, result: StreamProbeResult) {
  expect(result.error, `${path} should resolve headers before the probe timeout`).toBeNull();
  if (result.status === 200) {
    expect(result.contentType, `${path} should open as an event stream`).toContain("text/event-stream");
    return;
  }

  expect([401, 403, 404], `${path} should return a controlled auth/not-found response`).toContain(result.status);
  expect(result.contentType, `${path} should not return host HTML`).toContain("application/json");
  expect(result.textStart, `${path} should not return an HTML fallback`).not.toMatch(/<!doctype html|<html/i);
  expect(() => JSON.parse(result.textStart || "{}"), `${path} should return JSON`).not.toThrow();
}

test.describe("platform admin projection operations", () => {
  test("projection operation event streams open or fail with controlled JSON responses @admin-platform", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/platform/projections", "/access/sign-in");
    await expectPageOk(page, "/platform/projections");

    const path = "/api/platform/projections/operations/op_admin_e2e_missing/events";
    expectControlledStreamProbe(path, await probeStreamEndpoint(page, path));
  });

  test("operator reviews projection console and refreshes status @admin-platform", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/platform/projections", "/access/sign-in");
    await expectPageOk(page, "/platform/projections");
    await expect(page).toHaveURL(/\/platform\/projections$/);
    await expectAdminPageReady(page, { heading: "Projection Operations" });

    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Overview/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Attention/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Operations/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Projection groups/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Subscriptions/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Blocked streams/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Workers/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Push wakes/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Diagnostics/ })).toBeVisible();

    for (const tabName of [
      /Overview/,
      /Attention/,
      /Operations/,
      /Projection groups/,
      /Subscriptions/,
      /Blocked streams/,
      /Workers/,
      /Push wakes/,
      /Diagnostics/,
    ]) {
      await page.getByRole("tab", { name: tabName }).click();
      await expectAdminPageReady(page, { heading: "Projection Operations" });
    }

    await page.getByRole("tab", { name: /Push wakes/ }).click();
    await expect(page.getByRole("link", { name: "Open Grafana wake dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open push-wake runbook" })).toBeVisible();

    await page.getByRole("tab", { name: /Projection groups/ }).click();
    await page.getByLabel("Search").fill("identity");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/\/platform\/projections\?.*search=identity/);
    await expectAdminPageReady(page, { heading: "Projection Operations" });
    await expect(page.getByText("Search: identity")).toBeVisible();

    const rebuildContext = page.getByRole("button", { name: "Rebuild context" });
    if (await rebuildContext.count()) {
      await rebuildContext.first().click();
      await expect(page.getByRole("heading", { name: "Rebuild context projections?" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Queue context rebuild" })).toBeVisible();
      await page.keyboard.press("Escape");
    }

    const groupDetails = page.getByRole("link", { name: "Details" });
    if (await groupDetails.count()) {
      await groupDetails.first().click();
      await expect(page).toHaveURL(/\/platform\/projections\?.*selected=/);
      const rebuildGroup = page.getByRole("button", { name: "Rebuild" });
      if (await rebuildGroup.count()) {
        await rebuildGroup.first().click();
        await expect(page.getByRole("heading", { name: "Rebuild projection group?" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Queue rebuild" })).toBeVisible();
        await page.keyboard.press("Escape");
      }
      await page.goto("/platform/projections?tab=groups&search=identity");
      await expectPageOk(page, "/platform/projections");
      await expectAdminPageReady(page, { heading: "Projection Operations" });
    }

    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page).toHaveURL(/\/platform\/projections\?.*search=identity/);
    await expectAdminPageReady(page, { heading: "Projection Operations" });
  });
});
