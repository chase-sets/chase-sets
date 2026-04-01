import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";

export async function seedOrderingDatabase(_pool: PgTransactionalPool) {
  // Ordering intentionally starts empty in v1 so checkout and offer acceptance
  // exercise the live orchestration path instead of prebuilt commitments.
}
