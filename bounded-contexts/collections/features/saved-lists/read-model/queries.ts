import { createHash } from "node:crypto";
import { escapeLikePattern, type PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type {
  SavedListId,
  SavedListLifecycleState,
  SavedListLineId,
  SavedListProductAvailability,
  SavedListProductSelection,
  SavedListSelectedOption,
  SavedListVisibility,
} from "../domain/contracts";
import type {
  MyCollectionSavedListsModule,
  SavedListCatalogDisplay,
  SavedListCatalogOptionDisplay,
  SavedListDetailQuery,
  SavedListDetailReadModel,
  SavedListReadCover,
  SavedListReadLine,
  SavedListSummaryPage,
  SavedListSummaryQuery,
  SavedListSummaryReadModel,
} from "./contracts";

const defaultPageSize = 25;
const maximumPageSize = 100;

type CursorPayload = Readonly<{
  v: 1;
  createdAt: string;
  listId: string;
  snapshotPosition: string;
  total: number;
  filterHash: string;
}>;

type CatalogFields = Readonly<{
  catalog_item_present: string | null;
  catalog_language_code: string | null;
  catalog_title: string | null;
  catalog_subtitle: string | null;
  catalog_status: string | null;
  catalog_options: unknown;
  catalog_updated_at: string | null;
}>;

type SummaryRow = CatalogFields &
  Readonly<{
    list_id: string;
    owner_account_id: string;
    title: string;
    description: string | null;
    visibility: string;
    lifecycle: string;
    cover_line_id: string | null;
    cover_catalog_item_id: string | null;
    cover_product_id: string | null;
    cover_selected_options: unknown;
    line_count: number;
    tracked_unit_count: string | number;
    created_at: string;
    changed_at: string;
    archived_at: string | null;
    last_stream_version: number;
    snapshot_position: string;
    total_count: string | number;
  }>;

type DetailRow = CatalogFields &
  Readonly<{
    list_id: string;
    owner_account_id: string;
    title: string;
    description: string | null;
    visibility: string;
    lifecycle: string;
    cover_line_id: string | null;
    line_count: number;
    tracked_unit_count: string | number;
    created_at: string;
    changed_at: string;
    archived_at: string | null;
    last_stream_version: number;
    line_id: string | null;
    catalog_item_id: string | null;
    product_id: string | null;
    selected_options: unknown;
    tracked_quantity: number | null;
    private_notes: string | null;
    private_tags: unknown;
    position: number | null;
    added_at: string | null;
    line_changed_at: string | null;
  }>;

export class SavedListQueryError extends Error {
  readonly code = "invalid-cursor" as const;

  constructor() {
    super("Invalid Saved List page cursor.");
    this.name = "SavedListQueryError";
  }
}

export async function listSavedListSummaries(
  db: PgQueryable,
  input: SavedListSummaryQuery,
): Promise<SavedListSummaryPage> {
  const normalized = normalizeSummaryQuery(input);
  const cursor = decodeCursor(input.cursor);
  if (cursor && cursor.filterHash !== normalized.filterHash) {
    throw new SavedListQueryError();
  }

  const values: unknown[] = [input.ownerAccountId];
  const conditions = ["summary.owner_account_id = $1"];

  if (normalized.lifecycle !== "all") {
    values.push(normalized.lifecycle);
    conditions.push(`summary.lifecycle = $${values.length}`);
  }
  if (normalized.visibilities.length > 0) {
    values.push(normalized.visibilities);
    conditions.push(`summary.visibility = ANY($${values.length}::text[])`);
  }
  if (normalized.search) {
    values.push(normalized.search);
    const searchIndex = values.length;
    values.push(`%${escapeLikePattern(normalized.search)}%`);
    const patternIndex = values.length;
    conditions.push(`(
      to_tsvector('simple', summary.title || ' ' || COALESCE(summary.description, ''))
        @@ plainto_tsquery('simple', $${searchIndex})
      OR EXISTS (
        SELECT 1
        FROM collections_saved_list_lines AS search_line
        LEFT JOIN collections_catalog_items AS search_item
          ON search_item.catalog_item_id = search_line.catalog_item_id
        WHERE search_line.list_id = summary.list_id
          AND (
            search_line.product_id ILIKE $${patternIndex} ESCAPE '\\'
            OR search_line.catalog_item_id ILIKE $${patternIndex} ESCAPE '\\'
            OR to_tsvector(
                 'simple',
                 COALESCE(search_item.title, '') || ' ' || COALESCE(search_item.subtitle, '')
               ) @@ plainto_tsquery('simple', $${searchIndex})
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(search_line.selected_options) AS selected(value)
              LEFT JOIN collections_catalog_dimension_options AS catalog_option
                ON catalog_option.option_id = selected.value->>'optionId'
              WHERE selected.value->>'optionId' ILIKE $${patternIndex} ESCAPE '\\'
                 OR to_tsvector(
                      'simple',
                      COALESCE(catalog_option.label, '') || ' ' || COALESCE(catalog_option.code, '')
                    ) @@ plainto_tsquery('simple', $${searchIndex})
            )
          )
      )
    )`);
  }

  values.push(cursor?.snapshotPosition ?? null);
  const snapshotIndex = values.length;
  conditions.push("summary.created_global_position <= snapshot.snapshot_position");

  if (cursor) {
    values.push(cursor.createdAt, cursor.listId);
    conditions.push(`(summary.created_at, summary.list_id) < ($${values.length - 1}::timestamptz, $${values.length})`);
  }

  values.push(normalized.limit + 1);
  const limitIndex = values.length;
  const result = await db.query<SummaryRow>(
    `WITH snapshot AS (
       SELECT COALESCE(
         $${snapshotIndex}::bigint,
         MAX(created_global_position),
         0
       ) AS snapshot_position
       FROM collections_saved_list_summaries
       WHERE owner_account_id = $1
     )
     SELECT
       summary.list_id,
       summary.owner_account_id,
       summary.title,
       summary.description,
       summary.visibility,
       summary.lifecycle,
       summary.cover_line_id,
       summary.line_count,
       summary.tracked_unit_count,
       summary.created_at,
       summary.changed_at,
       summary.archived_at,
       summary.last_stream_version,
       cover.catalog_item_id AS cover_catalog_item_id,
       cover.product_id AS cover_product_id,
       cover.selected_options AS cover_selected_options,
       catalog.catalog_item_id AS catalog_item_present,
       catalog.language_code AS catalog_language_code,
       catalog.title AS catalog_title,
       catalog.subtitle AS catalog_subtitle,
       catalog.status AS catalog_status,
       catalog.updated_at AS catalog_updated_at,
       COALESCE(option_display.options, '[]'::jsonb) AS catalog_options,
       snapshot.snapshot_position::text AS snapshot_position,
       COUNT(*) OVER() AS total_count
     FROM collections_saved_list_summaries AS summary
     CROSS JOIN snapshot
     LEFT JOIN collections_saved_list_lines AS cover
       ON cover.list_id = summary.list_id
      AND cover.line_id = summary.cover_line_id
     LEFT JOIN collections_catalog_items AS catalog
       ON catalog.catalog_item_id = cover.catalog_item_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_build_object(
           'dimensionId', selected.value->>'dimensionId',
           'dimensionName', dimension.name,
           'optionId', selected.value->>'optionId',
           'optionLabel', catalog_option.label
         )
         ORDER BY selected.ordinality
       ) AS options
       FROM jsonb_array_elements(COALESCE(cover.selected_options, '[]'::jsonb))
         WITH ORDINALITY AS selected(value, ordinality)
       LEFT JOIN collections_catalog_dimensions AS dimension
         ON dimension.dimension_id = selected.value->>'dimensionId'
       LEFT JOIN collections_catalog_dimension_options AS catalog_option
         ON catalog_option.option_id = selected.value->>'optionId'
     ) AS option_display ON true
     WHERE ${conditions.join("\n       AND ")}
     ORDER BY summary.created_at DESC, summary.list_id DESC
     LIMIT $${limitIndex}`,
    values,
  );

  const pageRows = result.rows.slice(0, normalized.limit);
  const total = cursor?.total ?? Number(result.rows[0]?.total_count ?? 0);
  const nextCursor =
    result.rows.length > normalized.limit && pageRows.length > 0
      ? encodeCursor({
          v: 1,
          createdAt: pageRows.at(-1)!.created_at,
          listId: pageRows.at(-1)!.list_id,
          snapshotPosition: cursor?.snapshotPosition ?? pageRows[0]!.snapshot_position,
          total,
          filterHash: normalized.filterHash,
        })
      : null;

  return {
    items: pageRows.map(toSummary),
    total,
    nextCursor,
  };
}

export async function loadSavedListDetail(
  db: PgQueryable,
  input: SavedListDetailQuery,
): Promise<SavedListDetailReadModel | null> {
  const result = await db.query<DetailRow>(
    `SELECT
       summary.list_id,
       summary.owner_account_id,
       summary.title,
       summary.description,
       summary.visibility,
       summary.lifecycle,
       summary.cover_line_id,
       summary.line_count,
       summary.tracked_unit_count,
       summary.created_at,
       summary.changed_at,
       summary.archived_at,
       summary.last_stream_version,
       line.line_id,
       line.catalog_item_id,
       line.product_id,
       line.selected_options,
       line.tracked_quantity,
       line.private_notes,
       line.private_tags,
       line.position,
       line.added_at,
       line.changed_at AS line_changed_at,
       catalog.catalog_item_id AS catalog_item_present,
       catalog.language_code AS catalog_language_code,
       catalog.title AS catalog_title,
       catalog.subtitle AS catalog_subtitle,
       catalog.status AS catalog_status,
       catalog.updated_at AS catalog_updated_at,
       COALESCE(option_display.options, '[]'::jsonb) AS catalog_options
     FROM collections_saved_list_summaries AS summary
     LEFT JOIN collections_saved_list_lines AS line
       ON line.list_id = summary.list_id
     LEFT JOIN collections_catalog_items AS catalog
       ON catalog.catalog_item_id = line.catalog_item_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_build_object(
           'dimensionId', selected.value->>'dimensionId',
           'dimensionName', dimension.name,
           'optionId', selected.value->>'optionId',
           'optionLabel', catalog_option.label
         )
         ORDER BY selected.ordinality
       ) AS options
       FROM jsonb_array_elements(COALESCE(line.selected_options, '[]'::jsonb))
         WITH ORDINALITY AS selected(value, ordinality)
       LEFT JOIN collections_catalog_dimensions AS dimension
         ON dimension.dimension_id = selected.value->>'dimensionId'
       LEFT JOIN collections_catalog_dimension_options AS catalog_option
         ON catalog_option.option_id = selected.value->>'optionId'
     ) AS option_display ON true
     WHERE summary.list_id = $1
       AND summary.owner_account_id = $2
     ORDER BY line.position ASC NULLS LAST, line.line_id ASC NULLS LAST`,
    [input.listId, input.ownerAccountId],
  );

  const summary = result.rows[0];
  if (!summary) {
    return null;
  }

  const lines = result.rows.flatMap((row) => {
    const line = toLine(row);
    return line ? [line] : [];
  });
  const coverLine = summary.cover_line_id
    ? (lines.find((line) => line.lineId === summary.cover_line_id) ?? null)
    : null;

  return {
    ...toSummaryBase(summary, coverLine ? toCover(coverLine) : null),
    lines,
  };
}

export async function loadMyCollectionSavedListsModule(
  db: PgQueryable,
  input: SavedListSummaryQuery,
): Promise<MyCollectionSavedListsModule> {
  return {
    contractVersion: 1,
    kind: "saved-lists",
    savedLists: await listSavedListSummaries(db, input),
  };
}

function toSummary(row: SummaryRow): SavedListSummaryReadModel {
  const product =
    row.cover_line_id && row.cover_catalog_item_id && row.cover_product_id
      ? productSelection(row.cover_catalog_item_id, row.cover_product_id, row.cover_selected_options)
      : null;
  const cover: SavedListReadCover | null =
    product && row.cover_line_id
      ? {
          lineId: row.cover_line_id as SavedListLineId,
          product,
          catalog: catalogDisplay(row),
        }
      : null;

  return toSummaryBase(row, cover);
}

function toSummaryBase(
  row: Pick<
    SummaryRow,
    | "list_id"
    | "owner_account_id"
    | "title"
    | "description"
    | "visibility"
    | "lifecycle"
    | "line_count"
    | "tracked_unit_count"
    | "created_at"
    | "changed_at"
    | "archived_at"
    | "last_stream_version"
  >,
  cover: SavedListReadCover | null,
): SavedListSummaryReadModel {
  return {
    contractVersion: 1,
    listId: row.list_id as SavedListId,
    ownerAccountId: row.owner_account_id as AccountId,
    title: row.title,
    description: row.description,
    visibility: row.visibility as SavedListVisibility,
    lifecycle: row.lifecycle as SavedListLifecycleState,
    cover,
    lineCount: Number(row.line_count),
    trackedUnitCount: Number(row.tracked_unit_count),
    createdAt: row.created_at,
    changedAt: row.changed_at,
    archivedAt: row.archived_at,
    version: Number(row.last_stream_version),
  };
}

function toLine(row: DetailRow): SavedListReadLine | null {
  if (
    !row.line_id ||
    !row.catalog_item_id ||
    !row.product_id ||
    row.tracked_quantity === null ||
    row.position === null ||
    !row.added_at ||
    !row.line_changed_at
  ) {
    return null;
  }

  return {
    lineId: row.line_id as SavedListLineId,
    product: productSelection(row.catalog_item_id, row.product_id, row.selected_options),
    catalog: catalogDisplay(row),
    trackedQuantity: Number(row.tracked_quantity),
    privateNotes: row.private_notes,
    privateTags: stringArray(row.private_tags),
    position: Number(row.position),
    addedAt: row.added_at,
    changedAt: row.line_changed_at,
  };
}

function toCover(line: SavedListReadLine): SavedListReadCover {
  return {
    lineId: line.lineId,
    product: line.product,
    catalog: line.catalog,
  };
}

function productSelection(
  catalogItemId: string,
  productId: string,
  selectedOptions: unknown,
): SavedListProductSelection {
  return {
    catalogItemId: catalogItemId as SavedListProductSelection["catalogItemId"],
    productId: productId as SavedListProductSelection["productId"],
    selectedOptions: selectedOptionArray(selectedOptions),
  };
}

function selectedOptionArray(value: unknown): SavedListSelectedOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    return typeof record.dimensionId === "string" && typeof record.optionId === "string"
      ? [{ dimensionId: record.dimensionId, optionId: record.optionId }]
      : [];
  });
}

