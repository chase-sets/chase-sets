import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import { OrderingDomainError, type OrderSourceType } from "../domain/common";
import { releasePurchaseLimitClaimsForFailedSource } from "./purchase-limits";
import {
  lockEvidenceWindowSourceIdentity,
  lockOpenEvidenceWindowSource,
  readEvidenceWindowSourceByIdentity,
  withOpenEvidenceWindowSource,
} from "./evidence-window-source-release";

export type OrderSourceClaim = Readonly<{
  sourceType: OrderSourceType;
  sourceReferenceId: string;
  buyerAccountId: string;
  orderIds: readonly OrderId[];
  status: "pending" | "created" | "compensating";
}>;

type OrderSourceClaimRow = Readonly<{
  source_type: OrderSourceType;
  source_reference_id: string;
  buyer_account_id: string;
  order_ids: unknown;
  status: OrderSourceClaim["status"];
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
  db: PgTransactionalPool,
  claim: Readonly<{
    sourceType: OrderSourceType;
    sourceReferenceId: string;
    buyerAccountId: string;
    orderIds: readonly OrderId[];
  }>,
  governed = false,
  admissionConfigured = false,
): Promise<Readonly<{ outcome: "claimed" | "existing"; claim: OrderSourceClaim }>> {
  const claimInTransaction = async (client: PgQueryable) => {
    const inserted = await client.query<OrderSourceClaimRow>(
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
      return { outcome: "claimed" as const, claim: mapOrderSourceClaim(insertedRow) };
    }

    const existing = await getOrderSourceClaim(client, claim.sourceType, claim.sourceReferenceId);
    if (!existing) {
      throw new Error("Order source claim conflict could not be resolved.");
    }
    if (existing.buyerAccountId !== claim.buyerAccountId) {
      throw new OrderingDomainError("Order source identity is already claimed by another buyer account.");
    }
    return { outcome: "existing" as const, claim: existing };
  };
  if (!governed && !admissionConfigured) return claimInTransaction(db);
  return withPgTransaction(db, async (client) => {
    await lockEvidenceWindowSourceIdentity(client, claim);
    if (!governed && (await readEvidenceWindowSourceByIdentity(client, claim))) {
      throw new OrderingDomainError("Evidence window source requires admitted creation context.");
    }
    if (governed && !(await lockOpenEvidenceWindowSource(client, claim))) {
      throw new OrderingDomainError("Evidence window source binding is missing.");
    }
    return claimInTransaction(client);
  });
}

export async function completeOrderSourceClaim(
  db: PgTransactionalPool,
  claim: Pick<OrderSourceClaim, "sourceType" | "sourceReferenceId" | "buyerAccountId">,
  orderIds: readonly OrderId[],
  governed = false,
) {
  const completeInTransaction = async (client: PgQueryable) => {
    const result = await client.query(
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
      const existing = await getOrderSourceClaim(client, claim.sourceType, claim.sourceReferenceId);
      if (
        existing?.status !== "created" ||
        existing.buyerAccountId !== claim.buyerAccountId ||
        JSON.stringify(existing.orderIds) !== JSON.stringify(orderIds)
      ) {
        throw new Error("Order source claim could not be completed.");
      }
    }
  };
  return governed ? withOpenEvidenceWindowSource(db, claim, completeInTransaction) : completeInTransaction(db);
}

async function deleteOwnedOrderSourceClaim(
  client: PgQueryable,
  claim: Pick<OrderSourceClaim, "sourceType" | "sourceReferenceId" | "buyerAccountId" | "orderIds">,
  status: "pending" | "compensating",
) {
  await client.query(
    `DELETE FROM ordering_order_source_claims
     WHERE source_type = $1 AND source_reference_id = $2 AND buyer_account_id = $3
       AND order_ids = $4::jsonb AND status = $5`,
    [claim.sourceType, claim.sourceReferenceId, claim.buyerAccountId, JSON.stringify(claim.orderIds), status],
  );
}

