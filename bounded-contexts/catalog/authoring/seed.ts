import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCatalogServices } from "./services";
import { seedBlueprints } from "./blueprints/seed";
import { seedCatalogItems } from "./catalog-items/seed";
import { seedCategories } from "./categories/seed";
import { seedComponents } from "./components/seed";
import { seedDimensions } from "./dimensions/seed";
import { seedFields } from "./fields/seed";
import { drainProjectors } from "./seed-support";

export async function seedCatalogDatabase(pool: PgTransactionalPool) {
  const services = createCatalogServices(pool);

  try {
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

    const components = await seedComponents(services, dimensions, fields);
    const blueprints = await seedBlueprints(
      services,
      components,
      dimensions,
      fields,
    );
    const categories = await seedCategories(services);
    await seedCatalogItems(services, blueprints, fields, categories);
    await drainProjectors("catalog", services.projectors);

    console.log("\nSeed complete!");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}


