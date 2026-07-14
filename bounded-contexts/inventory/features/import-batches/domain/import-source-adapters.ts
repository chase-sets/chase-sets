import { parseImportCsv, type ImportCsvRow } from "./csv";
import {
  getInventoryImportSourceProfile,
  inventoryImportSourceProfiles,
  listInventoryImportSourceProfiles,
  type InventoryImportCandidateTargetIntent,
  type InventoryImportExternalReferenceCandidate,
  type InventoryImportSourceKey,
  type InventoryImportSourceProfile,
  type InventoryImportValueMapping,
  type InventoryImportValueTransform,
} from "./import-source-profiles";

export type { InventoryImportCandidateTargetIntent, InventoryImportSourceKey };

export type InventoryImportQuantityMode = "add" | "replace";

export type InventoryImportExternalReference = Readonly<{
  providerKey: string;
  externalKey: string;
  displayName: string | null;
  targetIntent?: InventoryImportCandidateTargetIntent;
}>;

export type InventoryImportSelectedOptionCandidate = Readonly<{
  dimensionKey: string;
  value: string;
}>;

export type NormalizedInventoryImportRow = Readonly<{
  rowNumber: number;
  values: Readonly<Record<string, string>>;
  rawRow: Readonly<Record<string, string>>;
  externalReference: InventoryImportExternalReference | null;
  externalReferences: readonly InventoryImportExternalReference[];
  selectedOptionCandidates: readonly InventoryImportSelectedOptionCandidate[];
  rowFingerprint: string;
}>;

export type InventoryImportSourceAdapter = Readonly<{
  sourceKey: InventoryImportSourceKey;
  adapterVersion: number;
  normalize: (
    input: Readonly<{
      csvText?: string;
      parsedRows?: readonly ImportCsvRow[];
      quantityMode: InventoryImportQuantityMode;
      defaultStorageLocationId?: string | null;
    }>,
  ) => readonly NormalizedInventoryImportRow[];
}>;

function clean(value: string | undefined | null) {
  return (value ?? "").trim();
}

function normalizeHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function valueByHeader(row: ImportCsvRow, candidates: readonly string[] | undefined) {
  if (!candidates || candidates.length === 0) {
    return "";
  }

  const normalizedCandidates = new Set(candidates.map(normalizeHeader));
  const entry = Object.entries(row.values).find(([header]) => normalizedCandidates.has(normalizeHeader(header)));

  return clean(entry?.[1]);
}

function decimalText(value: string) {
  return value.replace(/[$,]/g, "").trim();
}

function integerText(value: string) {
  return value.replace(/[,]/g, "").trim();
}

function transformValue(value: string, transform: InventoryImportValueTransform | undefined): string {
  switch (transform) {
    case "decimal":
      return decimalText(value);
    case "integer":
      return integerText(value);
    case "positive-integer-or-empty":
      return Number(value) > 0 ? value : "";
    default:
      return clean(value);
  }
}

function mappedValue(
  mapping: InventoryImportValueMapping,
  row: ImportCsvRow,
  values: Readonly<Record<string, string>>,
  input: Parameters<InventoryImportSourceAdapter["normalize"]>[0],
) {
  const existing = values[mapping.targetKey] ?? "";
  const copied = mapping.copyFrom ? (values[mapping.copyFrom] ?? "") : "";
  const fromHeaders = valueByHeader(row, mapping.headers);
  const fromDefault =
    mapping.defaultFromInput === "defaultStorageLocationId" ? clean(input.defaultStorageLocationId) : "";
  const fromFallback =
    mapping.fallbackValueKeys?.map((key) => values[key] ?? "").find((value) => value.trim().length > 0) ?? "";
  const raw = existing || copied || fromHeaders || fromDefault || fromFallback;

  return transformValue(raw, mapping.transform);
}

function displayName(values: Readonly<Record<string, string>>, keys: readonly string[]) {
  return (
    keys
      .map((key) => values[key])
      .filter(Boolean)
      .join(" | ") || null
  );
}

function externalReference(
  candidate: InventoryImportExternalReferenceCandidate,
  externalValue: string,
  candidateDisplayName: string | null,
): InventoryImportExternalReference | null {
  const normalizedProvider = candidate.providerKey.trim().toLowerCase();
  const rawValue = externalValue.trim();
  const normalizedKey = rawValue ? `${candidate.externalKeyPrefix}${rawValue}`.trim().toLowerCase() : "";

  return normalizedProvider && normalizedKey
    ? {
        providerKey: normalizedProvider,
        externalKey: normalizedKey,
        displayName: candidateDisplayName?.trim() || null,
        targetIntent: candidate.targetIntent,
      }
    : null;
}

