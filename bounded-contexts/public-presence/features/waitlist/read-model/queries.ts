import { escapeLikePattern, type PgQueryable } from "@chase-sets/event-core-postgres";
import { WAITLIST_GAMES, WAITLIST_INVENTORY_SIZES, WAITLIST_REFERRAL_GOAL } from "../domain/common";
import { computeWaitlistQueuePlacements, resolveWaitlistQueueStanding } from "./referral-queue-policy";
import type { WaveCandidate } from "./wave-cohort-policy";
import type {
  CampaignChannelAttributionRow,
  CampaignQualityMetrics,
  WaitlistMetrics,
  WaitlistReferralSummary,
  WaitlistSignupListItem,
} from "../api/contracts";

function normalizePageParams(params: Readonly<{ limit?: number; offset?: number }>) {
  return {
    limit: Math.max(1, Math.min(params.limit ?? 100, 500)),
    offset: Math.max(0, params.offset ?? 0),
  };
}

function waitlistSortClause(sort?: string | null) {
  return sort === "referrals"
    ? "referral_count DESC, updated_at DESC, signup_id DESC"
    : "updated_at DESC, signup_id DESC";
}

function waitlistFilters(
  params: Readonly<{
    role?: string | null;
    interest?: string | null;
    search?: string | null;
  }>,
) {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (params.role && params.role !== "all") {
    values.push(params.role);
    clauses.push(`role = $${values.length}`);
  }

  if (params.interest && params.interest !== "all") {
    values.push(JSON.stringify([params.interest]));
    clauses.push(`interests @> $${values.length}::jsonb`);
  }

  if (params.search) {
    values.push(`%${escapeLikePattern(params.search.trim().toLowerCase())}%`);
    clauses.push(`LOWER(email) LIKE $${values.length} ESCAPE '\\'`);
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

export async function listWaitlistSignups(
  db: PgQueryable,
  params: Readonly<{
    limit?: number;
    offset?: number;
    role?: string | null;
    interest?: string | null;
    search?: string | null;
    sort?: string | null;
  }>,
): Promise<{ items: WaitlistSignupListItem[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);
  const filters = waitlistFilters(params);
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM public_presence_waitlist_signups
     ${filters.where}`,
    filters.values,
  );
  const itemsResult = await db.query<WaitlistSignupListItem>(
    `SELECT
       s.signup_id,
       s.email,
       s.role,
       s.interests,
       s.email_consent_accepted_at::text AS email_consent_accepted_at,
       s.marketing_consent_accepted_at::text AS marketing_consent_accepted_at,
       s.referred_by_signup_id,
       s.page_path,
       s.referrer,
       s.utm_source,
       s.utm_medium,
       s.utm_campaign,
       s.utm_content,
       s.utm_term,
       s.games,
       s.has_store_link,
       s.store_url,
       s.inventory_size,
       s.submitted_at::text AS submitted_at,
       s.updated_at::text AS updated_at,
       COALESCE(r.referral_count, 0)::int AS referral_count
     FROM public_presence_waitlist_signups s
     LEFT JOIN (
       SELECT referred_by_signup_id, COUNT(*) AS referral_count
       FROM public_presence_waitlist_signups
       WHERE referred_by_signup_id IS NOT NULL
       GROUP BY referred_by_signup_id
     ) r ON r.referred_by_signup_id = s.signup_id
     ${filters.where}
     ORDER BY ${waitlistSortClause(params.sort)}
     LIMIT $${filters.values.length + 1} OFFSET $${filters.values.length + 2}`,
    [...filters.values, limit, offset],
  );

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getWaitlistReferralSummary(db: PgQueryable, signupId: string): Promise<WaitlistReferralSummary> {
  const result = await db.query<{ referral_count: string }>(
    `SELECT COUNT(*) AS referral_count
     FROM public_presence_waitlist_signups
     WHERE referred_by_signup_id = $1`,
    [signupId],
  );
  // Queue standing is computed in TypeScript (referral-queue-policy.ts) from
  // one scan of the whole waitlist rather than duplicated as SQL window math:
  // prelaunch volume is small (see the schema.ts index note), and the policy
  // stays a single, unit-tested source of truth. Standing is null until the
  // projection has caught up with a fresh signup -- the UI shows "pending",
  // never a fake number.
  const queueResult = await db.query<{ signup_id: string; submitted_at: string; referral_count: string }>(
    `SELECT
       s.signup_id,
       s.submitted_at::text AS submitted_at,
       COALESCE(r.referral_count, 0)::int AS referral_count
     FROM public_presence_waitlist_signups s
     LEFT JOIN (
       SELECT referred_by_signup_id, COUNT(*) AS referral_count
       FROM public_presence_waitlist_signups
       WHERE referred_by_signup_id IS NOT NULL
       GROUP BY referred_by_signup_id
     ) r ON r.referred_by_signup_id = s.signup_id`,
  );
  const standing = resolveWaitlistQueueStanding(
    queueResult.rows.map((row) => ({
      signupId: row.signup_id,
      submittedAt: row.submitted_at,
      referralCount: Number(row.referral_count),
    })),
    signupId,
  );

  return {
    referralCount: Number(result.rows[0]?.referral_count ?? 0),
    referralGoal: WAITLIST_REFERRAL_GOAL,
    queuePosition: standing?.position ?? null,
    totalSignups: standing?.totalSignups ?? Number(queueResult.rowCount ?? queueResult.rows.length),
    positionsAdvanced: standing?.positionsAdvanced ?? 0,
  };
}

export type WaveAdmissionCandidate = WaveCandidate & Readonly<{ email: string }>;

export async function listWaveAdmissionCandidates(
  db: PgQueryable,
  waveNumber: 1 | 2 | 3,
): Promise<readonly WaveAdmissionCandidate[]> {
  const result = await db.query<{
    signup_id: string;
    email: string;
    role: WaveAdmissionCandidate["role"];
    games: WaveAdmissionCandidate["games"];
    inventory_size: WaveAdmissionCandidate["inventorySize"];
    has_store_link: boolean;
    submitted_at: string;
    referral_count: string;
  }>(
    `SELECT s.signup_id,
            s.email,
            s.role,
            s.games,
            s.inventory_size,
            s.has_store_link,
            s.submitted_at::text AS submitted_at,
            COALESCE(r.referral_count, 0)::int AS referral_count
     FROM public_presence_waitlist_signups s
     LEFT JOIN (
       SELECT referred_by_signup_id, COUNT(*) AS referral_count
       FROM public_presence_waitlist_signups
       WHERE referred_by_signup_id IS NOT NULL
       GROUP BY referred_by_signup_id
     ) r ON r.referred_by_signup_id = s.signup_id
     WHERE s.admitted_wave IS NULL OR s.admitted_wave = $1`,
    [waveNumber],
  );
  const placements = computeWaitlistQueuePlacements(
    result.rows.map((row) => ({
      signupId: row.signup_id,
      submittedAt: row.submitted_at,
      referralCount: Number(row.referral_count),
    })),
  );
  return result.rows.map((row) => ({
    signupId: row.signup_id,
    email: row.email,
    role: row.role,
    games: row.games,
    inventorySize: row.inventory_size,
    hasStoreLink: row.has_store_link,
    queuePosition: placements.get(row.signup_id)?.position ?? Number.MAX_SAFE_INTEGER,
    submittedAt: row.submitted_at,
  }));
}

export async function findAdmittedWaitlistSignupByEmail(db: PgQueryable, email: string) {
  const result = await db.query<{ signup_id: string; beta_invitation_id: string; admitted_wave: number }>(
    `SELECT signup_id, beta_invitation_id, admitted_wave
     FROM public_presence_waitlist_signups
     WHERE LOWER(email) = LOWER($1)
       AND admitted_wave IS NOT NULL
       AND beta_invitation_id IS NOT NULL
     LIMIT 1`,
    [email],
  );
  return result.rows[0] ?? null;
}

/**
 * Cheap, single-purpose count for the public landing-page waitlist counter.
 * Deliberately separate from {@link getWaitlistMetrics} (admin-only, returns
 * a role breakdown) so the public route never has a reason to expose more
 * than the one number it displays.
 */
export async function getWaitlistSignupCount(db: PgQueryable): Promise<number> {
  const result = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM public_presence_waitlist_signups`);
  return Number(result.rows[0]?.count ?? 0);
}

export async function getWaitlistMetrics(db: PgQueryable): Promise<WaitlistMetrics> {
  const result = await db.query<{
    total_count: string;
    buy_count: string;
    sell_count: string;
    both_count: string;
  }>(
    `SELECT
       COUNT(*) AS total_count,
       COUNT(*) FILTER (WHERE role = 'buy') AS buy_count,
       COUNT(*) FILTER (WHERE role = 'sell') AS sell_count,
       COUNT(*) FILTER (WHERE role = 'both') AS both_count
     FROM public_presence_waitlist_signups`,
  );
  const row = result.rows[0];

  return {
    total_count: Number(row?.total_count ?? 0),
    buy_count: Number(row?.buy_count ?? 0),
    sell_count: Number(row?.sell_count ?? 0),
    both_count: Number(row?.both_count ?? 0),
  };
}

/** A signup counts toward seller inventory quality only with sell/both intent AND at least one named game AND a real inventory-size bucket. */
const qualifiedSellerFilterSql = `role IN ('sell', 'both') AND jsonb_array_length(games) > 0 AND inventory_size IS NOT NULL`;

/**
 * Wave-1 cohort quality metrics: games distribution vs the five-game
 * coverage matrix, store-link rate, and inventory-size distribution, each
 * scoped to the seller signup population the campaign quality bar actually
 * measures.
 */
export async function getCampaignQualityMetrics(db: PgQueryable): Promise<CampaignQualityMetrics> {
  const totalsResult = await db.query<{
    total_signups: string;
    seller_signup_count: string;
    qualified_seller_count: string;
    store_link_count: string;
  }>(
    `SELECT
       COUNT(*) AS total_signups,
       COUNT(*) FILTER (WHERE role IN ('sell', 'both')) AS seller_signup_count,
       COUNT(*) FILTER (WHERE ${qualifiedSellerFilterSql}) AS qualified_seller_count,
       COUNT(*) FILTER (WHERE role IN ('sell', 'both') AND has_store_link) AS store_link_count
     FROM public_presence_waitlist_signups`,
  );
  const totals = totalsResult.rows[0];
  const sellerSignupCount = Number(totals?.seller_signup_count ?? 0);
  const storeLinkCount = Number(totals?.store_link_count ?? 0);

  const inventoryResult = await db.query<{ inventory_size: string; count: string }>(
    `SELECT inventory_size, COUNT(*) AS count
     FROM public_presence_waitlist_signups
     WHERE role IN ('sell', 'both') AND inventory_size IS NOT NULL
     GROUP BY inventory_size`,
  );
  const inventorySizeDistribution = Object.fromEntries(
    WAITLIST_INVENTORY_SIZES.map((size) => [size, 0]),
  ) as CampaignQualityMetrics["inventorySizeDistribution"];
  for (const row of inventoryResult.rows) {
    if (row.inventory_size in inventorySizeDistribution) {
      (inventorySizeDistribution as Record<string, number>)[row.inventory_size] = Number(row.count);
    }
  }

  const gameCountResults = await Promise.all(
    WAITLIST_GAMES.map((game) =>
      db.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM public_presence_waitlist_signups
         WHERE ${qualifiedSellerFilterSql} AND games @> $1::jsonb`,
        [JSON.stringify([game])],
      ),
    ),
  );
  const qualifiedSellersByGame = Object.fromEntries(
    WAITLIST_GAMES.map((game, index) => [game, Number(gameCountResults[index]?.rows[0]?.count ?? 0)]),
  ) as CampaignQualityMetrics["qualifiedSellersByGame"];

  return {
    totalSignups: Number(totals?.total_signups ?? 0),
    sellerSignupCount,
    qualifiedSellerCount: Number(totals?.qualified_seller_count ?? 0),
    storeLinkCount,
    storeLinkPercent: sellerSignupCount > 0 ? Math.round((storeLinkCount / sellerSignupCount) * 1000) / 10 : 0,
    inventorySizeDistribution,
    qualifiedSellersByGame,
  };
}

/**
 * Channel/content-piece attribution: signup counts grouped by the durable
 * UTM fields captured at signup time, ordered by volume. Reads the durable
 * waitlist read model (not the directional funnel-event telemetry in
 * Grafana/Loki -- see bounded-contexts/public-presence/docs/landing-page-analytics.md),
 * so every row here is transactional truth, not sampled or client-JS-dependent.
 */
export async function getCampaignChannelAttribution(
  db: PgQueryable,
  limit = 25,
): Promise<readonly CampaignChannelAttributionRow[]> {
  const result = await db.query<{
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    signup_count: string;
    seller_signup_count: string;
    qualified_seller_count: string;
  }>(
    `SELECT
       utm_source,
       utm_medium,
       utm_campaign,
       COUNT(*) AS signup_count,
       COUNT(*) FILTER (WHERE role IN ('sell', 'both')) AS seller_signup_count,
       COUNT(*) FILTER (WHERE ${qualifiedSellerFilterSql}) AS qualified_seller_count
     FROM public_presence_waitlist_signups
     GROUP BY utm_source, utm_medium, utm_campaign
     ORDER BY signup_count DESC, utm_source NULLS LAST, utm_medium NULLS LAST, utm_campaign NULLS LAST
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 100))],
  );

  return result.rows.map((row) => ({
    utm_source: row.utm_source,
    utm_medium: row.utm_medium,
    utm_campaign: row.utm_campaign,
    signup_count: Number(row.signup_count),
    seller_signup_count: Number(row.seller_signup_count),
    qualified_seller_count: Number(row.qualified_seller_count),
  }));
}