export async function compensatePendingOrderSourceClaim(
  db: PgTransactionalPool,
  claim: Pick<OrderSourceClaim, "sourceType" | "sourceReferenceId" | "buyerAccountId" | "orderIds">,
  hasDurableOrder: () => Promise<boolean>,
  admissionConfigured = false,
  reconcileSeller: (sellerAccountId: string) => Promise<void> = async () => {
    throw new Error("Capacity compensation requires seller signal reconciliation.");
  },
) {
  await withPgTransaction(db, async (client) => {
    if (admissionConfigured) await lockEvidenceWindowSourceIdentity(client, claim);
    const owned = await client.query(
      `SELECT source_type FROM ordering_order_source_claims
       WHERE source_type = $1 AND source_reference_id = $2 AND buyer_account_id = $3
         AND order_ids = $4::jsonb AND status = 'pending'
       FOR UPDATE`,
      [claim.sourceType, claim.sourceReferenceId, claim.buyerAccountId, JSON.stringify(claim.orderIds)],
    );
    if (owned.rows.length === 0 || (await hasDurableOrder())) {
      return;
    }
    const evidenceSource = await client.query(
      `SELECT 1 FROM ordering_evidence_window_sources
       WHERE source_type = $1 AND source_reference_id = $2 AND buyer_account_id = $3`,
      [claim.sourceType, claim.sourceReferenceId, claim.buyerAccountId],
    );
    if (evidenceSource.rows.length > 0) return;
    await releasePurchaseLimitClaimsForFailedSource(client, claim);
    if (claim.sourceType !== "cart-checkout") {
      await deleteOwnedOrderSourceClaim(client, claim, "pending");
      return;
    }
    await client.query(
      `UPDATE ordering_seller_open_order_claims
       SET status = 'released', released_at = now()
       WHERE order_id = ANY($1::text[]) AND status = 'claimed'`,
      [claim.orderIds],
    );
    await client.query(
      `UPDATE ordering_order_source_claims
     SET status = 'compensating', updated_at = now()
     WHERE source_type = $1
       AND source_reference_id = $2
       AND buyer_account_id = $3
       AND order_ids = $4::jsonb
       AND status = 'pending'`,
      [claim.sourceType, claim.sourceReferenceId, claim.buyerAccountId, JSON.stringify(claim.orderIds)],
    );
  });
  await finishOrderSourceCompensation(db, claim, hasDurableOrder, reconcileSeller, admissionConfigured);
}

export async function finishOrderSourceCompensation(
  db: PgTransactionalPool,
  claim: Pick<OrderSourceClaim, "sourceType" | "sourceReferenceId" | "buyerAccountId" | "orderIds">,
  hasDurableOrder: () => Promise<boolean>,
  reconcileSeller: (sellerAccountId: string) => Promise<void>,
  admissionConfigured = false,
) {
  if (claim.sourceType !== "cart-checkout") return;
  await withPgTransaction(db, async (client) => {
    if (admissionConfigured) await lockEvidenceWindowSourceIdentity(client, claim);
    const owned = await client.query(
      `SELECT source_type FROM ordering_order_source_claims
       WHERE source_type = $1 AND source_reference_id = $2 AND buyer_account_id = $3
         AND order_ids = $4::jsonb AND status = 'compensating'
       FOR UPDATE`,
      [claim.sourceType, claim.sourceReferenceId, claim.buyerAccountId, JSON.stringify(claim.orderIds)],
    );
    if (owned.rows.length === 0 || (await hasDurableOrder())) return;
    const governed = await readEvidenceWindowSourceByIdentity(client, claim);
    if (governed) return;
    // Released capacity rows retain the seller identities across signal failures.
    // The source lock serializes retries until all signals have converged.
    const sellers = await client.query<{ seller_account_id: string }>(
      `SELECT DISTINCT seller_account_id FROM ordering_seller_open_order_claims
       WHERE order_id = ANY($1::text[]) ORDER BY seller_account_id`,
      [claim.orderIds],
    );
    for (const seller of sellers.rows) await reconcileSeller(seller.seller_account_id);
    await deleteOwnedOrderSourceClaim(client, claim, "compensating");
  });
}
