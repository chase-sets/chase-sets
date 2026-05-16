import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCatalogServices } from "./services";
import { seedBlueprints } from "../../features/blueprints/api/seed";
import { seedCatalogItems } from "../../features/catalog-items/api/seed";
import { seedCategories } from "../../features/categories/api/seed";
import { seedComponents } from "../../features/components/api/seed";
import { seedDimensions } from "../../features/dimensions/api/seed";
import { seedFields } from "../../features/fields/api/seed";
import { seedReferenceData } from "../../features/reference-data/api/seed";
import { drainProjectors } from "../seed-support/context";

export async function seedCatalogDatabase(pool: PgTransactionalPool) {
  const services = createCatalogServices(pool);

  try {
    const existing = await services.db.query(
      "SELECT COUNT(*) FROM catalog_dimensions",
    );
    if (Number(existing.rows[0].count) > 0) {
      console.log("Catalog already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  console.log("Starting Pokemon TCG seed...\n");

  const [dimensions, fields] = await Promise.all([
    seedDimensions(services),
    seedFields(services),
  ]);

  const references = await seedReferenceData(services);
  const components = await seedComponents(services, dimensions, fields);
  const blueprints = await seedBlueprints(
    services,
    components,
    dimensions,
    fields,
  );
  const categories = await seedCategories(services);
  await seedCatalogItems(services, blueprints, fields, categories, references);
  await drainProjectors("catalog", services.projectors);

  console.log("\nSeed complete!");
}
