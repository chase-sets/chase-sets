import { expect, test, type Page } from "@playwright/test";
import { authenticateAdmin, expectPageOk, skipDeployedAdminE2e } from "./support/admin-e2e";

type AccountRealtimeProbeResult = Readonly<{
  status: number;
  contentType: string;
  textStart: string;
  error: string | null;
}>;

async function probeAccountRealtimeEndpoint(page: Page, path: string): Promise<AccountRealtimeProbeResult> {
  return page.evaluate(async (streamPath) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort("stream probe timeout"), 5_000);

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

function expectControlledAccountRealtimeProbe(path: string, result: AccountRealtimeProbeResult) {
  expect(result.error, `${path} should resolve headers before the probe timeout`).toBeNull();
  if (result.status === 200) {
    expect(result.contentType, `${path} should open as an event stream`).toContain("text/event-stream");
    return;
  }

  expect([401, 403, 429, 503], `${path} should return a controlled JSON response`).toContain(result.status);
  expect(result.contentType, `${path} should not return host HTML`).toContain("application/json");
  expect(result.textStart, `${path} should not return an HTML fallback`).not.toMatch(/<!doctype html|<html/i);
  expect(() => JSON.parse(result.textStart || "{}"), `${path} should return JSON`).not.toThrow();
}

test.describe("admin cross-cutting API topology", () => {
  test("account realtime streams open or fail with controlled JSON responses @admin-platform", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/platform/projections", "/access/sign-in");
    await expectPageOk(page, "/platform/projections");

    const path = "/api/realtime/account/events?topic=account%3Atopology-smoke%3Alistings";
    expectControlledAccountRealtimeProbe(path, await probeAccountRealtimeEndpoint(page, path));
  });
});