function catalogDisplay(row: CatalogFields): SavedListCatalogDisplay {
  return {
    availability: catalogAvailability(row.catalog_item_present, row.catalog_status),
    languageCode: row.catalog_language_code,
    title: row.catalog_title,
    subtitle: row.catalog_subtitle,
    selectedOptions: catalogOptionArray(row.catalog_options),
    updatedAt: row.catalog_updated_at,
  };
}

function catalogAvailability(itemId: string | null, status: string | null): SavedListProductAvailability {
  if (!itemId || status === "missing") {
    return "missing";
  }
  if (status === "retired") {
    return "retired";
  }
  return status === "active" ? "active" : "unavailable";
}

function catalogOptionArray(value: unknown): SavedListCatalogOptionDisplay[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.dimensionId !== "string" || typeof record.optionId !== "string") {
      return [];
    }
    return [
      {
        dimensionId: record.dimensionId,
        dimensionName: typeof record.dimensionName === "string" ? record.dimensionName : null,
        optionId: record.optionId,
        optionLabel: typeof record.optionLabel === "string" ? record.optionLabel : null,
      },
    ];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeSummaryQuery(input: SavedListSummaryQuery) {
  const search = input.search?.trim() ?? "";
  const lifecycle = input.lifecycle ?? "active";
  const visibilities = [...new Set(input.visibilities ?? [])].sort();
  const limit = Number.isFinite(input.limit ?? Number.NaN)
    ? Math.max(1, Math.min(maximumPageSize, Math.trunc(input.limit!)))
    : defaultPageSize;
  const filterHash = createHash("sha256")
    .update(JSON.stringify({ search: search.toLocaleLowerCase(), lifecycle, visibilities }))
    .digest("base64url")
    .slice(0, 16);

  return { search, lifecycle, visibilities, limit, filterHash };
}

function encodeCursor(cursor: CursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null | undefined): CursorPayload | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new SavedListQueryError();
    }
    const cursor = parsed as Record<string, unknown>;
    if (
      cursor.v !== 1 ||
      typeof cursor.createdAt !== "string" ||
      !Number.isFinite(Date.parse(cursor.createdAt)) ||
      typeof cursor.listId !== "string" ||
      cursor.listId.length === 0 ||
      typeof cursor.snapshotPosition !== "string" ||
      !/^\d+$/.test(cursor.snapshotPosition) ||
      typeof cursor.total !== "number" ||
      !Number.isSafeInteger(cursor.total) ||
      cursor.total < 0 ||
      typeof cursor.filterHash !== "string" ||
      cursor.filterHash.length === 0
    ) {
      throw new SavedListQueryError();
    }
    return cursor as CursorPayload;
  } catch (error) {
    if (error instanceof SavedListQueryError) {
      throw error;
    }
    throw new SavedListQueryError();
  }
}
