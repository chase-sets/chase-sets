import { expect, test, type APIResponse, type Page, type Response as PlaywrightResponse } from "@playwright/test";
import {
  authenticateAdmin,
  expectAdminPageReady,
  expectAdminWebHydrated,
  expectPageOk,
  skipDeployedAdminE2e,
  waitForProjectionPositionFromResponse,
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

type CatalogItemListApiItem = Readonly<{
  catalog_item_id: string;
  status: string;
  title: string;
}>;

type CatalogItemListApiResponse = Readonly<{
  items: readonly CatalogItemListApiItem[];
  total: number;
  count: number;
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
      // A successfully-opened (200) probe never reads the event-stream body, so the
      // connection would otherwise stay open (and keep leasing a slot against the
      // shared per-account realtime stream budget, see resolveRealtimeConnectionKey)
      // until this page is torn down. Abort proactively so the lease releases
      // immediately instead of lingering into the next probe/test.
      controller.abort("stream probe complete");
    }
  }, path);
}

function expectControlledCatalogAuthoringStreamProbe(path: string, result: CatalogAuthoringStreamProbeResult) {
  expect(result.error, `${path} should resolve headers before the probe timeout`).toBeNull();
  if (result.status === 200) {
    expect(result.contentType, `${path} should open as an event stream`).toContain("text/event-stream");
    return;
  }

  expect([401, 403, 404, 429, 503], `${path} should return a controlled JSON response`).toContain(result.status);
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

test.describe.serial("catalog admin modeling", () => {
  test("catalog authoring realtime streams open or fail with controlled JSON responses @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/dimensions", "/access/sign-in");
    await expectPageOk(page, "/catalog/dimensions");

    for (const path of [
      "/api/catalog/bulk-authoring-jobs/topology-smoke/events",
      "/api/realtime/public/events?topic=catalog%3Aadmin%3Acatalog-items",
    ]) {
      // The shared realtime/durable-job stream limiters key leases per account
      // (or per client address) with a small per-key budget. A lease from a
      // just-torn-down page/test can take a moment to release server-side, so a
      // probe can transiently observe a saturated budget (429/503) immediately
      // after another admin-web test closes. Re-probe within a settle window
      // instead of asserting on a single point-in-time snapshot: this keeps the
      // check real (still requires a genuine open stream or a genuine controlled
      // JSON error) while not racing the lease-release teardown.
      await expect(async () => {
        expectControlledCatalogAuthoringStreamProbe(path, await probeCatalogAuthoringStreamEndpoint(page, path));
      }).toPass({ intervals: [250, 500, 1_000, 2_000], timeout: 15_000 });
    }
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
    await expect(firstViewLink, "browser-e2e seed contract requires a seeded dimension").not.toHaveCount(0);
    await firstViewLink.click();
    await expect(page).toHaveURL(/\/catalog\/dimensions\/[^/?]+(?:\?|$)/);
    await expectAdminWebHydrated(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Options").first()).toBeVisible();
    await expect(page.getByText("Value kind").first()).toBeVisible();
    await expect(page.getByText("Dimensions").first()).toBeVisible();
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

  test("signed-in catalog operator can inspect modeling primitive detail affordances @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await authenticateAdmin(page, "/catalog/fields", "/access/sign-in");

    await expectFieldDetail(page);
    await expectComponentDetail(page);
    await expectBlueprintDetail(page);
    await expectDisplayTemplateDetail(page);
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
            candidate.url().includes("/api/catalog/items") &&
            candidate.status() === 201,
        ),
        page.getByRole("button", { name: "Create" }).click(),
      ]);
      const createBody = (await createResponse.json()) as CatalogCommandResponse;
      catalogItemId = createBody.id;

      expect(catalogItemId).toMatch(/^cat_/);
      expect(createBody.status).toBe("draft");
      await expect(page.getByRole("heading", { name: "Create Catalog Item" })).toHaveCount(0);

      await waitForCatalogItemAdminProjection(page, createResponse, `create draft catalog item ${catalogItemId}`);

      const row = await waitForCatalogItemRow(page, catalogItemId);
      await expect(row.getByRole("link", { name: "View" })).toBeVisible();

      await page.goto(`/catalog/catalog-items/${catalogItemId}`, { waitUntil: "domcontentloaded" });
      await expectAdminPageReady(page, { heading: catalogItemId });
      await expect(page.getByText(description).first()).toBeVisible();
      await expect(page.getByText("draft", { exact: true }).first()).toBeVisible();

      for (const section of [
        "Blueprint",
        "Field Values",
        "Categories",
        "Tags",
        "Image URLs",
        "External Catalog Item References",
        "External Product References",
      ]) {
        await expect(page.getByText(section, { exact: true }).first()).toBeVisible();
      }

      for (const action of ["Edit Description", "Assign Blueprint", "Set Field Value", "Assign Category"]) {
        await expect(page.getByRole("button", { name: action }).first()).toBeVisible();
      }

      for (const disclosure of [
        "Tags",
        "Image URLs",
        "Image Fallback",
        "External Catalog Item References",
        "External Product References",
      ]) {
        await page.getByRole("button", { name: new RegExp(`^${disclosure}\\b`, "i") }).click();
      }

      for (const action of [
        "Set Tags",
        "Set Image URLs",
        "Set image fallback",
        "Link Catalog Item Reference",
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
    test.setTimeout(240_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    const uniqueSuffix = Date.now().toString(36);
    const dimensionKey = `e2e-dimension-${uniqueSuffix}`;
    const dimensionName = `E2E Dimension ${uniqueSuffix}`;
    let dimensionId: string | null = null;
    let dimensionActivated = false;

    await authenticateAdmin(page, "/catalog/dimensions", "/access/sign-in");
    await expectPageOk(page, "/catalog/dimensions");
    await expectAdminPageReady(page, { heading: "Dimensions" });

    try {
      await page.getByRole("button", { name: "New Dimension" }).click();
      await expect(page.getByRole("heading", { name: "Create Dimension" })).toBeVisible();
      await page.getByRole("textbox", { name: "Key" }).fill(dimensionKey);
      await page.getByRole("textbox", { name: "Name" }).fill(dimensionName);
      await page.getByRole("textbox", { name: "Description" }).fill("Created by admin catalog modeling E2E.");
      const [createResponse] = await Promise.all([
        page.waitForResponse(
          (candidate) =>
            candidate.request().method() === "POST" &&
            candidate.url().includes("/api/catalog/dimensions") &&
            candidate.status() === 201,
        ),
        page.getByRole("button", { name: "Create" }).click(),
      ]);
      const createBody = (await createResponse.json()) as CatalogCommandResponse;
      dimensionId = createBody.id;
      expect(createBody.id).toMatch(/^dim_/);
      expect(createBody.status).toBe("draft");
      await expect(page.getByRole("heading", { name: "Create Dimension" })).toHaveCount(0);

      await waitForDimensionAdminProjection(page, createResponse, `create draft dimension ${createBody.id}`);
      const row = await waitForDimensionRow(page, dimensionKey);
      await row.getByRole("link", { name: "View" }).click();
      await expect(page).toHaveURL(/\/catalog\/dimensions\/dim_[^/?]+(?:\?|$)/);
      await expectAdminWebHydrated(page);
      await expect(page.getByRole("heading", { name: dimensionName })).toBeVisible();
      await expectDimensionStatus(page, "draft");

      // Dimension options: add, revise, reorder, deprecate, reactivate.
      await page.getByRole("button", { name: "Add Option" }).click();
      await expect(page.getByRole("heading", { name: "Add Option" })).toBeVisible();
      await page.getByRole("textbox", { name: "Code", exact: true }).fill("red");
      await page.getByRole("textbox", { name: "Locale" }).fill("en");
      await page.getByRole("textbox", { name: "Label" }).fill("Red");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Add Option" })).toHaveCount(0);
      const redRow = page.getByRole("row").filter({ hasText: "red" }).first();
      await expect(redRow).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: "Add Option" }).click();
      await page.getByRole("textbox", { name: "Code", exact: true }).fill("blue");
      await page.getByRole("textbox", { name: "Locale" }).fill("en");
      await page.getByRole("textbox", { name: "Label" }).fill("Blue");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      const blueRow = page.getByRole("row").filter({ hasText: "blue" }).first();
      await expect(blueRow).toBeVisible({ timeout: 30_000 });

      // Revise the "red" option's code.
      await redRow.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Edit Option" })).toBeVisible();
      const editOptionCode = page.getByRole("textbox", { name: "Code", exact: true });
      await editOptionCode.fill("");
      await editOptionCode.fill("crimson");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Edit Option" })).toHaveCount(0);
      const crimsonRow = page.getByRole("row").filter({ hasText: "crimson" }).first();
      await expect(crimsonRow).toBeVisible({ timeout: 30_000 });

      // Reorder options (round-trips through the comma-separated option-id form).
      await page.getByRole("button", { name: "Reorder" }).click();
      await expect(page.getByRole("heading", { name: "Reorder Options" })).toBeVisible();
      const reorderInput = page.getByRole("textbox", { name: "Option IDs" });
      const currentOrder = (await reorderInput.inputValue())
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      await reorderInput.fill([...currentOrder].reverse().join(", "));
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Reorder Options" })).toHaveCount(0);

      // Deprecate then reactivate the "crimson" option.
      await crimsonRow.getByRole("button", { name: "Deprecate", exact: true }).click();
      await expect(crimsonRow.getByRole("button", { name: "Reactivate", exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await crimsonRow.getByRole("button", { name: "Reactivate", exact: true }).click();
      await expect(crimsonRow.getByRole("button", { name: "Deprecate", exact: true })).toBeVisible({
        timeout: 30_000,
      });

      const [activateResponse] = await Promise.all([
        page.waitForResponse(
          (candidate) =>
            candidate.request().method() === "POST" &&
            candidate.url().includes(`/api/catalog/dimensions/${createBody.id}/activate`) &&
            candidate.status() === 200,
        ),
        page.getByRole("button", { name: "Activate" }).click(),
      ]);
      const activateBody = (await activateResponse.json()) as CatalogCommandResponse;
      expect(activateBody.id).toBe(createBody.id);
      expect(activateBody.status).toBe("active");
      dimensionActivated = true;
      await waitForDimensionAdminProjection(page, activateResponse, `activate dimension ${createBody.id}`);
      await expectDimensionStatus(page, "active");
    } finally {
      if (dimensionId && dimensionActivated) {
        const deprecateResponse = await page.request.post(
          `${apiOrigin(page)}/api/catalog/dimensions/${dimensionId}/deprecate`,
        );
        expect(deprecateResponse.status(), `deprecate dimension ${dimensionId} should return 200`).toBe(200);
        await waitForDimensionAdminProjection(page, deprecateResponse, `deprecate dimension ${dimensionId}`);

        const archiveResponse = await page.request.post(
          `${apiOrigin(page)}/api/catalog/dimensions/${dimensionId}/archive`,
        );
        expect(archiveResponse.status(), `archive dimension ${dimensionId} should return 200`).toBe(200);
        await waitForDimensionAdminProjection(page, archiveResponse, `archive dimension ${dimensionId}`);

        // Archive is terminal: no further lifecycle transition is accepted.
        const rearchiveResponse = await page.request.post(
          `${apiOrigin(page)}/api/catalog/dimensions/${dimensionId}/archive`,
        );
        expect(
          rearchiveResponse.status(),
          "archiving an already-archived dimension should be rejected as a controlled 400",
        ).toBe(400);

        const redeprecateResponse = await page.request.post(
          `${apiOrigin(page)}/api/catalog/dimensions/${dimensionId}/deprecate`,
        );
        expect(
          redeprecateResponse.status(),
          "deprecating an archived dimension should be rejected as a controlled 400",
        ).toBe(400);
      }
    }
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

  test("signed-in catalog operator creates and publishes a draft category through the full lifecycle @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    const uniqueSuffix = Date.now().toString(36);
    const categoryKey = `e2e-category-${uniqueSuffix}`;
    const categoryName = `E2E Category ${uniqueSuffix}`;
    let categoryId: string | null = null;
    let categoryPublished = false;

    await authenticateAdmin(page, "/catalog/categories", "/access/sign-in");
    await expectPageOk(page, "/catalog/categories");
    await expectAdminPageReady(page, { heading: "Categories" });

    try {
      await page.getByRole("button", { name: "New Category" }).click();
      await expect(page.getByRole("heading", { name: "Create Category" })).toBeVisible();
      await page.getByRole("textbox", { name: "Key", exact: true }).fill(categoryKey);
      await page.getByRole("textbox", { name: "Name", exact: true }).fill(categoryName);
      await page
        .getByRole("textbox", { name: "Description", exact: true })
        .fill("Created by admin catalog modeling E2E.");
      const [createResponse] = await Promise.all([
        page.waitForResponse(
          (candidate) =>
            candidate.request().method() === "POST" &&
            candidate.url().includes("/api/catalog/categories") &&
            candidate.status() === 201,
        ),
        page.getByRole("button", { name: "Create" }).click(),
      ]);
      const createBody = (await createResponse.json()) as CatalogCommandResponse;
      categoryId = createBody.id;
      expect(createBody.id).toMatch(/^ctg_/);
      expect(createBody.status).toBe("draft");
      await expect(page.getByRole("heading", { name: "Create Category" })).toHaveCount(0);

      await page.goto(`/catalog/categories/${categoryId}`, { waitUntil: "domcontentloaded" });
      await expectAdminWebHydrated(page);
      await expect(page.getByRole("heading", { name: categoryName })).toBeVisible();
      await expectDimensionStatus(page, "draft");

      // Edit structure while draft.
      await page.getByRole("button", { name: "Edit" }).click();
      await expect(page.getByRole("heading", { name: "Edit Category" })).toBeVisible();
      const editDisplayOrder = page.getByRole("textbox", { name: "Display Order", exact: true });
      await editDisplayOrder.fill("");
      await editDisplayOrder.fill("3");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Edit Category" })).toHaveCount(0);

      const [publishResponse] = await Promise.all([
        page.waitForResponse(
          (candidate) =>
            candidate.request().method() === "POST" &&
            candidate.url().includes(`/api/catalog/categories/${categoryId}/publish`) &&
            candidate.status() === 200,
        ),
        page.getByRole("button", { name: "Publish" }).click(),
      ]);
      const publishBody = (await publishResponse.json()) as CatalogCommandResponse;
      expect(publishBody.id).toBe(categoryId);
      expect(publishBody.status).toBe("active");
      categoryPublished = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expectAdminWebHydrated(page);
      await expectDimensionStatus(page, "active");
    } finally {
      if (categoryId && categoryPublished) {
        const deprecateResponse = await page.request.post(
          `${apiOrigin(page)}/api/catalog/categories/${categoryId}/deprecate`,
        );
        expect(deprecateResponse.status(), `deprecate category ${categoryId} should return 200`).toBe(200);

        const archiveResponse = await page.request.post(
          `${apiOrigin(page)}/api/catalog/categories/${categoryId}/archive`,
        );
        expect(archiveResponse.status(), `archive category ${categoryId} should return 200`).toBe(200);

        // Archive is terminal for categories as well.
        const rearchiveResponse = await page.request.post(
          `${apiOrigin(page)}/api/catalog/categories/${categoryId}/archive`,
        );
        expect(
          rearchiveResponse.status(),
          "archiving an already-archived category should be rejected as a controlled 400",
        ).toBe(400);
      }
    }
  });

  test("signed-in catalog operator submits a draft-only component field rule and confirms structure locks after activation @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    await expectComponentDraftOnlyRuleEditing(page);
  });

  test("signed-in catalog operator previews and confirms a bulk dimension lifecycle action @catalog-admin-modeling", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    test.skip(
      skipDeployedAdminE2e,
      "CATALOG_ADMIN_E2E_EMAIL and CATALOG_ADMIN_E2E_PASSWORD are required for deployed admin-web e2e.",
    );

    const uniqueSuffix = Date.now().toString(36);
    const dimensionIds: string[] = [];

    await authenticateAdmin(page, "/catalog/dimensions", "/access/sign-in");

    try {
      for (const label of ["one", "two"]) {
        const createResponse = await page.request.post(`${apiOrigin(page)}/api/catalog/dimensions`, {
          data: {
            dimensionId: `dim_${uniqueSuffix}-${label}`,
            key: `e2e-bulk-dimension-${label}-${uniqueSuffix}`,
            name: { defaultLocale: "en", values: { en: `E2E Bulk Dimension ${label} ${uniqueSuffix}` } },
            description: { defaultLocale: "en", values: { en: "Created by admin catalog modeling bulk E2E." } },
          },
        });
        expect(createResponse.status(), "create draft dimension for bulk lifecycle should return 201").toBe(201);
        const body = (await createResponse.json()) as CatalogCommandResponse;
        dimensionIds.push(body.id);
      }

      await page.goto(`/catalog/dimensions?search=${encodeURIComponent(uniqueSuffix)}`, {
        waitUntil: "domcontentloaded",
      });
      await expectAdminPageReady(page, { heading: "Dimensions" });
      await expect(page.getByRole("textbox", { name: "Search" })).toHaveValue(uniqueSuffix);

      for (const dimensionId of dimensionIds) {
        const checkbox = page.getByRole("checkbox", { name: `Select row ${dimensionId}` });
        await expect(checkbox).toBeVisible({ timeout: 30_000 });
        await checkbox.check();
      }

      await page.getByRole("combobox", { name: "Action" }).selectOption({ label: "Activate" });
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Bulk Activate Preview" })).toBeVisible();
      await expect(page.getByText(`${dimensionIds.length} ready`)).toBeVisible();

      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Bulk Activate Result" })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(`${dimensionIds.length} succeeded`)).toBeVisible();
      await page.getByRole("button", { name: "Close", exact: true }).click();
    } finally {
      for (const dimensionId of dimensionIds) {
        await page.request
          .post(`${apiOrigin(page)}/api/catalog/dimensions/${dimensionId}/deprecate`)
          .catch(() => undefined);
        await page.request
          .post(`${apiOrigin(page)}/api/catalog/dimensions/${dimensionId}/archive`)
          .catch(() => undefined);
      }
    }
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
    "Has Images",
    "Has Source References",
    "Missing Required Fields",
  ]) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Close filters" }).click();
}

async function expectFieldDetail(page: Page) {
  await openCatalogModelingDetail(page, {
    path: "/catalog/fields",
    heading: "Fields",
    seedLabels: ["Card Name", "Set", "Expansion"],
    detailUrl: /\/catalog\/fields\/[^/?]+(?:\?|$)/,
  });

  await expect(page.getByText("Value type").first()).toBeVisible();
  await expect(page.getByText("Filterable").first()).toBeVisible();
  await expect(page.getByText("Searchable").first()).toBeVisible();
  await expect(page.getByText("Sortable").first()).toBeVisible();
  await expect(page.getByText("Status").first()).toBeVisible();

  await page.getByRole("button", { name: "Configure" }).click();
  await expect(page.getByRole("heading", { name: "Configure Field" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Key", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Value type" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Configure Field" })).toHaveCount(0);
}

async function expectComponentDetail(page: Page) {
  await openCatalogModelingDetail(page, {
    path: "/catalog/components",
    heading: "Components",
    seedLabels: ["Single Card Identity", "Single Card Product Resolution", "Sealed Product Identity"],
    detailUrl: /\/catalog\/components\/[^/?]+(?:\?|$)/,
  });

  await expect(page.getByText("Field Rules", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Dimension Rules", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Status").first()).toBeVisible();

  // Seeded components are activated, so structure-editing affordances are locked (draft-only).
  await expect(page.getByText("active", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add Field Rule" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add Dimension Rule" })).toHaveCount(0);
}

async function expectComponentDraftOnlyRuleEditing(page: Page) {
  const uniqueSuffix = Date.now().toString(36);
  const componentKey = `e2e-component-${uniqueSuffix}`;
  let componentId: string | null = null;

  await authenticateAdmin(page, "/catalog/components", "/access/sign-in");

  try {
    const createResponse = await page.request.post(`${apiOrigin(page)}/api/catalog/components`, {
      data: {
        componentId: `cmp_${uniqueSuffix}`,
        key: componentKey,
        name: { defaultLocale: "en", values: { en: `E2E Component ${uniqueSuffix}` } },
        description: { defaultLocale: "en", values: { en: "Created by admin catalog modeling E2E." } },
      },
    });
    expect(createResponse.status(), "create draft component should return 201").toBe(201);
    const createBody = (await createResponse.json()) as CatalogCommandResponse;
    componentId = createBody.id;
    expect(componentId).toMatch(/^cmp_/);
    expect(createBody.status).toBe("draft");

    const fieldsResponse = await page.request.get(`${apiOrigin(page)}/api/catalog/fields?status=active&limit=1`);
    expect(fieldsResponse.status(), "listing active fields for the field-rule fixture should return 200").toBe(200);
    const fieldsBody = (await fieldsResponse.json()) as { items: readonly { field_id: string }[] };
    const fieldId = fieldsBody.items[0]?.field_id;
    expect(fieldId, "at least one seeded active field is required for this fixture").toBeTruthy();

    await page.goto(`/catalog/components/${componentId}`, { waitUntil: "domcontentloaded" });
    await expectAdminWebHydrated(page);
    await expectDimensionStatus(page, "draft");

    // Draft-only editing affordances are present while the component is still a draft: submit a real field rule.
    await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Field Rule" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Dimension Rule" })).toBeVisible();

    await page.getByRole("button", { name: "Add Field Rule" }).click();
    await expect(page.getByRole("heading", { name: "Add Field Rule" })).toBeVisible();
    await page.getByRole("textbox", { name: "Field ID" }).fill(fieldId as string);
    const [fieldRuleResponse] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" &&
          candidate.url().includes(`/api/catalog/components/${componentId}/field-rules`) &&
          candidate.status() === 201,
      ),
      page.getByRole("button", { name: "Add", exact: true }).click(),
    ]);
    expect(fieldRuleResponse.status()).toBe(201);
    await expect(page.getByRole("heading", { name: "Add Field Rule" })).toHaveCount(0);

    const componentAfterFieldRule = await page.request.get(`${apiOrigin(page)}/api/catalog/components/${componentId}`);
    const componentAfterFieldRuleBody = (await componentAfterFieldRule.json()) as {
      field_rules: readonly { fieldId: string }[];
    };
    expect(componentAfterFieldRuleBody.field_rules.some((rule) => rule.fieldId === fieldId)).toBe(true);

    const activateResponse = await page.request.post(
      `${apiOrigin(page)}/api/catalog/components/${componentId}/activate`,
    );
    expect(activateResponse.status(), `activate component ${componentId} should return 200`).toBe(200);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expectAdminWebHydrated(page);
    await expectDimensionStatus(page, "active");

    // Structure locks after publish: editing affordances disappear and the API rejects the change.
    await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add Field Rule" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add Dimension Rule" })).toHaveCount(0);

    const blockedFieldRuleResponse = await page.request.post(
      `${apiOrigin(page)}/api/catalog/components/${componentId}/field-rules`,
      { data: { fieldId: "fld_e2e_missing", required: false } },
    );
    expect(
      blockedFieldRuleResponse.status(),
      "adding a field rule to an active component should be rejected as a controlled 400",
    ).toBe(400);
    const blockedBody = (await blockedFieldRuleResponse.json()) as { error?: { message?: string } };
    expect(blockedBody.error?.message ?? "").toMatch(/draft/i);
  } finally {
    if (componentId) {
      await page.request
        .post(`${apiOrigin(page)}/api/catalog/components/${componentId}/deprecate`)
        .catch(() => undefined);
      await page.request
        .post(`${apiOrigin(page)}/api/catalog/components/${componentId}/archive`)
        .catch(() => undefined);
    }
  }
}

