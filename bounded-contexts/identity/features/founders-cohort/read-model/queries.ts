import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { FOUNDERS_COHORT_CAP } from "../domain/domain";

export type FoundersCohortCount = Readonly<{ claimed: number; cap: number; remaining: number }>;

export async function getFoundersCohortCount(db: PgQueryable): Promise<FoundersCohortCount> {
  const result = await db.query<{ claimed: string | number }>(
    `SELECT COUNT(*)::integer AS claimed FROM identity_founder_claims`,
  );
  const claimed = Number(result.rows[0]?.claimed ?? 0);
  return { claimed, cap: FOUNDERS_COHORT_CAP, remaining: Math.max(0, FOUNDERS_COHORT_CAP - claimed) };
}
