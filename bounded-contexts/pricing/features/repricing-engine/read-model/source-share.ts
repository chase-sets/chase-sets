import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export const pricingRepricingSourceShareCheckpointKey = "pricing-market-input-projection:marketplace:v3";
export class RepricingSourceShareRangeError extends Error {}
export type RepricingPriceSource = "seller" | "bulk-reprice" | "repricing-engine" | "unattributed";
export type RepricingSourceShareSeller = Readonly<{
  accountId: string;
  bulkShare: number;
  bulkListingCount: number;
  bulkCount: number;
  policyCount: number;
  manualCount: number;
}>;
export type RepricingSourceShareWeek = Readonly<{
  weekStart: string;
  status: "complete" | "incomplete";
  reason: "checkpoint-lag" | "unattributed-event" | null;
  eventCount: number;
  counts: Readonly<{ bulk: number; policy: number; manual: number; unattributed: number }>;
  shares: Readonly<{ bulk: number; policy: number; manual: number }>;
  topSellers: readonly RepricingSourceShareSeller[];
  /** Computed over ALL sellers, not just the displayed top 50. */
  maxReliantBulkListingCount: number;
  requestedSeller: RepricingSourceShareSeller | null;
}>;

function weekStartUtc(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Source-share dates must be valid UTC timestamps.");
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}

function sourceOf(value: unknown): RepricingPriceSource {
  return value === "bulk-reprice" || value === "repricing-engine" || value === "seller" ? value : "unattributed";
}

export function buildRepricingSourceShareProjectionHandlers(
  db: PgQueryable,
  eventTypes: readonly string[] = ["marketplace.listing.price-updated"],
): ProjectorHandlerMap {
  return Object.fromEntries(
    eventTypes.map((type) => [
      type,
      (async (event) => {
        if (type === "marketplace.listing.price-updated") {
          await db.query(
            `INSERT INTO pricing_repricing_source_share_events
           (event_id, week_start, seller_account_id, listing_id, source, occurred_at, global_position)
         VALUES ($1, $2::date, $3, $4, $5, $6::timestamptz, $7)
         ON CONFLICT (event_id) DO NOTHING`,
            [
              event.id,
              weekStartUtc(event.timing.occurredAt),
              event.audit.forAccountId,
              event.streamId.replace("marketplace.listing-", ""),
              sourceOf((event.data as { changeSource?: unknown }).changeSource),
              event.timing.occurredAt,
              event.globalPosition,
            ],
          );
        }
        // Processing wall-clock time is not a source watermark. The subscription
        // checkpoint must also acknowledge this source-event position before use.
        await db.query(
          `INSERT INTO pricing_repricing_source_share_watermark (singleton, global_position, recorded_at)
       VALUES (true, $1, $2::timestamptz)
       ON CONFLICT (singleton) DO UPDATE SET global_position = EXCLUDED.global_position, recorded_at = EXCLUDED.recorded_at
       WHERE pricing_repricing_source_share_watermark.global_position < EXCLUDED.global_position`,
          [event.globalPosition, event.timing.recordedAt],
        );
      }) satisfies ProjectorHandlerMap[string],
    ]),
  );
}

function dateRange(from: string, to: string): string[] {
  if (
    ![from, to].every(
      (value) =>
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
    )
  )
    throw new RepricingSourceShareRangeError("Invalid source-share date range.");
  const start = new Date(`${weekStartUtc(`${from}T00:00:00Z`)}T00:00:00Z`);
  const end = new Date(`${weekStartUtc(`${to}T00:00:00Z`)}T00:00:00Z`);
  const count = (end.getTime() - start.getTime()) / (7 * 86400000) + 1;
  if (count < 1 || count > 26)
    throw new RepricingSourceShareRangeError("Source-share range must contain 1-26 UTC weeks.");
  return Array.from({ length: count }, (_, index) =>
    new Date(start.getTime() + index * 7 * 86400000).toISOString().slice(0, 10),
  );
}

