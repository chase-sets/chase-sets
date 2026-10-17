import { catalogIntegrationSeedRequirements } from "@chase-sets/catalog/server";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { describe, expect, it } from "vitest";
import { createPlatformApiBootstrapTestHarness } from "./bootstrap-db-test-support";
import {
  assignCatalogSeedState,
  profileShapes,
  pools,
  prepareCatalog,
  catalogServices,
  ordinaryBoot,
  expectInterruptionSiteResumes,
  countEventType,
} from "./catalog-seed-test-support";

createPlatformApiBootstrapTestHarness("platform_api_catalog_seed_interruption_resume", assignCatalogSeedState, {
  activeContextNames: ["catalog"],
});

describe("Catalog integration aggregate-state seed", () => {
  it("resumes after Dimensions under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("dimensions");
  });

  it("resumes after Fields under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("fields");
  });

  it("resumes after Reference Data under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("reference-data");
  });

  it("resumes after Components under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("components");
  });

  it("resumes after Blueprints under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("blueprints");
  });

  it("resumes after the final Category under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("categories");
  });

  it("resumes mid catalog.component.created under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("mid-component-created");
  });

  it("keeps the required aggregate set equal to the base aggregate streams authored by the seed", async () => {
    const runtime = await prepareCatalog();
    await ordinaryBoot(runtime, profileShapes[0]);
    const createdTypes = [
      "catalog.dimension.created",
      "catalog.field.created",
      "catalog.reference-type.created",
      "catalog.reference-record.created",
      "catalog.component.created",
      "catalog.blueprint.created",
      "catalog.category.created",
    ];
    const result = await pools.catalog.query<Readonly<{ stream_id: string }>>(
      `SELECT DISTINCT stream_id
       FROM event_store_events
       WHERE event_type = ANY($1::text[])
       ORDER BY stream_id`,
      [createdTypes],
    );
    expect(result.rows.map(({ stream_id }) => stream_id)).toEqual(
      catalogIntegrationSeedRequirements.map(({ streamId }) => streamId).sort(),
    );
  });

  it("preserves duplicate CreateDimension rejection through the non-seed command handler", async () => {
    const runtime = await prepareCatalog();
    await ordinaryBoot(runtime, profileShapes[0]);
    const services = catalogServices(runtime);
    const streamId = `catalog.dimension-${catalogSeedIds.dimensions.form.dimensionId}`;
    const before = await countEventType(streamId, "catalog.dimension.created");
    await expect(
      services.dimensions.commandHandler({
        streamId,
        command: {
          type: "CreateDimension",
          dimensionId: catalogSeedIds.dimensions.form.dimensionId,
          key: "form",
          name: { defaultLocale: "en", values: { en: "Form" } },
          description: { defaultLocale: "en", values: { en: "Duplicate authoring control" } },
          valueKind: "unordered",
        },
        context: {
          tenantId: "tnt_catalog_seed_test",
          audit: {
            performedByUserId: "usr_catalog_seed_test",
            forAccountId: "acc_catalog_seed_test",
          },
        } as never,
      }),
    ).rejects.toThrow("Dimension has already been created.");
    expect(await countEventType(streamId, "catalog.dimension.created")).toBe(before);
  });
});
