import { expect, it } from "vitest";
import { createCheckpointKey } from "@chase-sets/bounded-context-runtime";
import { stageProductMeasurePublicationPart, type PgQueryable } from "@chase-sets/event-core-postgres";
import {
  syntheticPublication,
  withMeasurePublicationStaging,
} from "@chase-sets/event-core-postgres/measure-publication-test-support";
import { module, contextManifest } from "../../../index";
import { withCheckoutProductMeasurePublicationReset } from "../integrations/marketplace/marketplace-projection";

it("purges only the listing-options checkpoint before truncating its owned tables", async () => {
  const statements: string[] = [];
  const serving: PgQueryable = {
    async query() {
      return { rows: [] };
    },
  };
  const staging = withMeasurePublicationStaging(serving);
  const recording: PgQueryable = {
    query(sql: string, values?: readonly unknown[]) {
      statements.push(sql);
      return staging.db.query(sql, values);
    },
  };
  const listing = module
    .buildProjectionGroups()
    .find((group) => group.projectionName === "checkout-marketplace-listing-options-projection")!;
  const checkpoints = [listing.projectionName, "checkout-catalog-item-projection"].map((name) =>
    createCheckpointKey(
      contextManifest.eventSubscriptions.find(
        (subscription) => subscription.sourceContextName === "catalog" && subscription.projectionName === name,
      )!,
    ),
  );
  const publication = await syntheticPublication();
  for (const checkpoint of checkpoints) {
    await stageProductMeasurePublicationPart(staging.db, checkpoint, publication.parts[0]!);
  }

  await listing.reset!.execute(recording);
  expect(staging.staged().map((row) => row.checkpoint)).toEqual([checkpoints[1]]);
  expect(statements).toEqual([
    "DELETE FROM event_projection_measure_publication_parts WHERE checkpoint_key = $1",
    "TRUNCATE TABLE checkout_marketplace_seller_options, checkout_marketplace_seller_availability",
  ]);

  statements.length = 0;
  const replayOnly = withCheckoutProductMeasurePublicationReset({ ...listing, resetStrategy: "replay-only" });
  await replayOnly.reset!.execute(recording);
  expect(statements).toEqual(["DELETE FROM event_projection_measure_publication_parts WHERE checkpoint_key = $1"]);
  expect(staging.staged().map((row) => row.checkpoint)).toEqual([checkpoints[1]]);
});
