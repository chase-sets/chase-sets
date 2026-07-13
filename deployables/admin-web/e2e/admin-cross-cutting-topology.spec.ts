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
      // A successfully-opened (200) probe never reads the event-stream body, so the
      // connection would otherwise stay open (and keep leasing a slot against the
      // shared per-account stream budget, see resolveRealtimeConnectionKey) until
      // this page is torn down. Abort proactively so the lease releases
      // immediately instead of lingering into the next probe/test.
      controller.abort("stream probe complete");
    }
  }, path);
}

function expectControlledAccountRealtimeProbe(path: string, result: AccountRealtimeProbeResult) {
  expect(result.error, `${path} should resolve headers before the probe timeout`).toBeNull();
  if (result.status === 200) {
    expect(result.contentType, `${path} should open as an event stream`).toContain("text/event-stream");
    return;
  }

  // 404 joins the sibling catalog-authoring/job-stream probes' allowed set for
  // consistency: all four admin-web stream probes hit the same realtime/durable
  // job routes and should tolerate the same controlled-failure shapes.
  expect([401, 403, 404, 429, 503], `${path} should return a controlled JSON response`).toContain(result.status);
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
    // See catalog-modeling.spec.ts's authoring-stream probe for why this
    // re-probes within a settle window instead of asserting a single
    // point-in-time snapshot: the shared per-account stream limiter's lease
    // release from a just-finished admin-web test can lag behind this probe's
    // start.
    await expect(async () => {
      expectControlledAccountRealtimeProbe(path, await probeAccountRealtimeEndpoint(page, path));
    }).toPass({ intervals: [250, 500, 1_000, 2_000], timeout: 15_000 });
  });
});

test.describe("admin cross-cutting error state", () => {
  for (const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile", width: 390, height: 844 },
  ] as const) {
    test(`unknown admin route renders the shared not-found shell on ${viewport.name} @admin-cross-cutting`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      test.skip(
        skipDeployedAdminE2e,
        "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
      );

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await authenticateAdmin(page, "/access/accounts", "/access/sign-in");

      const response = await page.goto("/access/admin-cross-cutting-topology-smoke-missing-route", {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });

      // React Router renders the shared root ErrorBoundary client-side for an unmatched route;
      // the document response itself must never be a host-level static 404/HTML fallback.
      expect(response?.status() ?? 0, "unknown admin route should not be a host-level failure").toBeLessThan(500);
      await expect(page.getByRole("heading", { name: "Admin page not found" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("link", { name: "Go to admin home" })).toBeVisible();

      // The technical detail disclosure must never render a raw stack trace or bare object dump;
      // any thrown detail routes through the same redaction the root ErrorBoundary applies.
      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toMatch(/\bat\s+\S+\s+\(.*:\d+:\d+\)/);
    });
  }

  test("mobile shell has no horizontal overflow on the admin landing route @admin-cross-cutting", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await authenticateAdmin(page, "/access/accounts", "/access/sign-in");
    await expectPageOk(page, "/access/accounts");

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `mobile admin shell should not overflow horizontally (scrollWidth=${overflow.scrollWidth}, clientWidth=${overflow.clientWidth})`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});
