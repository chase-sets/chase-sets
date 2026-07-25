import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type C = Readonly<{ db: PgQueryable }>;