async function expectBlueprintDetail(page: Page) {
  await openCatalogModelingDetail(page, {
    path: "/catalog/blueprints",
    heading: "Blueprints",
    seedLabels: ["Pokemon Card Single", "Pokemon Sealed Product", "Magic Card Print"],
    detailUrl: /\/catalog\/blueprints\/[^/?]+(?:\?|$)/,
  });

  for (const section of ["Components", "Field Rules", "Dimension Rules", "Product Resolution Rules"]) {
    await expect(page.getByText(section, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText("Status").first()).toBeVisible();

  // The draft-only structure lock is a Component rule (see component-detail-page.tsx /
  // components domain): a Component's field/dimension rules freeze once it activates.
  // Blueprints are a distinct primitive and do NOT lock on activation — the blueprint
  // detail page keeps its "Edit" affordance for any non-archived blueprint
  // (blueprint-detail-page.tsx renders it when status !== "archived"). Seeded blueprints
  // are active, so confirm the status renders and the Edit dialog is still reachable.
  await expect(page.getByText("active", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: "Edit Blueprint" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Key", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Edit Blueprint" })).toHaveCount(0);
}

async function expectDisplayTemplateDetail(page: Page) {
  await openCatalogModelingDetail(page, {
    path: "/catalog/display-templates",
    heading: "Display Templates",
    seedLabels: ["Pokemon single card", "Magic card print", "Lorcana card print"],
    detailUrl: /\/catalog\/display-templates\/[^/?]+(?:\?|$)/,
  });

  for (const field of ["Target", "Priority", "Title template", "Subtitle template", "Required field keys", "Status"]) {
    await expect(page.getByText(field).first()).toBeVisible();
  }

  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: "Edit Display Template" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Key", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Target kind" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Title Template", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Edit Display Template" })).toHaveCount(0);
}

