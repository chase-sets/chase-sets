import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { CatalogItemId, CategoryId } from "../../../ids";
import { createCatalogAuthoringPersistence } from "../../../support/authoring-support/services";
import { createPostgresPromotionTargetExclusion } from "../api/promotion/promotion-target-exclusion";

export async function assignSyntheticPromotionCategory(
  pool: PgTransactionalPool,
  consumerPool: PgTransactionalPool,
  catalogItemId: CatalogItemId,
  categoryId: CategoryId,
  context: EventStoreContext,
) {
  const boundary = createPostgresPromotionTargetExclusion({
    pool,
    eventStore: createCatalogAuthoringPersistence(pool, consumerPool),
  });
  const session = await boundary.acquire({
    keys: [],
    additionalTargetIds: [catalogItemId],
    context,
    validateAuthority: async () => undefined,
    selectTarget: async () => catalogItemId,
  });
  const command = { type: "AssignCatalogItemToCategory" as const, categoryId };
  await session.preparePlan({
    catalogItemId,
    mode: "refresh",
    commands: [command],
    planFingerprint: "synthetic-category",
  });
  return session.commandHandler({ streamId: `catalog.item-${catalogItemId}`, command, context });
}
