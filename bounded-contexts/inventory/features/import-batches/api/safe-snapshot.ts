import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { inventoryMutationFingerprint } from "../../../support/runtime-support/mutation-intent";
import { parseImportCsv, type ImportCsvRow } from "../domain/csv";
import {
  getInventoryImportSourceAdapter,
  type InventoryImportQuantityMode,
  type InventoryImportSourceKey,
  type NormalizedInventoryImportRow,
} from "../domain/import-source-adapters";

export const INVENTORY_IMPORT_SNAPSHOT_PAGE_SIZE = 100;
const valueKeys = new Set([
  "catalogItemId",
  "productId",
  "storageLocationId",
  "totalQuantity",
  "acquisitionOccurredAt",
  "acquisitionCostAmount",
  "acquisitionCostCurrencyCode",
  "sellerSku",
  "listingPriceAmount",
  "listingPriceCurrencyCode",
  "listingQuantityCap",
  "rowNote",
  "sourceListId",
  "sourceListVersion",
  "sourceLineId",
  "sourceRowId",
  "sourcePriceAmount",
  "sourceQuantity",
  "storageLocation",
]);
const rowKeys = [
  "rowNumber",
  "values",
  "rawRow",
  "externalReference",
  "externalReferences",
  "selectedOptionCandidates",
  "rowFingerprint",
];
const referenceKeys = ["providerKey", "externalKey", "displayName", "targetIntent"];
const targetIntents = [
  "product-reference",
  "catalog-item-reference",
  "account-sku",
  "gtin-reference",
  "source-listing-reference",
  "source-product-reference",
];

export type InventoryImportSnapshotInput = Readonly<{
  accountId: string;
  csvText?: string;
  parsedRows?: readonly ImportCsvRow[];
  sourceKey?: InventoryImportSourceKey;
  quantityMode?: InventoryImportQuantityMode;
  defaultStorageLocationId?: string | null;
}>;

export type InventoryImportSnapshotHeader = Readonly<{
  version: 1;
  accountId: string;
  sourceKey: InventoryImportSourceKey;
  adapterVersion: number;
  quantityMode: InventoryImportQuantityMode;
  defaultStorageLocationId: string | null;
  rowCount: number;
  hash: string;
}>;
export type InventoryImportSnapshot = Readonly<{
  header: InventoryImportSnapshotHeader;
  rows: readonly NormalizedInventoryImportRow[];
}>;
type ProofNode = Readonly<{ hash: string; side: "left" | "right" }>;

function rowLeaf(row: NormalizedInventoryImportRow) {
  return inventoryMutationFingerprint({ rowNumber: row.rowNumber, rowFingerprint: row.rowFingerprint });
}

function snapshotTree(rows: readonly NormalizedInventoryImportRow[]) {
  const levels = [rows.map(rowLeaf)];
  while (levels[levels.length - 1].length > 1) {
    const previous = levels[levels.length - 1];
    const next: string[] = [];
    for (let index = 0; index < previous.length; index += 2) {
      next.push(inventoryMutationFingerprint({ left: previous[index], right: previous[index + 1] ?? previous[index] }));
    }
    levels.push(next);
  }
  return {
    root: levels[levels.length - 1][0],
    proof: (index: number): readonly ProofNode[] => {
      const proof: ProofNode[] = [];
      for (const level of levels.slice(0, -1)) {
        const right = index % 2 === 0;
        proof.push({ side: right ? "right" : "left", hash: level[right ? index + 1 : index - 1] ?? level[index] });
        index = Math.floor(index / 2);
      }
      return proof;
    },
  };
}

function verifyRowProof(
  header: InventoryImportSnapshotHeader,
  row: NormalizedInventoryImportRow,
  index: number,
  value: unknown,
) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= header.rowCount || !Array.isArray(value)) invalid();
  let width = header.rowCount;
  let hash = rowLeaf(row);
  let step = 0;
  while (width > 1) {
    const node = object(value[step++], ["hash", "side"]);
    const right = index % 2 === 0;
    if (node.side !== (right ? "right" : "left") || typeof node.hash !== "string" || !/^[a-f0-9]{64}$/.test(node.hash))
      invalid();
    if (right && index + 1 === width && node.hash !== hash) invalid();
    hash = inventoryMutationFingerprint(right ? { left: hash, right: node.hash } : { left: node.hash, right: hash });
    width = Math.ceil(width / 2);
    index = Math.floor(index / 2);
  }
  const { hash: expected, ...metadata } = header;
  if (step !== value.length || inventoryMutationFingerprint({ ...metadata, root: hash }) !== expected) invalid();
}

