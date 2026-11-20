import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  seedChangedSourceObservationScenario,
  seedPromotedSourceObservationScenario,
} from "../../features/source-observations/api/seed";
import { seedCatalogDatabase } from "./seed";
import { createCatalogServices } from "./services";

vi.mock("@chase-sets/bounded-context-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/bounded-context-runtime")>()),
  drainLocalProjectionHandlerSets: vi.fn(),
}));
vi.mock("../../features/blueprints/api/seed", () => ({ seedBlueprints: vi.fn() }));
vi.mock("../../features/catalog-items/api/seed", () => ({ seedCatalogItems: vi.fn() }));
vi.mock("../../features/categories/api/seed", () => ({ seedCategories: vi.fn() }));
vi.mock("../../features/components/api/seed", () => ({ seedComponents: vi.fn() }));
vi.mock("../../features/dimensions/api/seed", () => ({ seedDimensions: vi.fn() }));
vi.mock("../../features/display-templates/api/seed", () => ({
  areDisplayTemplateSeedProjectionsCurrent: vi.fn(() => true),
  seedDisplayTemplates: vi.fn(),
}));
vi.mock("../../features/fields/api/seed", () => ({ seedFields: vi.fn(() => ({})) }));
vi.mock("../../features/product-measures/api/seed", () => ({ seedProductMeasures: vi.fn() }));
vi.mock("../../features/product-contents/api/seed", () => ({
  seedProductContentConfiguration: vi.fn(),
  seedProductContentScenario: vi.fn(),
}));
vi.mock("../../features/reference-data/api/seed", () => ({ seedReferenceData: vi.fn() }));
vi.mock("../../features/source-observations/api/provider-integration-profile-store", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../features/source-observations/api/provider-integration-profile-store")
  >()),
  seedCatalogProviderIntegrationProfileVersions: vi.fn(),
}));
vi.mock("../../features/source-observations/api/seed", () => ({
  seedChangedSourceObservationScenario: vi.fn(),
  seedPromotedSourceObservationScenario: vi.fn(),
}));
vi.mock("../seed-support/catalog-integration-state", () => ({
  assertCatalogIntegrationSeedComplete: vi.fn(),
  catalogIntegrationSeedRequirements: [],
}));

describe("Catalog scenario seed caller", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["staging", 0],
    ["production", 0],
    ["test", 1],
  ])(
    "with scenario-seed in %s, runs the promoted writer and invokes the changed writer %i times",
    async (environmentName, changedCalls) => {
      const pool: PgTransactionalPool = {
        query: vi.fn(async (sql: string) => ({
          rows: sql.includes("AS dependency_kind")
            ? [
                { dependency_kind: "reference", key: "expansion" },
                { dependency_kind: "reference", key: "set" },
              ]
            : [],
        })) as PgTransactionalPool["query"],
        connect: async () => {
          throw new Error("Scenario caller test must not open a database connection.");
        },
      };
      const services = createCatalogServices(pool);

      await seedCatalogDatabase(pool, services, { enabledDataProfiles: ["scenario-seed"], environmentName });

      expect(seedPromotedSourceObservationScenario).toHaveBeenCalledExactlyOnceWith(services);
      expect(seedChangedSourceObservationScenario).toHaveBeenCalledTimes(changedCalls);
    },
  );
});
