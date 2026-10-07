import { expect, it } from "vitest";
import { createCheckpointKey } from "@chase-sets/bounded-context-runtime";
import { stageProductMeasurePublicationPart, type PgQueryable } from "@chase-sets/event-core-postgres";
import {
  syntheticPublication,
  withMeasurePublicationStaging,
} from "@chase-sets/event-core-postgres/measure-publication-test-support";
import { catalogProductMeasureSubscription } from "./runtime";
import { module } from "../../../index";

it("preserves Catalog's implicit defaults and no-context serving rows when resetting staging", async () => {
  const servingRows = [{ productId: "no-context-product" }];
  const queries: string[] = [];
  const db: PgQueryable = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("TRUNCATE")) servingRows.length = 0;
      return { rows: [] };
    },
  };
  const staging = withMeasurePublicationStaging(db);
  const publication = await syntheticPublication();
  await stageProductMeasurePublicationPart(
    staging.db,
    createCheckpointKey(catalogProductMeasureSubscription),
    publication.parts[0]!,
  );
  const group = module
    .buildProjectionGroups()
    .find((candidate) => candidate.projectionName === catalogProductMeasureSubscription.projectionName)!;
  expect(group).toMatchObject({
    projectionRevision: 1,
    sourceContextNames: ["catalog"],
    ownedTables: [],
    requiredDuringBootstrap: false,
  });
  expect(group.resetStrategy).toBeUndefined();
  await group.reset!.execute(staging.db);
  expect(staging.staged()).toEqual([]);
  expect(queries).toEqual([]);
  expect(servingRows).toEqual([{ productId: "no-context-product" }]);
});