function invalid(): never {
  throw new InventoryDomainError("Import source snapshot is invalid; reselect the source or reconcile this attempt.");
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) invalid();
  return result;
}

function safeText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 1_024 ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/u.test(value) ||
    /(?:\b(?:https?|file|s3):\/\/|\b[A-Za-z]:[\\/]|\\\\|\b(?:password|authorization|credential|secret|token)\s*[:=])/i.test(
      value,
    )
  )
    invalid();
  return value.trim();
}

function safeValues(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    if (!valueKeys.has(key) && !/^option:[A-Za-z0-9_-]+$/.test(key)) invalid();
    result[key] = safeText(text);
  }
  return result;
}

function safeRow(row: NormalizedInventoryImportRow): NormalizedInventoryImportRow {
  const values = Object.fromEntries(
    Object.entries({ ...row.rawRow, ...row.values })
      .filter(([key]) => valueKeys.has(key) || /^option:[A-Za-z0-9_-]+$/.test(key))
      .map(([key, text]) => [key, safeText(text)]),
  );
  const externalReferences = row.externalReferences.map((reference) => ({
    providerKey: safeText(reference.providerKey),
    externalKey: safeText(reference.externalKey),
    displayName: reference.displayName === null ? null : safeText(reference.displayName),
    ...(reference.targetIntent ? { targetIntent: reference.targetIntent } : {}),
  }));
  const selectedOptionCandidates = row.selectedOptionCandidates.map((candidate) => ({
    dimensionKey: safeText(candidate.dimensionKey),
    value: safeText(candidate.value),
  }));
  for (const [key, text] of Object.entries(row.rawRow)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      ["storagelocation", "storagelocationname", "location", "locationname"].includes(normalized) &&
      !values.storageLocation
    ) {
      values.storageLocation = safeText(text);
    }
    if (
      ["condition", "form"].includes(normalized) &&
      text.trim() &&
      !selectedOptionCandidates.some((candidate) => candidate.dimensionKey.toLowerCase() === normalized)
    ) {
      selectedOptionCandidates.push({ dimensionKey: normalized, value: safeText(text) });
    }
  }
  const intent = {
    rowNumber: row.rowNumber,
    values,
    rawRow: values,
    externalReference: externalReferences[0] ?? null,
    externalReferences,
    selectedOptionCandidates,
  };
  return { ...intent, rowFingerprint: inventoryMutationFingerprint(intent) };
}

export function prepareInventoryImportLegacySnapshot(
  input: InventoryImportSnapshotInput,
  normalizedRows?: readonly NormalizedInventoryImportRow[],
): InventoryImportSnapshot {
  if (normalizedRows) {
    const rows = normalizedRows.map((row) =>
      safeRow({
        ...row,
        rawRow: row.rawRow ?? row.values,
        externalReferences: row.externalReferences ?? (row.externalReference ? [row.externalReference] : []),
        selectedOptionCandidates: row.selectedOptionCandidates ?? [],
      }),
    );
    return snapshotFromRows(input, rows);
  }
  // Retained v0 jobs were accepted by the original permissive CSV reader.
  // This reader is never used for a new request or a v1 stored snapshot.
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  const text = input.csvText ?? "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      record.push(cell);
      cell = "";
    } else if ((char === "\r" || char === "\n") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
    } else cell += char;
  }
  record.push(cell);
  records.push(record);
  const retained = records.filter((row) => row.some((value) => value.trim()));
  const headers = retained[0]?.map((header) => header.trim()) ?? [];
  const parsedRows =
    input.parsedRows ??
    retained.slice(1).map((cells, index) => ({
      rowNumber: index + 2,
      values: Object.fromEntries(
        headers.flatMap((header, column) => (header ? [[header, cells[column]?.trim() ?? ""]] : [])),
      ),
    }));
  const adapter = getInventoryImportSourceAdapter(input.sourceKey);
  return snapshotFromRows(
    input,
    adapter.normalize({ ...input, parsedRows, quantityMode: input.quantityMode ?? "add" }).map(safeRow),
  );
}

