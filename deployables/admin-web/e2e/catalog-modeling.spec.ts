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

type CatalogCommandResponse = Readonly<{
  id: string;
  status: string;
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
    activeHref: "/catalog/reference-records",
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
      const activeHref = "activeHref" in surface ? surface.activeHref : surface.path;
      await expect(page.locator(`a[href="${activeHref}"]`).first()).toHaveAttribute("aria-current", "page");

      await page.getByRole("button", { name: surface.createButton }).click();
      await expect(page.getByRole("heading", { name: surface.dialogHeading })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("heading", { name: surface.dialogHeading })).toHaveCount(0);
    }
  });

  test("signed-in catalog operator creates, inspects, and removes a draft catalog item @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    const uniqueSuffix = Date.now().toString(36);
    const description = `Created by admin catalog item E2E ${uniqueSuffix}`;
    let catalogItemId: string | null = null;

    await authenticateAdmin(page, "/catalog/catalog-items", "/access/sign-in");

    try {
      await expectCatalogItemListControls(page);

      await page.getByRole("button", { name: "New Catalog Item" }).click();
      await expect(page.getByRole("heading", { name: "Create Catalog Item" })).toBeVisible();
      await page.getByRole("textbox", { name: "Description" }).fill(description);

      const [createResponse] = await Promise.all([
        page.waitForResponse(
          (candidate) =>
            candidate.request().method() === "POST" &&
            candidate.url().includes("/api/catalog/catalog-items") &&
            candidate.status() === 201,
        ),
        page.getByRole("button", { name: "Create" }).click(),
      ]);
      const createBody = (await createResponse.json()) as CatalogCommandResponse;
      catalogItemId = createBody.id;

      expect(catalogItemId).toMatch(/^cat_/);
      expect(createBody.status).toBe("draft");
      await expect(page.getByRole("heading", { name: "Create Catalog Item" })).toHaveCount(0);

      const row = await waitForCatalogItemRow(page, catalogItemId);
      await expect(row.getByRole("link", { name: "View" })).toBeVisible();

      await page.goto(`/catalog/catalog-items/${catalogItemId}`, { waitUntil: "domcontentloaded" });
      await expectAdminPageReady(page, { heading: catalogItemId });
      await expect(page.getByText(description).first()).toBeVisible();
      await expect(page.getByText("draft", { exact: true }).first()).toBeVisible();

      for (const section of [
        "Origin",
        "Blueprint",
        "Field Values",
        "Categories",
        "Tags",
        "Image URLs",
        "Image Fallback",
        "External Catalog Item References",
        "External Product References",
      ]) {
        await expect(page.getByText(section, { exact: true }).first()).toBeVisible();
      }

      for (const action of [
        "Edit Description",
        "Assign Blueprint",
        "Set Field Value",
        "Assign Category",
        "Set Tags",
        "Set Image URLs",
        "Set Image Fallback",
        "Link External Catalog Item Reference",
        "Link External Reference",
      ]) {
        await expect(page.getByRole("button", { name: action }).first()).toBeVisible();
      }

      await removeDraftCatalogItemThroughList(page, catalogItemId);
      catalogItemId = null;
    } finally {
      if (catalogItemId) {
        await removeDraftCatalogItemFallback(page, catalogItemId);
      }
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

  test("signed-in catalog operator inspects reference data records and types @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/reference-records", "/access/sign-in");
    await expectReferenceRecordListAndDetail(page);
    await expectReferenceTypeListAndDetail(page);
  });
});

async function expectCatalogItemListControls(page: Page) {
  await expectPageOk(page, "/catalog/catalog-items");
  await expectAdminPageReady(page, { heading: "Catalog Items" });
  await expect(page.locator('a[href="/catalog/catalog-items"]').first()).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Status" })).toBeVisible();

  await page.getByRole("button", { name: /More filters/ }).click();
  for (const label of [
    "Language",
    "Source",
    "Blueprint ID",
    "Tag",
    "Blueprint",
    "Has images",
    "Has source references",
    "Missing required fields",
  ]) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Close filters" }).click();
}

