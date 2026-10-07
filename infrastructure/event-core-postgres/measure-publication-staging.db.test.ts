import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProductMeasurePublicationError } from "@chase-sets/product-measures";
import { createIsolatedPostgresTestSchema, type IsolatedPostgresTestSchema } from "./postgres-db-test-support";
import {
  purgeProductMeasurePublicationParts,
  resetProductMeasurePublicationParts,
  stageProductMeasurePublicationPart,
  takeProductMeasurePublication,
} from "./measure-publication-staging";
import { syntheticPublication } from "./measure-publication-test-support";
import { withPgTransaction } from "./types";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for measure publication staging DB tests.");

describe("Product Measure Publication staging in real Postgres", () => {
  let schema: IsolatedPostgresTestSchema;
  beforeAll(async () => {
    schema = await createIsolatedPostgresTestSchema(adminDatabaseUrl, "measure_publication");
    await schema.pool.query(
      "CREATE TABLE synthetic_measure_serving_control (id integer PRIMARY KEY, publication jsonb NOT NULL)",
    );
  });
  beforeEach(async () => {
    await schema.reset();
    await schema.pool.query(
      "INSERT INTO synthetic_measure_serving_control VALUES (1, '\"prior-complete\"') ON CONFLICT (id) DO UPDATE SET publication = EXCLUDED.publication",
    );
  });
  afterAll(async () => {
    await schema?.close();
  });

  const rows = async () =>
    (
      await schema.pool.query(
        "SELECT checkpoint_key, stream_id, stream_version, payload FROM event_projection_measure_publication_parts ORDER BY checkpoint_key, stream_id, stream_version",
      )
    ).rows;

  it("commits parts separately, restages idempotently, and takes only the complete contiguous set", async () => {
    const publication = await syntheticPublication();
    for (const part of publication.parts) {
      await withPgTransaction(schema.pool, (db) =>
        stageProductMeasurePublicationPart(db, "synthetic-checkpoint-a", part),
      );
      await withPgTransaction(schema.pool, (db) =>
        stageProductMeasurePublicationPart(db, "synthetic-checkpoint-a", part),
      );
    }
    await stageProductMeasurePublicationPart(schema.pool, "synthetic-checkpoint-b", publication.parts[0]!);
    const taken = await withPgTransaction(schema.pool, (db) =>
      takeProductMeasurePublication(db, "synthetic-checkpoint-a", publication.completion),
    );
    expect(taken.products).toEqual(publication.products);
    expect(await rows()).toMatchObject([{ checkpoint_key: "synthetic-checkpoint-b" }]);
  });

  it.each(["missing", "index", "count", "digest", "duplicate-product"])(
    "rejects %s without deleting staged data or mutating prior serving state",
    async (corruption) => {
      const publication = await syntheticPublication();
      for (const [index, part] of publication.parts.entries()) {
        if (corruption === "missing" && index === 1) continue;
        const data =
          corruption === "index" && index === 1
            ? { ...part.data, partIndex: 0 }
            : corruption === "duplicate-product" && index === 1
              ? { ...part.data, products: publication.parts[0]!.data.products }
              : part.data;
        await withPgTransaction(schema.pool, (db) =>
          stageProductMeasurePublicationPart(db, "synthetic-checkpoint", { ...part, data }),
        );
      }
      const before = await rows();
      const completion = {
        ...publication.completion,
        data: {
          ...publication.completion.data,
          ...(corruption === "count" ? { productCount: 86 } : {}),
          ...(corruption === "digest" ? { productsDigest: "0".repeat(64) } : {}),
        },
      };
      await expect(
        withPgTransaction(schema.pool, async (db) => {
          const complete = await takeProductMeasurePublication(db, "synthetic-checkpoint", completion);
          await db.query("UPDATE synthetic_measure_serving_control SET publication = $1::jsonb WHERE id = 1", [
            JSON.stringify(complete.products),
          ]);
        }),
      ).rejects.toBeInstanceOf(ProductMeasurePublicationError);
      expect(
        (await schema.pool.query("SELECT publication FROM synthetic_measure_serving_control WHERE id = 1")).rows,
      ).toEqual([{ publication: "prior-complete" }]);
      expect(await rows()).toEqual(before);
    },
  );

  it("rejects conflicting redelivery and rolls back take when the serving replacement fails", async () => {
    const publication = await syntheticPublication();
    for (const part of publication.parts)
      await stageProductMeasurePublicationPart(schema.pool, "synthetic-checkpoint", part);
    const before = await rows();
    await expect(
      stageProductMeasurePublicationPart(schema.pool, "synthetic-checkpoint", {
        ...publication.parts[0]!,
        data: { ...publication.parts[0]!.data, partIndex: 9 },
      }),
    ).rejects.toBeInstanceOf(ProductMeasurePublicationError);
    expect(await rows()).toEqual(before);
    await expect(
      withPgTransaction(schema.pool, async (db) => {
        await takeProductMeasurePublication(db, "synthetic-checkpoint", publication.completion);
        await db.query("SELECT 1 / 0");
      }),
    ).rejects.toThrow();
    expect(await rows()).toEqual(before);
  });

  it("purges only prior versions for legacy replacement and resets only the owning checkpoint for replay", async () => {
    const publication = await syntheticPublication();
    for (const checkpoint of ["synthetic-checkpoint-a", "synthetic-checkpoint-b"]) {
      for (const part of publication.parts) await stageProductMeasurePublicationPart(schema.pool, checkpoint, part);
    }
    await purgeProductMeasurePublicationParts(schema.pool, "synthetic-checkpoint-a", publication.parts[0]!);
    expect((await rows()).filter((row) => row.checkpoint_key === "synthetic-checkpoint-a")).toHaveLength(2);
    await withPgTransaction(schema.pool, (db) => resetProductMeasurePublicationParts(db, "synthetic-checkpoint-a"));
    expect(await rows()).toHaveLength(3);
    expect((await rows()).every((row) => row.checkpoint_key === "synthetic-checkpoint-b")).toBe(true);
    for (const part of publication.parts)
      await stageProductMeasurePublicationPart(schema.pool, "synthetic-checkpoint-a", part);
    expect(
      (await takeProductMeasurePublication(schema.pool, "synthetic-checkpoint-a", publication.completion)).products,
    ).toEqual(publication.products);
    await schema.reset();
    expect(await rows()).toEqual([]);
  });
});
