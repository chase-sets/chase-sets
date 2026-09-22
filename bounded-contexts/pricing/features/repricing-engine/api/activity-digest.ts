import { createCheckpointKey, loadSubscriptionCheckpoint } from "@chase-sets/bounded-context-runtime";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  readGapSafeEventStoreHead,
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { repricingManagementPolicy } from "../domain/management-policy";
import { compactListingOutcomeFacts } from "../read-model/listing-outcomes";

const DAY_MS = 86_400_000;
const checkpointKey = createCheckpointKey({
  projectionName: "pricing-repricing-evaluation-projection",
  sourceContextName: "pricing",
  subscriptionVersion: 1,
});
const systemContext: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_pricing_system" as never, forAccountId: "acc_pricing_system" as never },
};

type Window = Readonly<{ window_day: string; assigned_floor: string }>;
type DigestCounts = Readonly<{
  sellerAccountId: string;
  policiesEvaluated: number;
  listingsChanged: number;
  floorClamped: number;
  ceilingClamped: number;
  maxMoveClamped: number;
  budgetExhausted: number;
  pausedForMissingInput: number;
  withinTolerance: number;
  spiralBreakerTrips: number;
}>;

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
}

async function newestWindow(db: PgQueryable): Promise<Window | undefined> {
  return (
    await db.query<Window>(
      `SELECT window_day::text, assigned_floor::text FROM pricing_repricing_digest_windows
     ORDER BY window_day DESC LIMIT 1`,
    )
  ).rows[0];
}

/** Only a fact's own membership, never a numerical position horizon, proves delivery. */
export function digestedFactSql(emittedThrough: string | null): string {
  if (emittedThrough !== null && !/^\d{4}-\d{2}-\d{2}$/.test(emittedThrough)) {
    throw new Error("Digest horizon must be a UTC day.");
  }
  return `(
    EXISTS (SELECT 1 FROM pricing_repricing_digest_windows AS baseline
      WHERE baseline.kind = 'baseline' AND fact.global_position <= baseline.assigned_floor)
    OR EXISTS (SELECT 1 FROM pricing_repricing_digest_window_members AS member
      WHERE member.global_position = fact.global_position
        AND member.window_day <= ${emittedThrough === null ? "NULL::date" : `'${emittedThrough}'::date`})
  )`;
}