async function removeDraftCatalogItemThroughList(page: Page, catalogItemId: string) {
  await page.goto(`/catalog/catalog-items?search=${encodeURIComponent(catalogItemId)}&status=draft`, {
    waitUntil: "domcontentloaded",
  });
  await waitForCatalogItemRow(page, catalogItemId);
  await page.getByLabel(`Select row ${catalogItemId}`).click();
  await page.getByRole("button", { name: "Remove drafts from selected" }).click();

  const dialog = page.getByRole("dialog", { name: "Remove draft Catalog Items" });
  await expect(dialog).toBeVisible();
  const [deleteResponse] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "DELETE" &&
        candidate.url().includes(`/api/catalog/catalog-items/${catalogItemId}`),
    ),
    dialog.getByRole("button", { name: "Remove drafts from selected" }).click(),
  ]);
  expect(deleteResponse.status(), "remove draft catalog item response should be successful").toBeLessThan(400);

  await expect
    .poll(
      async () => {
        await page
          .getByRole("textbox", { name: "Search" })
          .fill(catalogItemId)
          .catch(() => undefined);
        const stillVisible = await page
          .getByRole("row")
          .filter({ hasText: catalogItemId })
          .first()
          .isVisible()
          .catch(() => false);
        if (!stillVisible) {
          return false;
        }

        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        await expectAdminWebHydrated(page).catch(() => undefined);
        return page
          .getByRole("row")
          .filter({ hasText: catalogItemId })
          .first()
          .isVisible()
          .catch(() => false);
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 45_000 },
    )
    .toBe(false);
}

async function removeDraftCatalogItemFallback(page: Page, catalogItemId: string) {
  const origin = new URL(page.url()).origin;
  await page.request.delete(`${origin}/api/catalog/catalog-items/${catalogItemId}`).catch(() => undefined);
}

async function expectReferenceRecordListAndDetail(page: Page) {
  await expectPageOk(page, "/catalog/reference-records");
  await expectAdminPageReady(page, { heading: "Reference Records" });
  await expect(page.locator('a[href="/catalog/reference-records"]').first()).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Status" })).toBeVisible();
  await page.getByRole("button", { name: /More filters/ }).click();
  await expect(page.getByRole("combobox", { name: "Reference type" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Relationship" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Attribute key" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Attribute value" })).toBeVisible();
  await page.getByRole("button", { name: "Close filters" }).click();

  const row = await firstVisibleRowForSeed(page, ["The First Chapter", "Romance Dawn", "Time Spiral", "Base Set"]);
  await row.getByRole("link", { name: "View" }).click();
  await expect(page).toHaveURL(/\/catalog\/reference-records\/[^/?]+(?:\?|$)/);
  await expectAdminWebHydrated(page);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Type").first()).toBeVisible();
  await expect(page.getByText("Key").first()).toBeVisible();
  await expect(page.getByText("Attributes").first()).toBeVisible();
  await expect(page.getByText("Relationships").first()).toBeVisible();
  await expect(page.getByText("Status").first()).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: "Edit Reference Record" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Reference type" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Key", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Attributes", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Edit Reference Record" })).toHaveCount(0);
}

async function expectReferenceTypeListAndDetail(page: Page) {
  await expectPageOk(page, "/catalog/reference-types");
  await expectAdminPageReady(page, { heading: "Reference Types" });
  await expect(page.locator('a[href="/catalog/reference-records"]').first()).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Status" })).toBeVisible();
  await page.getByRole("button", { name: /More filters/ }).click();
  await expect(page.getByRole("textbox", { name: "Attribute key" })).toBeVisible();
  await page.getByRole("button", { name: "Close filters" }).click();

  const row = await firstVisibleRowForSeed(page, ["Set", "Expansion", "Series", "Product Line"]);
  await row.getByRole("link", { name: "View" }).click();
  await expect(page).toHaveURL(/\/catalog\/reference-types\/[^/?]+(?:\?|$)/);
  await expectAdminWebHydrated(page);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Attribute keys").first()).toBeVisible();
  await expect(page.getByText("Status").first()).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: "Edit Reference Type" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Key", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Attribute Keys", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Edit Reference Type" })).toHaveCount(0);
}

async function firstVisibleRowForSeed(page: Page, seedLabels: readonly string[]) {
  for (const label of seedLabels) {
    const row = page.getByRole("row").filter({ hasText: label }).first();
    if (await row.isVisible().catch(() => false)) {
      return row;
    }
  }

  const fallbackRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: "View" }) })
    .first();
  await expect(fallbackRow).toBeVisible({ timeout: 60_000 });
  return fallbackRow;
}

async function waitForCatalogItemRow(page: Page, catalogItemId: string) {
  const search = page.getByRole("textbox", { name: "Search" });
  const row = page.getByRole("row").filter({ hasText: catalogItemId }).first();
  await expect
    .poll(
      async () => {
        await search.fill(catalogItemId).catch(() => undefined);
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