function externalReferences(
  profile: InventoryImportSourceProfile,
  row: ImportCsvRow,
  values: Readonly<Record<string, string>>,
  candidateDisplayName: string | null,
) {
  const references = profile.externalReferenceCandidates
    .map((candidate) => {
      const externalValue = candidate.valueKey
        ? (values[candidate.valueKey] ?? "")
        : valueByHeader(row, candidate.headers);
      return externalReference(candidate, externalValue, candidateDisplayName);
    })
    .filter((reference): reference is InventoryImportExternalReference => Boolean(reference));
  const seen = new Set<string>();

  return references.filter((reference) => {
    const key = `${reference.providerKey}:${reference.externalKey}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function selectedOptionCandidates(
  profile: InventoryImportSourceProfile,
  row: ImportCsvRow,
): readonly InventoryImportSelectedOptionCandidate[] {
  const candidates = [
    ...profile.selectedOptionInference
      .map((rule) => ({
        dimensionKey: rule.dimensionKey,
        value: valueByHeader(row, rule.headers),
      }))
      .filter((candidate) => candidate.value.length > 0),
    ...(profile.nativePassthrough ? nativeSelectedOptionCandidates(row) : []),
  ];
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = `${normalizeHeader(candidate.dimensionKey)}:${normalizeHeader(candidate.value)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function nativeSelectedOptionCandidates(row: ImportCsvRow): readonly InventoryImportSelectedOptionCandidate[] {
  return Object.entries(row.values)
    .filter(([key, value]) => key.trim().toLowerCase().startsWith("option:") && value.trim().length > 0)
    .map(([key, value]) => ({
      dimensionKey: key.trim().slice("option:".length).trim(),
      value: value.trim(),
    }))
    .filter((candidate) => candidate.dimensionKey.length > 0);
}

function fingerprint(
  sourceKey: InventoryImportSourceKey,
  rowNumber: number,
  values: Readonly<Record<string, string>>,
  references: readonly InventoryImportExternalReference[],
  selectedOptions: readonly InventoryImportSelectedOptionCandidate[],
) {
  return [
    sourceKey,
    rowNumber,
    references
      .map((reference) => `${reference.providerKey}:${reference.externalKey}:${reference.targetIntent ?? ""}`)
      .join(","),
    selectedOptions
      .map((candidate) => `${normalizeHeader(candidate.dimensionKey)}:${normalizeHeader(candidate.value)}`)
      .sort()
      .join(","),
    values.catalogItemId ?? "",
    values.storageLocationId ?? "",
    values.totalQuantity ?? "",
    values.listingPriceAmount ?? "",
  ].join("|");
}

function rowsForInput(input: Parameters<InventoryImportSourceAdapter["normalize"]>[0]) {
  return input.parsedRows ?? parseImportCsv(input.csvText ?? "");
}

function createCsvImportAdapter(profile: InventoryImportSourceProfile): InventoryImportSourceAdapter {
  return {
    sourceKey: profile.sourceKey,
    adapterVersion: profile.adapterVersion,
    normalize: (input) =>
      rowsForInput(input).map((row) => {
        const values: Record<string, string> = profile.nativePassthrough ? { ...row.values } : {};

        for (const mapping of profile.values) {
          values[mapping.targetKey] = mappedValue(mapping, row, values, input);
        }

        const name = displayName(values, profile.displayNameValueKeys);
        const rowNoteKeys = profile.rowNoteValueKeys ?? profile.displayNameValueKeys;
        if (rowNoteKeys.length > 0) {
          values.rowNote = displayName(values, rowNoteKeys) ?? "";
        }

        const references = externalReferences(profile, row, values, name);
        const optionCandidates = selectedOptionCandidates(profile, row);

        return {
          rowNumber: row.rowNumber,
          values,
          rawRow: row.values,
          externalReference: references[0] ?? null,
          externalReferences: references,
          selectedOptionCandidates: optionCandidates,
          rowFingerprint: fingerprint(profile.sourceKey, row.rowNumber, values, references, optionCandidates),
        };
      }),
  };
}

const adapters = Object.fromEntries(
  inventoryImportSourceProfiles.map((profile) => [profile.sourceKey, createCsvImportAdapter(profile)]),
) as Record<InventoryImportSourceKey, InventoryImportSourceAdapter>;

export const nativeCsvImportAdapter = adapters["native-csv"];
export const savedListImportAdapter = adapters["saved-list"];
export const tcgplayerCsvImportAdapter = adapters["tcgplayer-csv"];
export const ebayCsvImportAdapter = adapters["ebay-csv"];
export const shopifyCsvImportAdapter = adapters["shopify-csv"];
export const whatnotCsvImportAdapter = adapters["whatnot-csv"];
export const cardTraderCsvImportAdapter = adapters["cardtrader-csv"];

export function getInventoryImportSourceAdapter(sourceKey: string | null | undefined): InventoryImportSourceAdapter {
  const profile = getInventoryImportSourceProfile(sourceKey);
  if (!profile) {
    const normalized = clean(sourceKey) || "native-csv";
    throw new Error(`Unsupported inventory import source '${normalized}'.`);
  }

  return adapters[profile.sourceKey];
}

export function inventoryImportSourceLabel(sourceKey: InventoryImportSourceKey) {
  return getInventoryImportSourceProfile(sourceKey)?.label ?? sourceKey;
}

export function listInventoryImportSources() {
  return listInventoryImportSourceProfiles().map((profile) => ({
    sourceKey: profile.sourceKey,
    label: profile.label,
    kind: profile.kind,
    adapterVersion: profile.adapterVersion,
  }));
}
