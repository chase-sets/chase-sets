import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import { OrderingDomainError, type OrderSourceType } from "../domain/common";

export type OrderSourceClaim = Readonly<{
  sourceType: OrderSourceType;
  sourceReferenceId: string;
  buyerAccountId: string;
  orderIds: readonly OrderId[];
  status: "pending" | "created";
}>;

type OrderSourceClaimRow = Readonly<{
  source_type: OrderSourceType;
  source_reference_id: string;
  buyer_account_id: string;
  order_ids: unknown;
  status: "pending" | "created";
}>;

function mapOrderSourceClaim(row: OrderSourceClaimRow): OrderSourceClaim {
  if (
    !Array.isArray(row.order_ids) ||
    row.order_ids.length === 0 ||
    row.order_ids.some((value) => typeof value !== "string" || value.trim() === "")
  ) {
    throw new Error("Order source claim must contain at least one valid order id.");
  }
  return {
    sourceType: row.source_type,
    sourceReferenceId: row.source_reference_id,
    buyerAccountId: row.buyer_account_id,
    orderIds: row.order_ids as OrderId[],
    status: row.status,
  };
}

export async function getOrderSourceClaim(
  db: PgQueryable,
  sourceType: OrderSourceType,
  sourceReferenceId: string,
): Promise<OrderSourceClaim | null> {
  const result = await db.query<OrderSourceClaimRow>(
    `SELECT source_type, source_reference_id, buyer_account_id, order_ids, status
     FROM ordering_order_source_claims
     WHERE source_type = $1
       AND source_reference_id = $2`,
    [sourceType, sourceReferenceId],
  );
  const row = result.rows[0];
  return row ? mapOrderSourceClaim(row) : null;
}

export async function claimOrderSource(
  db: PgQueryable,
  claim: Readonly<{
    sourceType: OrderSourceType;
    sourceReferenceId: string;
    buyerAccountId: string;
    orderIds: readonly OrderId[];
  }>,
): Promise<Readonly<{ outcome: "claimed" | "existing"; claim: OrderSourceClaim }>> {
  const inserted = await db.query<OrderSourceClaimRow>(
    `INSERT INTO ordering_order_source_claims (
       source_type,
       source_reference_id,
       buyer_account_id,
       order_ids,
       status,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4::jsonb, 'pending', now(), now())
     ON CONFLICT (source_type, source_reference_id) DO NOTHING
     RETURNING source_type, source_reference_id, buyer_account_id, order_ids, status`,
    [claim.sourceType, claim.sourceReferenceId, claim.buyerAccountId, JSON.stringify(claim.orderIds)],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) {
    return { outcome: "claimed", claim: mapOrderSourceClaim(insertedRow) };
  }

  const existing = await getOrderSourceClaim(db, claim.sourceType, claim.sourceReferenceId);
  if (!existing) {
    throw new Error("Order source claim conflict could not be resolved.");
  }
  if (existing.buyerAccountId !== claim.buyerAccountId) {
    throw new OrderingDomainError("Order source identity is already claimed by another buyer account.");
  }
  return { outcome: "existing", claim: existing };
}

export async function completeOrderSourceClaim(
  db: PgQueryable,
  claim: Pick<OrderSourceClaim, "sourceType" | "sourceReferenceId" | "buyerAccountId">,
  orderIds: readonly OrderId[],
) {
  const result = await db.query(
    `UPDATE ordering_order_source_claims
     SET order_ids = $4::jsonb,
         status = 'created',
         updated_at = now()
     WHERE source_type = $1
       AND source_reference_id = $2
       AND buyer_account_id = $3
       AND status = 'pending'`,
    [claim.sourceType, claim.sourceReferenceId, claim.buyerAccountId, JSON.stringify(orderIds)],
  );
  if (result.rowCount === 0) {
    const existing = await getOrderSourceClaim(db, claim.sourceType, claim.sourceReferenceId);
    if (
      existing?.status !== "created" ||
      existing.buyerAccountId !== claim.buyerAccountId ||
      JSON.stringify(existing.orderIds) !== JSON.stringify(orderIds)
    ) {
      throw new Error("Order source claim could not be completed.");
    }
  }
}

export async function releasePendingOrderSourceClaim(
  db: PgQueryable,
  claim: Pick<OrderSourceClaim, "sourceType" | "sourceReferenceId" | "buyerAccountId" | "orderIds">,
) {
  await db.query(
    `DELETE FROM ordering_order_source_claims
     WHERE source_type = $1
       AND source_reference_id = $2
       AND buyer_account_id = $3
       AND order_ids = $4::jsonb
       AND status = 'pending'`,
    [claim.sourceType, claim.sourceReferenceId, claim.buyerAccountId, JSON.stringify(claim.orderIds)],
  );
}