export function readInventoryImportSnapshotRow(value: unknown): NormalizedInventoryImportRow {
  const row = object(value, rowKeys);
  if (!Number.isSafeInteger(row.rowNumber) || Number(row.rowNumber) < 1) invalid();
  safeValues(row.values);
  safeValues(row.rawRow);
  if (inventoryMutationFingerprint(row.values) !== inventoryMutationFingerprint(row.rawRow)) invalid();
  if (
    !Array.isArray(row.externalReferences) ||
    row.externalReferences.length > 32 ||
    !Array.isArray(row.selectedOptionCandidates) ||
    row.selectedOptionCandidates.length > 64
  )
    invalid();
  for (const value of row.externalReferences) {
    const reference = object(value, referenceKeys);
    if (!safeText(reference.providerKey) || !safeText(reference.externalKey)) invalid();
    if (reference.displayName !== null) safeText(reference.displayName);
    if (reference.targetIntent !== undefined && !targetIntents.includes(String(reference.targetIntent))) invalid();
  }
  if (
    inventoryMutationFingerprint(row.externalReference) !==
    inventoryMutationFingerprint(row.externalReferences[0] ?? null)
  )
    invalid();
  for (const value of row.selectedOptionCandidates) {
    const candidate = object(value, ["dimensionKey", "value"]);
    if (!safeText(candidate.dimensionKey) || !safeText(candidate.value)) invalid();
  }
  const { rowFingerprint, ...intent } = row;
  if (rowFingerprint !== inventoryMutationFingerprint(intent)) invalid();
  return row as unknown as NormalizedInventoryImportRow;
}

export function prepareInventoryImportSnapshot(input: InventoryImportSnapshotInput): InventoryImportSnapshot {
  const quantityMode = input.quantityMode ?? "add";
  if (quantityMode !== "add" && quantityMode !== "replace") invalid();
  const adapter = getInventoryImportSourceAdapter(input.sourceKey);
  const parsedRows = input.parsedRows ?? parseImportCsv(input.csvText ?? "");
  const seen = new Set<number>();
  for (const value of parsedRows) {
    const row = object(value, ["rowNumber", "values"]);
    if (!Number.isSafeInteger(row.rowNumber) || Number(row.rowNumber) < 1 || seen.has(Number(row.rowNumber))) invalid();
    seen.add(Number(row.rowNumber));
    if (
      !row.values ||
      typeof row.values !== "object" ||
      Array.isArray(row.values) ||
      Object.values(row.values).some(
        (text) => typeof text !== "string" || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/u.test(text),
      )
    )
      invalid();
  }
  if (!parsedRows.length) throw new InventoryDomainError("Import CSV must include at least one row.");
  if (adapter.sourceKey === "saved-list" && parsedRows.length > 10_000) invalid();
  const rows = adapter.normalize({ ...input, parsedRows, quantityMode }).map(safeRow);
  for (const row of rows) readInventoryImportSnapshotRow(row);
  return snapshotFromRows(input, rows);
}

function snapshotFromRows(
  input: InventoryImportSnapshotInput,
  rows: readonly NormalizedInventoryImportRow[],
): InventoryImportSnapshot {
  const adapter = getInventoryImportSourceAdapter(input.sourceKey);
  const quantityMode = input.quantityMode ?? "add";
  if (
    !rows.length ||
    !["add", "replace"].includes(quantityMode) ||
    new Set(rows.map((row) => row.rowNumber)).size !== rows.length
  )
    invalid();
  for (const row of rows) readInventoryImportSnapshotRow(row);
  const metadata = {
    version: 1 as const,
    accountId: safeText(input.accountId),
    sourceKey: adapter.sourceKey,
    adapterVersion: adapter.adapterVersion,
    quantityMode,
    defaultStorageLocationId:
      input.defaultStorageLocationId == null ? null : safeText(input.defaultStorageLocationId) || null,
    rowCount: rows.length,
  };
  return {
    header: { ...metadata, hash: inventoryMutationFingerprint({ ...metadata, root: snapshotTree(rows).root }) },
    rows,
  };
}

