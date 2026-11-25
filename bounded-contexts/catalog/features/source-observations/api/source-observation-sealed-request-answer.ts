import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  SealedAnswerReceipt,
  TcgplayerSealedRequestAnswer,
} from "../../operator-session/api/sealed-product-observations";
import { OperatorSessionRequestError } from "../../operator-session/api/request";
import { sealedAnswerLimits } from "../../operator-session/domain/extension/sealed-products/answer-contract";
import {
  sealedProductLines,
  type TcgplayerSealedProductObservationPost,
} from "../../operator-session/domain/extension/sealed-products/contract";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import type { SourceObservationIntegrationJobScope } from "./source-observation-runtime-contracts";

const conflict = (code: string) => new OperatorSessionRequestError(code, 409);

export async function discardSealedRequestPayloads(db: PgQueryable, requestId: string) {
  await db.query("UPDATE catalog_sealed_request_parts SET post = NULL WHERE request_id = $1 AND post IS NOT NULL", [
    requestId,
  ]);
}

export async function hasSealedRequestParts(db: PgQueryable, requestId: string) {
  const result = await db.query("SELECT 1 FROM catalog_sealed_request_parts WHERE request_id = $1 LIMIT 1", [
    requestId,
  ]);
  return result.rows.length !== 0;
}

export async function replaySealedRequestPart(db: PgQueryable, requestId: string, partIndex: number, digest: string) {
  const prior = (
    await db.query<{ digest: string }>(
      "SELECT digest FROM catalog_sealed_request_parts WHERE request_id = $1 AND part_index = $2",
      [requestId, partIndex],
    )
  ).rows[0];
  if (!prior) return null;
  if (prior.digest !== digest) throw conflict("observation-part-conflict");
  return { kind: "part" as const, partIndex };
}

// Caller holds the request row lock and its transaction, including admission and settlement.
export async function admitSealedRequestAnswer(
  db: PgQueryable,
  input: Parameters<TcgplayerSealedRequestAnswer>[0],
  digest: string,
  scope: SourceObservationIntegrationJobScope,
  mapping: ProviderScopeMappingRow,
): Promise<SealedAnswerReceipt> {
  const { requestId, answer } = input;
  if (answer.kind === "part") {
    const { post, partIndex } = answer;
    const line = sealedProductLines().find((line) => String(line.id) === scope.productLineId);
    if (
      !line ||
      post.products.some(
        (product) =>
          product.productLineId !== line.id ||
          product.productLineName !== line.name ||
          String(product.setId) !== scope.setId ||
          product.setName !== scope.setName,
      )
    )
      throw conflict("observation-set-mismatch");
    const byteCount = Buffer.byteLength(input.text);
    const productIds = post.products.map(({ productId }) => productId);
    const staged = (
      await db.query<{ bytes: number; products: number; overlaps: boolean | null }>(
        `SELECT COALESCE(sum(byte_count), 0)::int AS bytes,
              COALESCE(sum(cardinality(product_ids)), 0)::int AS products,
              bool_or(product_ids && $2::integer[]) AS overlaps
         FROM catalog_sealed_request_parts WHERE request_id = $1`,
        [requestId, productIds],
      )
    ).rows[0]!;
    if (staged.overlaps) throw conflict("observation-product-duplicate");
    if (
      staged.bytes + byteCount > sealedAnswerLimits.maxBytes ||
      staged.products + productIds.length > sealedAnswerLimits.maxProducts
    )
      throw new OperatorSessionRequestError("observation-answer-too-large", 413);
    await db.query(
      `INSERT INTO catalog_sealed_request_parts (request_id, part_index, digest, byte_count, product_ids, post)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [requestId, partIndex, digest, byteCount, productIds, JSON.stringify(post)],
    );
    return { kind: "part", partIndex };
  }
  if (answer.kind === "failure") {
    if (await hasSealedRequestParts(db, requestId)) throw conflict("observation-manifest-mismatch");
    return answer;
  }
  const { rows } = await db.query<{ part_index: number; digest: string; post: TcgplayerSealedProductObservationPost }>(
    "SELECT part_index, digest, post FROM catalog_sealed_request_parts WHERE request_id = $1 ORDER BY part_index",
    [requestId],
  );
  if (
    rows.length !== answer.partDigests.length ||
    rows.some((row, index) => row.part_index !== index || row.digest !== answer.partDigests[index]) ||
    rows.reduce((sum, row) => sum + row.post.products.length, 0) !== answer.productCount ||
    rows.some((row) => row.post.observedAt !== rows[0]!.post.observedAt)
  )
    throw conflict("observation-manifest-mismatch");
  const result = rows.length
    ? await input.record(
        db,
        {
          ...rows[0]!.post,
          products: rows.flatMap((row) => row.post.products),
        },
        mapping,
      )
    : { recorded: 0, changed: 0, unchanged: 0, candidateCount: 0, exclusions: [] };
  await discardSealedRequestPayloads(db, requestId);
  return { kind: "complete", productCount: answer.productCount, verifiedEmpty: answer.verifiedEmpty, ...result };
}
