import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { canonicalPromotionReferenceText } from "./promotion-reference-canonicalization";
import type { PromotionReferenceKey } from "./promotion-target-identity";
import {
  promotionReferenceExpressions as expressions,
  promotionReferencePredicates as predicates,
  readPromotionReferenceAccessPathReadiness,
} from "./promotion-target-indexes";

export async function requirePromotionTargetIndexes(db: PgQueryable): Promise<void> {
  const readiness = await readPromotionReferenceAccessPathReadiness(db);
  if (!readiness.ready) throw new Error(`promotion-target-access-paths-unavailable:${readiness.failures.join(",")}`);
}

export async function locatePromotionReferenceStreams(
  db: PgQueryable,
  key: PromotionReferenceKey,
): Promise<readonly string[]> {
  const providerKey = canonicalPromotionReferenceText(key.providerKey);
  const externalKey = canonicalPromotionReferenceText(key.externalKey);
  const queries = [
    {
      predicate: predicates[key.level],
      match: `${expressions.providerKey} = $1 AND ${expressions.externalKey} = $2`,
      values: [providerKey, externalKey],
    },
    {
      predicate: predicates.source,
      match: `${expressions.sourcePairs} @> $1::jsonb`,
      values: [
        JSON.stringify({
          [key.level === "item" ? "externalCatalogItemReferences" : "externalProductReferences"]: [
            { providerKey, externalKey },
          ],
        }),
      ],
    },
    ...(key.level === "product"
      ? [
          {
            predicate: predicates.source,
            match: `${expressions.providerKey} = $1 AND ${expressions.sourceLink} = $2`,
            values: [providerKey, externalKey],
          },
        ]
      : []),
  ];
  const streams = new Set<string>();
  for (const query of queries) {
    let after = "";
    for (;;) {
      const page = await db.query<{ stream_id: string }>(
        `SELECT DISTINCT stream_id FROM event_store_events WHERE ${query.predicate} AND ${query.match}
         AND stream_id > $${query.values.length + 1} ORDER BY stream_id LIMIT 500`,
        [...query.values, after],
      );
      if (page.rows.length > 500) throw new Error("promotion-target-invalid-page");
      for (const row of page.rows) {
        if (typeof row.stream_id !== "string" || row.stream_id <= after)
          throw new Error("promotion-target-invalid-page");
        after = row.stream_id;
        streams.add(after);
        if (streams.size > 10000) throw new Error("promotion-target-discovery-budget-exceeded");
      }
      if (page.rows.length < 500) break;
    }
  }
  return [...streams];
}