export function createRepricingActivityDigestRunner(
  deps: Readonly<{
    pool: PgTransactionalPool;
    eventStore: EventStore;
    policies: Pick<PolicyRuntime, "resolvePolicy">;
  }>,
) {
  return async function runRepricingActivityDigest(input: Readonly<{ now?: string }> = {}): Promise<void> {
    const now = new Date(input.now ?? Date.now());
    const nowIso = now.toISOString();
    const { value: policy } = await deps.policies.resolvePolicy(repricingManagementPolicy, { at: nowIso });
    let latest = await newestWindow(deps.pool);
    let fence = await readGapSafeEventStoreHead(deps.pool);

    if (!latest) {
      const baseline = await withPgTransaction(deps.pool, async (tx) =>
        tx.query<Window>(
          `INSERT INTO pricing_repricing_digest_windows
           (window_day, kind, assigned_floor, captured_at, emitted_at, updated_at)
         VALUES ($1::date, 'baseline', $2::bigint, $3, $3, $3)
         ON CONFLICT DO NOTHING RETURNING window_day::text, assigned_floor::text`,
          [new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10), fence, nowIso],
        ),
      );
      if (baseline.rows[0]) {
        latest = baseline.rows[0];
      } else {
        latest = await newestWindow(deps.pool);
        fence = await readGapSafeEventStoreHead(deps.pool);
      }
    }

    while (latest) {
      const day = nextDay(latest.window_day);
      const closesAt = `${nextDay(day)}T00:00:00.000Z`;
      if (now.getTime() < Date.parse(closesAt) + policy.digestSettleMinutes * 60_000) break;
      const floor = latest.assigned_floor;
      const captured = await withPgTransaction(deps.pool, async (tx) => {
        const claimed = await tx.query<Window>(
          `INSERT INTO pricing_repricing_digest_windows
             (window_day, kind, assigned_floor, captured_at, updated_at)
           VALUES ($1::date, 'day', $2::bigint, $3, $3)
           ON CONFLICT DO NOTHING RETURNING window_day::text, assigned_floor::text`,
          [day, floor, nowIso],
        );
        if (!claimed.rows[0]) return undefined;
        await tx.query(
          `INSERT INTO pricing_repricing_digest_window_members (global_position, window_day)
           SELECT global_position, $1::date FROM event_store_events
           WHERE event_type = 'pricing.repricing-policy.evaluated'
             AND global_position > $2::bigint AND global_position <= $3::bigint
             AND recorded_at < $4::timestamptz
           ON CONFLICT DO NOTHING`,
          [day, floor, fence, closesAt],
        );
        return (
          await tx.query<Window>(
            `UPDATE pricing_repricing_digest_windows SET assigned_floor = COALESCE(
             (SELECT min(global_position) - 1 FROM event_store_events
              WHERE event_type = 'pricing.repricing-policy.evaluated'
                AND global_position > $2::bigint AND global_position <= $3::bigint
                AND recorded_at >= $4::timestamptz), $3::bigint), updated_at = $5
           WHERE window_day = $1::date AND kind = 'day' AND assigned_floor = $2::bigint
             AND captured_at = $5::timestamptz AND emitted_at IS NULL
           RETURNING window_day::text, assigned_floor::text`,
            [day, floor, fence, closesAt, nowIso],
          )
        ).rows[0];
      });
      if (captured) {
        latest = captured;
      } else {
        // A conflict can wait across another capture and a new append. Re-read before re-fencing.
        latest = await newestWindow(deps.pool);
        fence = await readGapSafeEventStoreHead(deps.pool);
      }
    }

    const position = BigInt((await loadSubscriptionCheckpoint(deps.pool, checkpointKey)) ?? "0");
    const pending = await deps.pool.query<{ window_day: string }>(
      `SELECT window_day::text FROM pricing_repricing_digest_windows
       WHERE kind = 'day' AND emitted_at IS NULL ORDER BY window_day`,
    );
    for (const { window_day: day } of pending.rows) {
      const held = await withPgTransaction(deps.pool, async (tx) => {
        const window = await tx.query(
          `SELECT window_day FROM pricing_repricing_digest_windows
           WHERE window_day = $1::date AND emitted_at IS NULL FOR UPDATE`,
          [day],
        );
        if (!window.rows[0]) return false;
        const maximum = await tx.query<{ position: string }>(
          `SELECT COALESCE(max(global_position), 0)::text AS position
           FROM pricing_repricing_digest_window_members WHERE window_day = $1::date`,
          [day],
        );
        if (position < BigInt(maximum.rows[0]!.position)) return true;
        const counts = await tx.query<DigestCounts>(
          `SELECT fact.seller_account_id AS "sellerAccountId",
             count(DISTINCT fact.policy_id)::integer AS "policiesEvaluated",
             count(*) FILTER (WHERE fact.trace->>'outcome' = 'changed')::integer AS "listingsChanged",
             count(*) FILTER (WHERE (fact.trace->'clamps'->>'floor')::boolean)::integer AS "floorClamped",
             count(*) FILTER (WHERE (fact.trace->'clamps'->>'ceiling')::boolean)::integer AS "ceilingClamped",
             count(*) FILTER (WHERE (fact.trace->'clamps'->>'maxMove')::boolean)::integer AS "maxMoveClamped",
             count(*) FILTER (WHERE fact.trace->>'skipReason' = 'budget-exhausted')::integer AS "budgetExhausted",
             count(*) FILTER (WHERE fact.trace->>'outcome' = 'pause-requested')::integer AS "pausedForMissingInput",
             count(*) FILTER (WHERE fact.trace->>'skipReason' = 'within-tolerance')::integer AS "withinTolerance",
             count(DISTINCT (fact.catalog_catalog_item_id, fact.product_id, fact.frozen_until))
               FILTER (WHERE fact.trace->'flags' ? 'spiral-breaker')::integer AS "spiralBreakerTrips"
           FROM pricing_repricing_listing_outcome_facts AS fact
           JOIN pricing_repricing_digest_window_members AS member USING (global_position)
           WHERE member.window_day = $1::date GROUP BY fact.seller_account_id ORDER BY fact.seller_account_id`,
          [day],
        );
        for (const count of counts.rows) {
          const digestId = `${count.sellerAccountId}-${day}`;
          try {
            await deps.eventStore.appendToStream({
              streamId: `pricing.repricing-activity-digest-${digestId}`,
              expectedVersion: "no_stream",
              context: {
                ...systemContext,
                audit: { ...systemContext.audit, forAccountId: count.sellerAccountId as never },
              },
              events: [
                {
                  eventType: "pricing.repricing-activity.digest-requested",
                  payload: { schemaVersion: 1, digestId, day, ...count },
                  occurredAt: nowIso as never,
                },
              ],
            });
          } catch (error) {
            if (
              typeof error !== "object" ||
              error === null ||
              !("code" in error) ||
              error.code !== "concurrency_conflict"
            )
              throw error;
          }
        }
        await tx.query(
          `UPDATE pricing_repricing_digest_windows SET emitted_at = $2, updated_at = $2
           WHERE window_day = $1::date AND emitted_at IS NULL`,
          [day, nowIso],
        );
        return false;
      });
      if (held) {
        if (now.getTime() >= Date.parse(`${nextDay(day)}T00:00:00.000Z`) + policy.digestLagWarnHours * 3_600_000) {
          console.warn("pricing.repricing-digest.delayed", { day, checkpointPosition: position.toString() });
        }
        break;
      }
    }
    const horizon = await deps.pool.query<{ day: string | null }>(
      `SELECT max(emitted.window_day)::text AS day FROM pricing_repricing_digest_windows AS emitted
       WHERE emitted.emitted_at IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM pricing_repricing_digest_windows AS held
         WHERE held.window_day < emitted.window_day AND held.emitted_at IS NULL)`,
    );
    await withPgTransaction(deps.pool, (tx) =>
      compactListingOutcomeFacts(tx, {
        retainFrom: new Date(now.getTime() - 90 * DAY_MS).toISOString(),
        digestedSql: digestedFactSql(horizon.rows[0]!.day),
      }),
    );
  };
}
