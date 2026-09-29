import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ListingAuthorityOwner } from "@chase-sets/event-core/listing-authority";

export type ListingAuthorityRecoveryCursor = Readonly<{ eventAfter: string; sqlAfter: string }>;
const initial = { eventAfter: "0", sqlAfter: "" } as const;

function valid(cursor: ListingAuthorityRecoveryCursor) {
  return (
    typeof cursor.eventAfter === "string" &&
    /^\d+$/.test(cursor.eventAfter) &&
    typeof cursor.sqlAfter === "string" &&
    cursor.sqlAfter.length <= 512
  );
}

/** An owner-local, replaceable discovery index. Canonical journals still decide every recovery effect. */
export function createListingAuthorityRecoveryCursorStore(db: PgQueryable, owner: ListingAuthorityOwner) {
  return {
    async load() {
      const { rows } = await db.query<{ revision: string; event_after: string; sql_after: string }>(
        "SELECT revision::text, event_after, sql_after FROM listing_authority_recovery_cursors WHERE owner=$1",
        [owner],
      );
      const row = rows[0];
      if (!row) return { revision: "0", cursor: initial };
      if (!/^[1-9]\d*$/.test(row.revision)) throw new Error("Invalid authority recovery cursor revision.");
      const cursor = { eventAfter: row.event_after, sqlAfter: row.sql_after };
      return { revision: row.revision, cursor: valid(cursor) ? cursor : initial };
    },
    async save(revision: string, cursor: ListingAuthorityRecoveryCursor) {
      if (!/^\d+$/.test(revision) || !valid(cursor)) throw new Error("Invalid authority recovery cursor.");
      if (revision === "0") {
        const { rows } = await db.query<{ revision: string }>(
          `
        INSERT INTO listing_authority_recovery_cursors (owner,revision,event_after,sql_after)
        SELECT $1,1,$3,$4 WHERE $2::bigint=0
        ON CONFLICT (owner) DO NOTHING RETURNING revision::text`,
          [owner, revision, cursor.eventAfter, cursor.sqlAfter],
        );
        return rows.length === 1;
      }
      const updated = await db.query<{ revision: string }>(
        `
        UPDATE listing_authority_recovery_cursors SET revision=revision+1,event_after=$3,sql_after=$4,updated_at=now()
        WHERE owner=$1 AND revision=$2::bigint RETURNING revision::text`,
        [owner, revision, cursor.eventAfter, cursor.sqlAfter],
      );
      return updated.rows.length === 1;
    },
  };
}
