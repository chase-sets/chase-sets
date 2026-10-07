import { expect } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  digestProductMeasures,
  productMeasurePublicationCompleted,
  productMeasurePublicationPartRecorded,
  ProductMeasurePublicationError,
  type ProductMeasureSnapshot,
} from "@chase-sets/product-measures";
import type { PgQueryable } from "./types";

export function syntheticMeasures(count = 85, catalogItemId = "cat_1"): ProductMeasureSnapshot[] {
  return Array.from({ length: count }, (_, index) => ({
    catalogItemId,
    productId: index === count - 1 ? "prd_1" : `synthetic-product-${index}`,
    selectedOptions: [{ dimensionId: "synthetic-finish", optionId: String(index) }],
    measureVersion: "synthetic-publication:v2",
    unitLengthInches: 3,
    unitWidthInches: 2,
    unitHeightInches: 0.1,
    unitWeightOunces: index + 1,
    physicalFlags: ["raw-card"],
    stackBehavior: "stackable-thickness",
    source: "profile",
    confidence: "measured",
  }));
}

export function measureEvent(type: string, streamVersion: number, data: Record<string, unknown>): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `synthetic-measure-${data.catalogItemId}-${streamVersion}`,
    streamId: `catalog.product-measures-${data.catalogItemId}`,
    streamVersion,
    globalPosition: String(streamVersion),
  });
}

export async function syntheticPublication(products = syntheticMeasures(), startVersion = 2, catalogItemId = "cat_1") {
  const parts: TransportEvent[] = [];
  for (let index = 0; index < Math.max(products.length, 1); index += 30) {
    parts.push(
      measureEvent(productMeasurePublicationPartRecorded, startVersion + parts.length, {
        catalogItemId,
        partIndex: parts.length,
        products: products.slice(index, index + 30),
      }),
    );
  }
  const completion = measureEvent(productMeasurePublicationCompleted, startVersion + parts.length, {
    catalogItemId,
    partCount: parts.length,
    productCount: products.length,
    productsDigest: await digestProductMeasures(products),
  });
  return { parts, completion, products };
}

type StagedRow = { checkpoint: string; stream: string; version: number; payload: unknown };

// Only the shared staging SQL is simulated here; each consumer owns its serving-table fake.
export function withMeasurePublicationStaging(serving: PgQueryable) {
  let rows: StagedRow[] = [];
  const db: PgQueryable = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      if (!sql.includes("event_projection_measure_publication_parts")) return serving.query<Row>(sql, values);
      const [checkpoint, stream, version, payload] = values;
      const owned = (row: StagedRow) => row.checkpoint === checkpoint && row.stream === stream;
      if (sql.trimStart().startsWith("INSERT")) {
        const existing = rows.find((row) => owned(row) && row.version === version);
        const parsed = JSON.parse(String(payload));
        if (existing && JSON.stringify(existing.payload) !== JSON.stringify(parsed)) return { rows: [] as Row[] };
        if (!existing)
          rows.push({
            checkpoint: String(checkpoint),
            stream: String(stream),
            version: Number(version),
            payload: parsed,
          });
        return { rows: [{ stream_version: version }] as Row[] };
      }
      if (sql.trimStart().startsWith("SELECT")) {
        return {
          rows: rows
            .filter((row) => owned(row) && row.version >= Number(version) && row.version < Number(payload))
            .map((row) => ({ stream_version: row.version, payload: row.payload })) as Row[],
        };
      }
      if (sql.trimStart().startsWith("DELETE")) {
        rows = rows.filter(
          (row) =>
            !(row.checkpoint === checkpoint && (values.length === 1 || (owned(row) && row.version <= Number(version)))),
        );
        return { rows: [] as Row[] };
      }
      throw new Error(`Unexpected staging SQL: ${sql}`);
    },
  };
  return {
    db,
    staged: () => structuredClone(rows),
    transaction: async (work: () => Promise<void>) => {
      const prior = structuredClone(rows);
      try {
        await work();
      } catch (error) {
        rows = prior;
        throw error;
      }
    },
  };
}

export async function assertMeasurePublicationConsumer(input: {
  handlers: ProjectorHandlerMap;
  staging: ReturnType<typeof withMeasurePublicationStaging>;
  visible: () => unknown;
  assertProducts: (products: readonly ProductMeasureSnapshot[]) => void;
}) {
  const { handlers, staging } = input;
  const apply = (event: TransportEvent) => staging.transaction(() => handlers[event.type]!(event, { db: staging.db }));
  const visible = () => JSON.stringify(input.visible());
  const prior = syntheticMeasures(1).map((product) => ({ ...product, measureVersion: "synthetic-prior:v1" }));
  await apply(
    measureEvent("catalog.catalog-item.product-measures-resolved", 1, { catalogItemId: "cat_1", products: prior }),
  );
  input.assertProducts(prior);
  const before = visible();
  const publication = await syntheticPublication();
  const unrelated = await syntheticPublication(syntheticMeasures(1, "cat_other"), 2, "cat_other");
  for (const [index, part] of publication.parts.entries()) {
    await apply(part);
    await apply(part); // Delivery retry is idempotent.
    expect(visible()).toBe(before);
    if (index === 0) {
      await apply(unrelated.parts[0]!);
      await expect(apply(publication.completion)).rejects.toBeInstanceOf(ProductMeasurePublicationError);
      expect(visible()).toBe(before);
    }
  }
  const staged = staging.staged();
  for (const corruption of [{ productCount: 86 }, { productsDigest: "0".repeat(64) }]) {
    await expect(
      apply({ ...publication.completion, data: { ...publication.completion.data, ...corruption } }),
    ).rejects.toBeInstanceOf(ProductMeasurePublicationError);
    expect(visible()).toBe(before);
    expect(staging.staged()).toEqual(staged);
  }
  await apply(publication.completion);
  input.assertProducts(publication.products);
  expect(staging.staged()).toHaveLength(1);
  expect(staging.staged()[0]!.stream).toBe(unrelated.completion.streamId);

  const interrupted = await syntheticPublication(publication.products, 6);
  const afterComplete = visible();
  await apply(interrupted.parts[0]!);
  expect(visible()).toBe(afterComplete);
  await apply(
    measureEvent("catalog.catalog-item.product-measures-resolved", 7, { catalogItemId: "cat_1", products: prior }),
  );
  input.assertProducts(prior);
  expect(staging.staged()).toHaveLength(1);
  const empty = await syntheticPublication([], 8);
  const beforeEmpty = visible();
  await apply(empty.parts[0]!);
  expect(visible()).toBe(beforeEmpty);
  await apply(empty.completion);
  input.assertProducts([]);
  expect(staging.staged()).toHaveLength(1);
}