async function openCatalogModelingDetail(
  page: Page,
  config: Readonly<{
    path: string;
    heading: string;
    seedLabels: readonly string[];
    detailUrl: RegExp;
  }>,
) {
  await expectPageOk(page, config.path);
  await expectAdminPageReady(page, { heading: config.heading });

  const search = page.getByRole("textbox", { name: "Search" });
  await expect(search).toBeVisible();
  for (const seedLabel of config.seedLabels) {
    await search.fill(seedLabel);
    const row = page.getByRole("row").filter({ hasText: seedLabel }).first();
    if (await row.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await row.getByRole("link", { name: "View" }).click();
      await expect(page).toHaveURL(config.detailUrl);
      await expectAdminWebHydrated(page);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      return;
    }
  }

  await search.fill("");
  const fallbackRow = await firstVisibleRowForSeed(page, config.seedLabels);
  await fallbackRow.getByRole("link", { name: "View" }).click();
  await expect(page).toHaveURL(config.detailUrl);
  await expectAdminWebHydrated(page);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

async function removeDraftCatalogItemThroughList(page: Page, catalogItemId: string) {
  await waitForDraftCatalogItemReadModel(page, catalogItemId);
  await page.goto(`/catalog/catalog-items?search=${encodeURIComponent(catalogItemId)}&status=draft`, {
    waitUntil: "domcontentloaded",
  });
  await waitForCatalogItemRow(page, catalogItemId);
  const removeResponse = await removeDraftCatalogItemByApi(page, catalogItemId);
  await waitForCatalogItemAdminProjection(page, removeResponse, `remove draft catalog item ${catalogItemId}`);
  await waitForDraftCatalogItemReadModelRemoval(page, catalogItemId);

  await page.goto(`/catalog/catalog-items?search=${encodeURIComponent(catalogItemId)}&status=draft`, {
    waitUntil: "domcontentloaded",
  });
  await expectAdminPageReady(page, { heading: "Catalog Items" });
  await expect(page.getByRole("textbox", { name: "Search" })).toHaveValue(catalogItemId);
  await expect(page.getByRole("row").filter({ hasText: catalogItemId })).toHaveCount(0);
}

async function removeDraftCatalogItemFallback(page: Page, catalogItemId: string) {
  const response = await page.request.delete(`${apiOrigin(page)}/api/catalog/items/${catalogItemId}`).catch(() => null);
  if (response?.status() === 200) {
    await waitForCatalogItemAdminProjection(
      page,
      response,
      `fallback remove draft catalog item ${catalogItemId}`,
    ).catch(() => undefined);
    await waitForDraftCatalogItemReadModelRemoval(page, catalogItemId).catch(() => undefined);
  }
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
  await waitForDraftCatalogItemReadModel(page, catalogItemId);
  await page.goto(`/catalog/catalog-items?search=${encodeURIComponent(catalogItemId)}&status=draft`, {
    waitUntil: "domcontentloaded",
  });
  await expectAdminPageReady(page, { heading: "Catalog Items" });

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

async function removeDraftCatalogItemByApi(page: Page, catalogItemId: string) {
  const response = await page.request.delete(`${apiOrigin(page)}/api/catalog/items/${catalogItemId}`);
  expect(response.status(), `remove draft catalog item ${catalogItemId} should return 200`).toBe(200);

  const body = (await response.json()) as CatalogCommandResponse;
  expect(body.id).toBe(catalogItemId);
  expect(body.status).toBe("removed");
  return response;
}

async function waitForDraftCatalogItemReadModel(page: Page, catalogItemId: string) {
  await expect
    .poll(
      async () => {
        const item = await getDraftCatalogItemListEntry(page, catalogItemId);
        return item ? `${item.catalog_item_id}:${item.status}` : "missing";
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 90_000 },
    )
    .toBe(`${catalogItemId}:draft`);
}

async function waitForDraftCatalogItemReadModelRemoval(page: Page, catalogItemId: string) {
  await expect
    .poll(
      async () => {
        const listItem = await getDraftCatalogItemListEntry(page, catalogItemId);
        const detailStatus = await getCatalogItemDetailStatus(page, catalogItemId);
        return listItem === null && detailStatus === 404 ? "removed" : "present";
      },
      { intervals: [1_000, 2_000, 5_000], timeout: 90_000 },
    )
    .toBe("removed");
}

async function getDraftCatalogItemListEntry(page: Page, catalogItemId: string): Promise<CatalogItemListApiItem | null> {
  const query = new URLSearchParams({
    search: catalogItemId,
    status: "draft",
    limit: "5",
    offset: "0",
  });
  const response = await page.request.get(`${apiOrigin(page)}/api/catalog/items?${query.toString()}`);
  expect(response.status(), `catalog item list read model query should return 200`).toBe(200);

  const body = (await response.json()) as CatalogItemListApiResponse;
  return body.items.find((item) => item.catalog_item_id === catalogItemId) ?? null;
}

async function getCatalogItemDetailStatus(page: Page, catalogItemId: string) {
  const response = await page.request.get(`${apiOrigin(page)}/api/catalog/items/${catalogItemId}`);
  expect([200, 404], `catalog item detail read model query should return 200 or 404`).toContain(response.status());
  return response.status();
}

async function waitForCatalogItemAdminProjection(
  page: Page,
  response: APIResponse | PlaywrightResponse,
  label: string,
) {
  await waitForProjectionPositionFromResponse(page, response, {
    sourceContextName: "catalog",
    targetContextName: "catalog",
    projectionName: "catalog-admin-catalog-item-projection",
    label,
  });
}

async function waitForDimensionAdminProjection(page: Page, response: APIResponse | PlaywrightResponse, label: string) {
  await waitForProjectionPositionFromResponse(page, response, {
    sourceContextName: "catalog",
    targetContextName: "catalog",
    projectionName: "catalog-dimension-projection",
    label,
  });
}

function apiOrigin(page: Page) {
  return new URL(page.url()).origin;
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