export async function listRepricingSourceShareWeeks(
  db: PgQueryable,
  params: Readonly<{ from: string; to: string; sellerAccountId?: string }>,
): Promise<readonly RepricingSourceShareWeek[]> {
  const weeks = dateRange(params.from, params.to);
  const result = await db.query<{
    week_start: string;
    event_count: string;
    bulk: string;
    policy: string;
    manual: string;
    unattributed: string;
    max_reliant_bulk_listing_count: string;
    top_sellers: RepricingSourceShareSeller[];
    requested_seller: RepricingSourceShareSeller | null;
  }>(
    `WITH sellers AS (
       SELECT week_start, seller_account_id,
              count(*) AS total,
              count(*) FILTER (WHERE source = 'bulk-reprice') AS bulk,
              count(*) FILTER (WHERE source = 'repricing-engine') AS policy,
              count(*) FILTER (WHERE source = 'seller') AS manual,
              count(*) FILTER (WHERE source = 'unattributed') AS unattributed,
              count(DISTINCT listing_id) FILTER (WHERE source = 'bulk-reprice') AS bulk_listings
         FROM pricing_repricing_source_share_events WHERE week_start = ANY($1::date[])
        GROUP BY week_start, seller_account_id
     ), ranked AS (
       SELECT *, row_number() OVER (PARTITION BY week_start ORDER BY bulk::numeric / total DESC, seller_account_id) AS rank,
              jsonb_build_object('accountId', seller_account_id, 'bulkShare', bulk::numeric / total,
                'bulkListingCount', bulk_listings, 'bulkCount', bulk, 'policyCount', policy, 'manualCount', manual) AS seller
         FROM sellers
     )
     SELECT week_start::text, sum(total)::text AS event_count, sum(bulk)::text AS bulk,
            sum(policy)::text AS policy, sum(manual)::text AS manual, sum(unattributed)::text AS unattributed,
            COALESCE(max(bulk_listings) FILTER (WHERE bulk > policy AND bulk > manual), 0)::text AS max_reliant_bulk_listing_count,
            jsonb_agg(seller ORDER BY rank) FILTER (WHERE rank <= 50) AS top_sellers,
            (jsonb_agg(seller) FILTER (WHERE seller_account_id = $2::text))->0 AS requested_seller
       FROM ranked GROUP BY week_start ORDER BY week_start`,
    [weeks, params.sellerAccountId ?? null],
  );
  const checkpoint = await db.query<{ last_global_position: string; global_position: string; recorded_at: Date }>(
    `SELECT checkpoint.last_global_position::text, watermark.global_position::text, watermark.recorded_at
       FROM event_subscription_checkpoints AS checkpoint
       CROSS JOIN pricing_repricing_source_share_watermark AS watermark
       JOIN event_projection_recovery_markers AS recovery
         ON recovery.projection_kind = 'subscription' AND recovery.projection_key = checkpoint.checkpoint_key
        AND recovery.last_global_position >= checkpoint.last_global_position
      WHERE checkpoint.checkpoint_key = $1
        AND NOT EXISTS (SELECT 1 FROM event_projection_blocked_streams
                         WHERE projection_key = $1 AND state IN ('blocked', 'retrying'))
        AND NOT EXISTS (SELECT 1 FROM event_projection_poison_events
                         WHERE projection_key = $1 AND state IN ('blocked', 'retrying', 'ignored'))`,
    [pricingRepricingSourceShareCheckpointKey],
  );
  const observed = checkpoint.rows[0];
  const acknowledgedAt =
    observed && BigInt(observed.last_global_position) >= BigInt(observed.global_position)
      ? new Date(observed.recorded_at).getTime()
      : 0;
  const byWeek = new Map(result.rows.map((row) => [row.week_start, row]));
  return weeks.map((weekStart) => {
    const row = byWeek.get(weekStart);
    const eventCount = Number(row?.event_count ?? 0);
    const counts = {
      bulk: Number(row?.bulk ?? 0),
      policy: Number(row?.policy ?? 0),
      manual: Number(row?.manual ?? 0),
      unattributed: Number(row?.unattributed ?? 0),
    };
    const complete = acknowledgedAt >= Date.parse(`${weekStart}T00:00:00Z`) + 7 * 86400000;
    return {
      weekStart,
      status: complete && counts.unattributed === 0 ? "complete" : "incomplete",
      reason: counts.unattributed > 0 ? "unattributed-event" : complete ? null : "checkpoint-lag",
      eventCount,
      counts,
      shares: {
        bulk: eventCount ? counts.bulk / eventCount : 0,
        policy: eventCount ? counts.policy / eventCount : 0,
        manual: eventCount ? counts.manual / eventCount : 0,
      },
      topSellers: row?.top_sellers ?? [],
      maxReliantBulkListingCount: Number(row?.max_reliant_bulk_listing_count ?? 0),
      requestedSeller: row?.requested_seller ?? null,
    };
  });
}
