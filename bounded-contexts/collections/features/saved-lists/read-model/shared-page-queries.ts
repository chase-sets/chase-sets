import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { SavedListId, SavedListLineId, SavedListProductSelection, SavedListVisibility } from "../domain/contracts";

export type SavedListSharedPageRecord = Readonly<{
  listId: SavedListId;
  ownerAccountId: AccountId;
  title: string;
  description: string | null;
  visibility: SavedListVisibility;
  lifecycle: "active" | "archived";
  coverLineId: SavedListLineId | null;
  lineCount: number;
  showTrackedQuantities: boolean;
  showCurrentEstimatedValue: boolean;
  sourceChangedAt: string;
  sourceVersion: number;
  policyVersion: number;
  unlistedVerifier: string | null;
  unlistedGeneration: number;
  lines: readonly Readonly<{
    lineId: SavedListLineId;
    product: SavedListProductSelection;
    trackedQuantity: number;
    position: number;
  }>[];
}>;

type PageRow = Readonly<{
  list_id: SavedListId;
  owner_account_id: AccountId;
  title: string;
  description: string | null;
  visibility: SavedListVisibility;
  lifecycle: "active" | "archived";
  cover_line_id: SavedListLineId | null;
  ordered_line_ids: unknown;
  line_count: number;
  show_tracked_quantities: boolean;
  show_current_estimated_value: boolean;
  source_changed_at: string;
  source_version: number;
  policy_version: number;
  unlisted_verifier: string | null;
  unlisted_generation: number;
}>;
type LineRow = Readonly<{
  line_id: SavedListLineId;
  product: SavedListProductSelection;
  tracked_quantity: number;
}>;

export async function loadSavedListSharedPage(
  db: PgQueryable,
  listId: SavedListId,
): Promise<SavedListSharedPageRecord | null> {
  const pageResult = await db.query<PageRow>(
    `SELECT
       page.list_id,
       access.owner_account_id,
       page.title,
       page.description,
       page.visibility,
       page.lifecycle,
       page.cover_line_id,
       page.ordered_line_ids,
       page.line_count,
       page.show_tracked_quantities,
       page.show_current_estimated_value,
       page.source_changed_at::text AS source_changed_at,
       page.source_version,
       page.policy_version,
       access.unlisted_verifier,
       access.unlisted_generation
     FROM collections_saved_list_shared_pages page
     JOIN collections_saved_list_access_policies access USING (list_id)
     WHERE page.list_id = $1`,
    [listId],
  );
  const page = pageResult.rows[0];
  if (!page) return null;
  const lineResult = await db.query<LineRow>(
    `SELECT line_id, product, tracked_quantity
     FROM collections_saved_list_shared_lines
     WHERE list_id = $1`,
    [listId],
  );
  const order = stringArray(page.ordered_line_ids);
  const position = new Map(order.map((lineId, index) => [lineId, index]));
  const lines = lineResult.rows
    .filter((line) => position.has(line.line_id))
    .map((line) => ({
      lineId: line.line_id,
      product: line.product,
      trackedQuantity: Number(line.tracked_quantity),
      position: position.get(line.line_id) ?? 0,
    }))
    .sort((left, right) => left.position - right.position);
  return {
    listId: page.list_id,
    ownerAccountId: page.owner_account_id,
    title: page.title,
    description: page.description,
    visibility: page.visibility,
    lifecycle: page.lifecycle,
    coverLineId: page.cover_line_id,
    lineCount: Number(page.line_count),
    showTrackedQuantities: page.show_tracked_quantities,
    showCurrentEstimatedValue: page.show_current_estimated_value,
    sourceChangedAt: page.source_changed_at,
    sourceVersion: Number(page.source_version),
    policyVersion: Number(page.policy_version),
    unlistedVerifier: page.unlisted_verifier,
    unlistedGeneration: Number(page.unlisted_generation),
    lines,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
