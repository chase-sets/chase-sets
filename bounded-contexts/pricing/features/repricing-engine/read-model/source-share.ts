import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export const pricingRepricingSourceShareCheckpointKey =
  "pricing-market-input-projection:marketplace:v3";

export type RepricingPriceSource = "seller" | "bulk-reprice" | "repricing-engine" | "unattributed";

export type RepricingSourceShareWeek = Readonly<{
  weekStart: string;
  status: "complete" | "incomplete";
  reason: "checkpoint-lag" | "unattributed-event" | null;
  eventCount: number;
  counts: Readonly<{ bulk: number; policy: number; manual: number; unattributed: number }>;
  shares: Readonly<{ bulk: number; policy: number; manual: number }>;
  topSellers: readonly Readonly<{
    accountId: string;
    bulkShare: number;
    bulkListingCount: number;
    bulkCount: number;
    policyCount: number;
    manualCount: number;
  }>[];
}>;

function weekStartUtc(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Source-share dates must be valid UTC timestamps.");
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}

function sourceOf(value: unknown): RepricingPriceSource {
  return value === "bulk-reprice" || value === "repricing-engine" || value === "seller" ? value : "unattributed";
}

/** Projection is intentionally append-only and event-id keyed: replay and redelivery are equivalent. */
export function buildRepricingSourceShareProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "marketplace.listing.price-updated": async (event) => {
      const data = event.data as Readonly<{ changeSource?: unknown }>;
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
          sourceOf(data.changeSource),
          event.timing.occurredAt,
          event.globalPosition,
        ],
      );
    },
  };
}

function dateRange(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const weeks: string[] = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    weeks.push(weekStartUtc(cursor.toISOString()));
    if (weeks.length >= 26) break;
  }
  return [...new Set(weeks)];
}

export async function listRepricingSourceShareWeeks(
  db: PgQueryable,
  params: Readonly<{ from: string; to: string; sellerAccountId?: string }>,
): Promise<readonly RepricingSourceShareWeek[]> {
  const weeks = dateRange(params.from, params.to);
  if (weeks.length === 0) return [];
  const rows = await db.query<{
    week_start: string;
    seller_account_id: string;
    listing_id: string;
    source: RepricingPriceSource;
    global_position: string;
  }>(
    `SELECT week_start::text, seller_account_id, listing_id, source, global_position::text
       FROM pricing_repricing_source_share_events
      WHERE week_start = ANY($1::date[])
        AND ($2::text IS NULL OR seller_account_id = $2)
      ORDER BY week_start, seller_account_id, listing_id, global_position`,
    [weeks, params.sellerAccountId ?? null],
  );
  const checkpoint = await db.query<{ last_global_position: string; updated_at: Date }>(
    `SELECT last_global_position::text, updated_at
       FROM event_subscription_checkpoints
      WHERE checkpoint_key = $1`,
    [pricingRepricingSourceShareCheckpointKey],
  );
  const checkpointPosition = BigInt(checkpoint.rows[0]?.last_global_position ?? "0");
  const checkpointUpdatedAt = checkpoint.rows[0]?.updated_at ? new Date(checkpoint.rows[0].updated_at).getTime() : 0;
  const byWeek = new Map<string, typeof rows.rows>();
  for (const week of weeks) byWeek.set(week, []);
  for (const row of rows.rows) byWeek.get(row.week_start)?.push(row);

  return weeks.map((weekStart) => {
    const members = byWeek.get(weekStart) ?? [];
    const counts = { bulk: 0, policy: 0, manual: 0, unattributed: 0 };
    const sellerTotals = new Map<string, { bulk: number; policy: number; manual: number; total: number; listings: Set<string> }>();
    for (const row of members) {
      if (row.source === "bulk-reprice") counts.bulk += 1;
      else if (row.source === "repricing-engine") counts.policy += 1;
      else if (row.source === "seller") counts.manual += 1;
      else counts.unattributed += 1;
      const seller = sellerTotals.get(row.seller_account_id) ?? { bulk: 0, policy: 0, manual: 0, total: 0, listings: new Set<string>() };
      seller.total += 1;
      if (row.source === "bulk-reprice") {
        seller.bulk += 1;
        seller.listings.add(row.listing_id);
      } else if (row.source === "repricing-engine") seller.policy += 1;
      else if (row.source === "seller") seller.manual += 1;
      sellerTotals.set(row.seller_account_id, seller);
    }
    const eventCount = members.length;
    const shares = {
      bulk: eventCount ? counts.bulk / eventCount : 0,
      policy: eventCount ? counts.policy / eventCount : 0,
      manual: eventCount ? counts.manual / eventCount : 0,
    };
    const weekEnd = new Date(`${weekStart}T00:00:00.000Z`);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
    const maxPosition = members.reduce((max, row) => Math.max(max, Number(row.global_position)), 0);
    const complete = checkpointPosition >= BigInt(maxPosition) && checkpointUpdatedAt >= weekEnd.getTime();
    return {
      weekStart,
      status: complete && counts.unattributed === 0 ? "complete" : "incomplete",
      reason: counts.unattributed > 0 ? "unattributed-event" : complete ? null : "checkpoint-lag",
      eventCount,
      counts,
      shares,
      topSellers: [...sellerTotals.entries()]
        .map(([accountId, value]) => ({
          accountId,
          bulkShare: value.total ? value.bulk / value.total : 0,
          bulkListingCount: value.listings.size,
          bulkCount: value.bulk,
          policyCount: value.policy,
          manualCount: value.manual,
        }))
        .sort((a, b) => b.bulkShare - a.bulkShare || a.accountId.localeCompare(b.accountId))
        .slice(0, 50),
    } satisfies RepricingSourceShareWeek;
  });
}
