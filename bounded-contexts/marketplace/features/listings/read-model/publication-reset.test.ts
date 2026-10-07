import { expect, it } from "vitest";
import { createCheckpointKey } from "@chase-sets/bounded-context-runtime";
import { stageProductMeasurePublicationPart, type PgQueryable } from "@chase-sets/event-core-postgres";
import {
  syntheticPublication,
  withMeasurePublicationStaging,
} from "@chase-sets/event-core-postgres/measure-publication-test-support";
import { module, contextManifest } from "../../../index";

it("resets Marketplace staging independently while preserving Listing owned-table truncation", async () => {
  const queries: string[] = [];
  const db: PgQueryable = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [] };
    },
  };
  const staging = withMeasurePublicationStaging(db);
  const groups = module.buildProjectionGroups();
  const publication = await syntheticPublication();
  for (const name of ["marketplace-catalog-item-projection", "marketplace-listing-projection"]) {
    const subscription = contextManifest.eventSubscriptions.find(
      (candidate) => candidate.sourceContextName === "catalog" && candidate.projectionName === name,
    )!;
    await stageProductMeasurePublicationPart(staging.db, createCheckpointKey(subscription), publication.parts[0]!);
  }
  const listing = groups.find((group) => group.projectionName === "marketplace-listing-projection")!;
  await listing.reset!.execute(staging.db);
  expect(queries).toEqual([`TRUNCATE TABLE ${listing.ownedTables.join(", ")}`]);
  expect(staging.staged()).toHaveLength(1);
  const catalog = groups.find((group) => group.projectionName === "marketplace-catalog-item-projection")!;
  expect(staging.staged()[0]!.checkpoint).toBe(
    createCheckpointKey(
      contextManifest.eventSubscriptions.find((candidate) => candidate.projectionName === catalog.projectionName)!,
    ),
  );
  await catalog.reset!.execute(staging.db);
  expect(staging.staged()).toEqual([]);
  expect(queries).toHaveLength(1);
});
