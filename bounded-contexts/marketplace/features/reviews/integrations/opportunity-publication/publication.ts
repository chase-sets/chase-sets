import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  isReviewOpportunityChangedV1,
  reviewOpportunityFactType,
  type ReviewOpportunityChangedV1,
  type ReviewOpportunitySlot,
} from "@chase-sets/event-core/review-opportunity-facts";
import {
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { readOpportunitySourceProof } from "./source-proof";

type Work = {
  order_id: string;
  generation: string;
  published_stream_version: number;
  last_fact: ReviewOpportunityChangedV1 | null;
};
type DirectionRow = {
  author_role: "buyer" | "seller";
  eligible_at: string;
  effective_deadline_at: string;
  submission_state: "allowed" | "held" | "expired";
  held: boolean;
  active_review_id: string | null;
  active_review_revealed_at: string | null;
};

export function opportunitySlot(row: DirectionRow): ReviewOpportunitySlot {
  return {
    authorRole: row.author_role,
    eligibleAt: new Date(row.eligible_at).toISOString(),
    effectiveDeadlineAt: new Date(row.effective_deadline_at).toISOString(),
    submissionState: row.submission_state,
    held: row.held,
    activeReviewId: row.active_review_id,
    activeReviewRevealedAt:
      row.active_review_revealed_at === null ? null : new Date(row.active_review_revealed_at).toISOString(),
  };
}

async function readSnapshot(db: PgQueryable, work: Work) {
  const order = (
    await db.query<{ buyer_account_id: string; seller_account_id: string }>(
      `SELECT buyer_account_id, seller_account_id FROM marketplace_review_order_sources WHERE order_id = $1`,
      [work.order_id],
    )
  ).rows[0];
  if (!order && !work.last_fact) return null;
  const rows = order
    ? (
        await db.query<DirectionRow>(
          `SELECT eligibility.author_role, eligibility.eligible_at::text AS eligible_at,
       eligibility.effective_deadline_at::text AS effective_deadline_at, eligibility.submission_state,
       (eligibility.submission_state = 'held' OR COALESCE(active.held, false)) AS held,
       active.review_id AS active_review_id, active.revealed_at::text AS active_review_revealed_at
     FROM marketplace_review_eligibility_pages AS eligibility
     JOIN marketplace_review_order_sources AS source ON source.order_id = eligibility.order_id
     LEFT JOIN marketplace_review_pages AS active ON active.order_id = eligibility.order_id
       AND active.author_account_id = eligibility.author_account_id
       AND active.subject_account_id = eligibility.subject_account_id AND active.status = 'active'
     WHERE eligibility.order_id = $1 AND (
       (eligibility.author_role = 'buyer' AND eligibility.author_account_id = source.buyer_account_id
         AND eligibility.subject_account_id = source.seller_account_id) OR
       (eligibility.author_role = 'seller' AND eligibility.author_account_id = source.seller_account_id
         AND eligibility.subject_account_id = source.buyer_account_id))`,
          [work.order_id],
        )
      ).rows
    : [];
  return {
    buyerAccountId: order?.buyer_account_id ?? work.last_fact!.buyerAccountId,
    sellerAccountId: order?.seller_account_id ?? work.last_fact!.sellerAccountId,
    buyerToSeller: rows.find((row) => row.author_role === "buyer"),
    sellerToBuyer: rows.find((row) => row.author_role === "seller"),
  };
}

export type ReviewOpportunityPublication = Readonly<{
  run: (context: EventStoreContext) => Promise<number>;
  backfill: () => Promise<number>;
}>;

export function createReviewOpportunityPublication(deps: {
  pool: PgTransactionalPool;
  eventStore: PostgresEventStore;
  now?: () => Date;
}): ReviewOpportunityPublication {
  const now = deps.now ?? (() => new Date());
  return {
    async run(context) {
      let published = 0;
      for (let count = 0; count < 100; count += 1) {
        const processed = await withPgTransaction(deps.pool, async (db) => {
          await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          await db.query(`LOCK TABLE marketplace_review_order_sources, marketplace_review_eligibility_pages,
            marketplace_review_pages IN ACCESS SHARE MODE`);
          const proof = await readOpportunitySourceProof(db);
          if (!proof) return false;
          const work = (
            await db.query<Work>(
              `SELECT order_id, generation::text AS generation, published_stream_version, last_fact
             FROM marketplace_review_opportunity_work AS work WHERE generation > published_generation
               AND (last_fact IS NOT NULL OR EXISTS (SELECT 1 FROM marketplace_review_order_sources AS source WHERE source.order_id = work.order_id))
             ORDER BY order_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
            )
          ).rows[0];
          if (!work) return false;
          const snapshot = await readSnapshot(db, work);
          if (!snapshot) return false;
          const fact: ReviewOpportunityChangedV1 = {
            factSchemaVersion: 1,
            orderId: work.order_id,
            generation: work.generation,
            ...proof,
            generatedAt: now().toISOString(),
            buyerAccountId: snapshot.buyerAccountId,
            sellerAccountId: snapshot.sellerAccountId,
            buyerToSeller: snapshot.buyerToSeller ? opportunitySlot(snapshot.buyerToSeller) : null,
            sellerToBuyer: snapshot.sellerToBuyer ? opportunitySlot(snapshot.sellerToBuyer) : null,
          };
          if (!isReviewOpportunityChangedV1(fact)) throw new Error("Invalid canonical review opportunity snapshot.");
          const events = await deps.eventStore.appendToStreamInTransaction(db, {
            streamId: `marketplace.review-opportunity-${work.order_id}`,
            expectedVersion: work.published_stream_version === 0 ? "no_stream" : work.published_stream_version,
            context,
            events: [{ eventType: reviewOpportunityFactType, payload: fact }],
          });
          const acknowledged = await db.query(
            `UPDATE marketplace_review_opportunity_work SET published_generation = $2,
               published_stream_version = $3, last_fact = $4::jsonb
             WHERE order_id = $1 AND generation = $2`,
            [work.order_id, work.generation, events[0]!.streamVersion, JSON.stringify(fact)],
          );
          if (acknowledged.rowCount !== 1) throw new Error("Review opportunity publication lost its generation fence.");
          return true;
        }).catch((error: unknown) => {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "40001") return false;
          throw error;
        });
        if (!processed) break;
        published += 1;
      }
      return published;
    },
    async backfill() {
      return withPgTransaction(deps.pool, async (db) => {
        const proof = await readOpportunitySourceProof(db);
        if (!proof) return 0;
        await db.query(
          `INSERT INTO marketplace_review_opportunity_backfill (source_generation) VALUES ($1)
           ON CONFLICT (singleton) DO UPDATE SET source_generation = EXCLUDED.source_generation,
             after_order_id = '', completed = false
           WHERE marketplace_review_opportunity_backfill.source_generation <> EXCLUDED.source_generation`,
          [proof.sourceGeneration],
        );
        const cursor = (
          await db.query<{ after_order_id: string; completed: boolean }>(
            `SELECT after_order_id, completed FROM marketplace_review_opportunity_backfill FOR UPDATE`,
          )
        ).rows[0]!;
        if (cursor.completed) return 0;
        const page = await db.query<{ order_id: string }>(
          `SELECT order_id FROM (
             SELECT order_id FROM marketplace_review_order_sources
             UNION SELECT order_id FROM marketplace_review_opportunity_work
           ) AS orders WHERE order_id > $1 ORDER BY order_id LIMIT 100`,
          [cursor.after_order_id],
        );
        for (const row of page.rows) {
          await db.query(
            `INSERT INTO marketplace_review_opportunity_work (order_id, backfill_generation) VALUES ($1, $2)
             ON CONFLICT (order_id) DO UPDATE SET generation = marketplace_review_opportunity_work.generation + 1,
               backfill_generation = EXCLUDED.backfill_generation, updated_at = now()
             WHERE marketplace_review_opportunity_work.backfill_generation IS DISTINCT FROM EXCLUDED.backfill_generation`,
            [row.order_id, proof.sourceGeneration],
          );
        }
        await db.query(
          `UPDATE marketplace_review_opportunity_backfill SET after_order_id = $1, completed = $2
           WHERE source_generation = $3`,
          [page.rows.at(-1)?.order_id ?? cursor.after_order_id, page.rows.length < 100, proof.sourceGeneration],
        );
        return page.rows.length;
      });
    },
  };
}
