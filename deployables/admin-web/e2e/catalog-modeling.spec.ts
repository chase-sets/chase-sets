import { expect, test, type Page } from "@playwright/test";
import {
  authenticateAdmin,
  expectAdminPageReady,
  expectAdminWebHydrated,
  expectPageOk,
  skipDeployedAdminE2e,
} from "./support/admin-e2e";

type CatalogAuthoringStreamProbeResult = Readonly<{
  status: number;
  contentType: string;
  textStart: string;
  error: string | null;
}>;

async function probeCatalogAuthoringStreamEndpoint(
  page: Page,
  path: string,
): Promise<CatalogAuthoringStreamProbeResult> {
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

function expectControlledCatalogAuthoringStreamProbe(path: string, result: CatalogAuthoringStreamProbeResult) {
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

const catalogModelingSurfaces = [
  { path: "/catalog/fields", heading: "Fields", createButton: "New Field", dialogHeading: "Create Field" },
  {
    path: "/catalog/components",
    heading: "Components",
    createButton: "New Component",
    dialogHeading: "Create Component",
  },
  {
    path: "/catalog/blueprints",
    heading: "Blueprints",
    createButton: "New Blueprint",
    dialogHeading: "Create Blueprint",
  },
  {
    path: "/catalog/categories",
    heading: "Categories",
    createButton: "New Category",
    dialogHeading: "Create Category",
  },
  {
    path: "/catalog/catalog-items",
    heading: "Catalog Items",
    createButton: "New Catalog Item",
    dialogHeading: "Create Catalog Item",
  },
  {
    path: "/catalog/display-templates",
    heading: "Display Templates",
    createButton: "New Display Template",
    dialogHeading: "Create Display Template",
  },
  {
    path: "/catalog/reference-types",
    heading: "Reference Types",
    createButton: "New Reference Type",
    dialogHeading: "Create Reference Type",
  },
  {
    path: "/catalog/reference-records",
    heading: "Reference Records",
    createButton: "New Reference Record",
    dialogHeading: "Create Reference Record",
  },
] as const;

test.describe("catalog admin modeling", () => {
  test("catalog authoring job streams open or fail with controlled JSON responses @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/dimensions", "/access/sign-in");
    await expectPageOk(page, "/catalog/dimensions");

    const path = "/api/catalog/bulk-authoring-jobs/topology-smoke/events";
    expectControlledCatalogAuthoringStreamProbe(path, await probeCatalogAuthoringStreamEndpoint(page, path));
  });

  test("signed-in catalog operator can inspect dimensions and open the create model dialog @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/dimensions", "/access/sign-in");
    await expectPageOk(page, "/catalog/dimensions");
    await expect(page).toHaveURL(/\/catalog\/dimensions(?:\?|$)/);
    await expectAdminPageReady(page, { heading: "Dimensions" });

    await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Status" })).toBeVisible();
    await page.getByRole("button", { name: /More filters/ }).click();
    await expect(page.getByRole("combobox", { name: "Value kind" })).toBeVisible();
    await page.getByRole("button", { name: "Close filters" }).click();
    await expect(page.locator('a[href="/catalog/dimensions"]').first()).toHaveAttribute("aria-current", "page");

    await page.getByRole("button", { name: "New Dimension" }).click();
    await expect(page.getByRole("heading", { name: "Create Dimension" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Key" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Description" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Value kind" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Create Dimension" })).toHaveCount(0);

    const firstViewLink = page.getByRole("link", { name: "View" }).first();
    if (await firstViewLink.count()) {
      await firstViewLink.click();
      await expect(page).toHaveURL(/\/catalog\/dimensions\/[^/?]+(?:\?|$)/);
      await expectAdminWebHydrated(page);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText("Options").first()).toBeVisible();
      await expect(page.getByText("Value kind").first()).toBeVisible();
      await expect(page.getByText("Dimensions").first()).toBeVisible();
    }
  });

  test("signed-in catalog operator can inspect remaining modeling surfaces @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/fields", "/access/sign-in");

    for (const surface of catalogModelingSurfaces) {
      await expectPageOk(page, surface.path);
      await expect(page).toHaveURL(new RegExp(`${surface.path.replace(/\//g, "\\/")}(?:\\?|$)`));
      await expectAdminPageReady(page, { heading: surface.heading });
      await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
      await expect(page.locator(`a[href="${surface.path}"]`).first()).toHaveAttribute("aria-current", "page");

      await page.getByRole("button", { name: surface.createButton }).click();
      await expect(page.getByRole("heading", { name: surface.dialogHeading })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("heading", { name: surface.dialogHeading })).toHaveCount(0);
    }
  });

  test("signed-in catalog operator creates and activates a draft dimension @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    const uniqueSuffix = Date.now().toString(36);
    const dimensionKey = `e2e-dimension-${uniqueSuffix}`;
    const dimensionName = `E2E Dimension ${uniqueSuffix}`;

    await authenticateAdmin(page, "/catalog/dimensions", "/access/sign-in");
    await expectPageOk(page, "/catalog/dimensions");
    await expectAdminPageReady(page, { heading: "Dimensions" });

    await page.getByRole("button", { name: "New Dimension" }).click();
    await expect(page.getByRole("heading", { name: "Create Dimension" })).toBeVisible();
    await page.getByRole("textbox", { name: "Key" }).fill(dimensionKey);
    await page.getByRole("textbox", { name: "Name" }).fill(dimensionName);
    await page.getByRole("textbox", { name: "Description" }).fill("Created by admin catalog modeling E2E.");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: "Create Dimension" })).toHaveCount(0);

    const row = await waitForDimensionRow(page, dimensionKey);
    await row.getByRole("link", { name: "View" }).click();
    await expect(page).toHaveURL(/\/catalog\/dimensions\/dim_[^/?]+(?:\?|$)/);
    await expectAdminWebHydrated(page);
    await expect(page.getByRole("heading", { name: dimensionName })).toBeVisible();
    await expectDimensionStatus(page, "draft");

    await page.getByRole("button", { name: "Activate" }).click();
    await expectDimensionStatus(page, "active");
  });
});

async function waitForDimensionRow(page: Page, dimensionKey: string) {
  const search = page.getByRole("textbox", { name: "Search" });
  const row = page.getByRole("row").filter({ hasText: dimensionKey }).first();
  await expect
    .poll(
      async () => {
        await search.fill(dimensionKey).catch(() => undefined);
        if (await row.isVisible().catch(() => false)) {
          return true;
        }

        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        await expectAdminWebHydrated(page).catch(() => undefined);
        return row.isVisible().catch(() => false);
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 60_000 },
    )
    .toBe(true);

  return row;
}

async function expectDimensionStatus(page: Page, status: "active" | "draft") {
  await expect
    .poll(
      async () => {
        const visible = await page
          .getByText(status, { exact: true })
          .first()
          .isVisible()
          .catch(() => false);
        if (visible) {
          return true;
        }

        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        await expectAdminWebHydrated(page).catch(() => undefined);
        return page
          .getByText(status, { exact: true })
          .first()
          .isVisible()
          .catch(() => false);
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 60_000 },
    )
    .toBe(true);
}
