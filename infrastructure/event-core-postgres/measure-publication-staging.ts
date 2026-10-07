import {
  assembleProductMeasurePublication,
  assertProductMeasurePublicationIdentity,
  parseProductMeasurePublicationCompletion,
  parseProductMeasurePublicationPart,
  productMeasurePublicationCompleted,
  productMeasurePublicationPartRecorded,
  ProductMeasurePublicationError,
  type ProductMeasurePublicationEvent,
} from "@chase-sets/product-measures";
import { resolveProjectionDb, type ProjectorHandler, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "./types";

export async function stageProductMeasurePublicationPart(
  db: PgQueryable,
  checkpointKey: string,
  event: ProductMeasurePublicationEvent,
): Promise<void> {
  const data = parseProductMeasurePublicationPart(event.data);
  assertProductMeasurePublicationIdentity(event, data.catalogItemId);
  const result = await db.query(
    `INSERT INTO event_projection_measure_publication_parts (checkpoint_key, stream_id, stream_version, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (checkpoint_key, stream_id, stream_version) DO UPDATE
       SET payload = EXCLUDED.payload
       WHERE event_projection_measure_publication_parts.payload = EXCLUDED.payload
     RETURNING stream_version`,
    [checkpointKey, event.streamId, event.streamVersion, JSON.stringify(data)],
  );
  if (result.rows.length !== 1) throw new ProductMeasurePublicationError("conflicting staged part");
}

export async function purgeProductMeasurePublicationParts(
  db: PgQueryable,
  checkpointKey: string,
  event: Pick<ProductMeasurePublicationEvent, "streamId" | "streamVersion">,
): Promise<void> {
  await db.query(
    `DELETE FROM event_projection_measure_publication_parts
     WHERE checkpoint_key = $1 AND stream_id = $2 AND stream_version <= $3`,
    [checkpointKey, event.streamId, event.streamVersion],
  );
}

export async function takeProductMeasurePublication(
  db: PgQueryable,
  checkpointKey: string,
  event: ProductMeasurePublicationEvent,
) {
  const data = parseProductMeasurePublicationCompletion(event.data);
  assertProductMeasurePublicationIdentity(event, data.catalogItemId);
  const result = await db.query<{ stream_version: string | number; payload: unknown }>(
    `SELECT stream_version, payload FROM event_projection_measure_publication_parts
     WHERE checkpoint_key = $1 AND stream_id = $2 AND stream_version >= $3 AND stream_version < $4
     ORDER BY stream_version`,
    [checkpointKey, event.streamId, event.streamVersion - data.partCount, event.streamVersion],
  );
  const products = await assembleProductMeasurePublication(
    event,
    result.rows.map((row) => ({
      streamId: event.streamId,
      streamVersion: Number(row.stream_version),
      data: row.payload,
    })),
  );
  await purgeProductMeasurePublicationParts(db, checkpointKey, event);
  return { catalogItemId: data.catalogItemId, products };
}

export async function resetProductMeasurePublicationParts(db: PgQueryable, checkpointKey: string): Promise<void> {
  await db.query(`DELETE FROM event_projection_measure_publication_parts WHERE checkpoint_key = $1`, [checkpointKey]);
}

// All operations use the consumer's projection transaction, including replacement and patches.
export function buildProductMeasurePublicationHandlers(
  db: PgQueryable,
  checkpointKey: string,
  replace: ProjectorHandler,
): ProjectorHandlerMap {
  return {
    [productMeasurePublicationPartRecorded]: async (event, context) => {
      await stageProductMeasurePublicationPart(resolveProjectionDb(context, db), checkpointKey, event);
    },
    [productMeasurePublicationCompleted]: async (event, context) => {
      const data = await takeProductMeasurePublication(resolveProjectionDb(context, db), checkpointKey, event);
      await replace({ ...event, data }, context);
    },
    "catalog.catalog-item.product-measures-resolved": async (event, context) => {
      await purgeProductMeasurePublicationParts(resolveProjectionDb(context, db), checkpointKey, event);
      await replace(event, context);
    },
  };
}