export async function stageInventoryImportSnapshot(
  db: PgQueryable,
  inputId: string,
  snapshot: InventoryImportSnapshot,
) {
  const { header, rows } = snapshot;
  const tree = snapshotTree(rows);
  const { hash, ...metadata } = header;
  if (inventoryMutationFingerprint({ ...metadata, root: tree.root }) !== hash || rows.length !== header.rowCount)
    invalid();
  await db.query(
    `INSERT INTO inventory_import_batch_job_inputs
    (input_id, account_id, snapshot_version, snapshot_hash, row_count, source_key, adapter_version, quantity_mode, default_storage_location_id, created_at)
    VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, now()) ON CONFLICT (input_id) DO UPDATE
    SET snapshot_version = EXCLUDED.snapshot_version, snapshot_hash = EXCLUDED.snapshot_hash,
      row_count = EXCLUDED.row_count, source_key = EXCLUDED.source_key, adapter_version = EXCLUDED.adapter_version,
      quantity_mode = EXCLUDED.quantity_mode, default_storage_location_id = EXCLUDED.default_storage_location_id
    WHERE inventory_import_batch_job_inputs.account_id = EXCLUDED.account_id
      AND inventory_import_batch_job_inputs.snapshot_version IS NULL`,
    [
      inputId,
      header.accountId,
      header.hash,
      header.rowCount,
      header.sourceKey,
      header.adapterVersion,
      header.quantityMode,
      header.defaultStorageLocationId,
    ],
  );
  const retained = await loadInventoryImportSnapshotHeader(db, inputId, header.accountId);
  if (inventoryMutationFingerprint(retained) !== inventoryMutationFingerprint(header)) invalid();
  for (let offset = 0; offset < rows.length; offset += INVENTORY_IMPORT_SNAPSHOT_PAGE_SIZE) {
    await db.query(
      `INSERT INTO inventory_import_snapshot_rows (input_id, row_number, snapshot_version, row_hash, snapshot_row, row_index, row_proof)
      SELECT $1, (row->>'rowNumber')::integer, 1, row->>'rowFingerprint', row - 'rowIndex' - 'proof', (row->>'rowIndex')::integer, row->'proof'
      FROM jsonb_array_elements($2::jsonb) AS row ON CONFLICT (input_id, row_number) DO NOTHING`,
      [
        inputId,
        JSON.stringify(
          rows
            .slice(offset, offset + INVENTORY_IMPORT_SNAPSHOT_PAGE_SIZE)
            .map((row, index) => ({ ...row, rowIndex: offset + index, proof: tree.proof(offset + index) })),
        ),
      ],
    );
  }
}

export async function loadInventoryImportSnapshotHeader(
  db: PgQueryable,
  inputId: string,
  accountId: string,
): Promise<InventoryImportSnapshotHeader> {
  const result = await db.query<{
    account_id: string;
    snapshot_version: number;
    snapshot_hash: string;
    row_count: number;
    source_key: InventoryImportSourceKey;
    adapter_version: number;
    quantity_mode: InventoryImportQuantityMode;
    default_storage_location_id: string | null;
  }>(
    `SELECT account_id, snapshot_version, snapshot_hash, row_count, source_key, adapter_version, quantity_mode, default_storage_location_id
    FROM inventory_import_batch_job_inputs WHERE input_id = $1 AND account_id = $2`,
    [inputId, accountId],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.account_id !== accountId ||
    row.snapshot_version !== 1 ||
    !/^[a-f0-9]{64}$/.test(row.snapshot_hash) ||
    !Number.isSafeInteger(row.row_count) ||
    row.row_count < 1 ||
    row.adapter_version !== getInventoryImportSourceAdapter(row.source_key).adapterVersion ||
    !["add", "replace"].includes(row.quantity_mode) ||
    (row.source_key === "saved-list" && row.row_count > 10_000)
  )
    invalid();
  if (row.default_storage_location_id !== null) safeText(row.default_storage_location_id);
  return {
    version: 1,
    accountId,
    sourceKey: row.source_key,
    adapterVersion: row.adapter_version,
    quantityMode: row.quantity_mode,
    defaultStorageLocationId: row.default_storage_location_id,
    rowCount: row.row_count,
    hash: row.snapshot_hash,
  };
}

export async function loadInventoryImportSnapshotPage(
  db: PgQueryable,
  inputId: string,
  accountId: string,
  after = 0,
  rowNumber?: number,
) {
  const header = await loadInventoryImportSnapshotHeader(db, inputId, accountId);
  const page = await db.query<{
    row_number: number;
    snapshot_version: number;
    row_hash: string;
    snapshot_row: unknown;
    row_index: number;
    row_proof: unknown;
  }>(
    `SELECT row_number, snapshot_version, row_hash, snapshot_row, row_index, row_proof FROM inventory_import_snapshot_rows
     WHERE input_id = $1 AND row_number > $2 AND ($3::integer IS NULL OR row_number = $3)
     ORDER BY row_number LIMIT $4`,
    [inputId, after, rowNumber ?? null, INVENTORY_IMPORT_SNAPSHOT_PAGE_SIZE],
  );
  let previous = after;
  const rows = page.rows.map((value) => {
    const row = readInventoryImportSnapshotRow(value.snapshot_row);
    if (
      value.snapshot_version !== 1 ||
      value.row_hash !== row.rowFingerprint ||
      value.row_number !== row.rowNumber ||
      row.rowNumber <= previous
    )
      invalid();
    verifyRowProof(header, row, value.row_index, value.row_proof);
    previous = row.rowNumber;
    return row;
  });
  if (rowNumber !== undefined && (rows.length !== 1 || rows[0].rowNumber !== rowNumber)) invalid();
  return { header, rows };
}
