import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";

/**
 * Runtime services for the Customer Feedback context.
 *
 * At the start gate the context exposes contracts and its event-store base only;
 * the invitation aggregate, its event store wake wiring, and projections are added
 * by #5147/#5148. Services here therefore hold just the pool/query handles those
 * leaves extend.
 */
export type CustomerFeedbackServices = Readonly<{
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export type CustomerFeedbackHostPorts = Readonly<Record<string, never>>;

export function createCustomerFeedbackServices(
  pool: PgTransactionalPool,
  _ports: CustomerFeedbackHostPorts = {},
): CustomerFeedbackServices {
  return { pool, db: pool as PgQueryable };
}
