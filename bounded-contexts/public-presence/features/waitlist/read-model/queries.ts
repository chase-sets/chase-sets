import { escapeLikePattern, type PgQueryable } from "@chase-sets/event-core-postgres";
import type { WaitlistMetrics, WaitlistSignupListItem } from "../api/contracts";

function normalizePageParams(params: Readonly<{ limit?: number; offset?: number }>) {
  return {
    limit: Math.max(1, Math.min(params.limit ?? 100, 500)),
    offset: Math.max(0, params.offset ?? 0),
  };
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
       signup_id,
       email,
       role,
       interests,
       email_consent_accepted_at::text AS email_consent_accepted_at,
       marketing_consent_accepted_at::text AS marketing_consent_accepted_at,
       page_path,
       referrer,
       utm_source,
       utm_medium,
       utm_campaign,
       utm_content,
       utm_term,
       submitted_at::text AS submitted_at,
       updated_at::text AS updated_at
     FROM public_presence_waitlist_signups
     ${filters.where}
     ORDER BY updated_at DESC, signup_id DESC
     LIMIT $${filters.values.length + 1} OFFSET $${filters.values.length + 2}`,
    [...filters.values, limit, offset],
  );

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
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
