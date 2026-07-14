import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { SavedListId } from "../domain/contracts";

export type RecentSavedList = Readonly<{
  listId: SavedListId;
  title: string;
  lineCount: number;
  trackedUnitCount: number;
  version: number;
  changedAt: string;
}>;

type RecentSavedListRow = Readonly<{
  list_id: string;
  title: string;
  line_count: number;
  tracked_unit_count: number;
  list_version: number;
  changed_at: string;
}>;

export async function listRecentSavedLists(
  db: PgQueryable,
  input: Readonly<{ ownerAccountId: string; limit?: number }>,
): Promise<readonly RecentSavedList[]> {
  const limit = Math.min(20, Math.max(1, input.limit ?? 8));
  const result = await db.query<RecentSavedListRow>(
    `SELECT list_id, title, line_count, tracked_unit_count, list_version, changed_at
     FROM collections_saved_list_picker
     WHERE owner_account_id = $1
       AND lifecycle = 'active'
     ORDER BY changed_at DESC, list_id DESC
     LIMIT $2`,
    [input.ownerAccountId, limit],
  );

  return result.rows.map((row) => ({
    listId: row.list_id as SavedListId,
    title: row.title,
    lineCount: Number(row.line_count),
    trackedUnitCount: Number(row.tracked_unit_count),
    version: Number(row.list_version),
    changedAt: new Date(row.changed_at).toISOString(),
  }));
}
