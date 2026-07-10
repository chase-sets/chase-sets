import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderIntegrationProfile,
  CatalogProviderOptionQuery,
  CatalogProviderOptionQueryDescriptionMapping,
  CatalogProviderOptionQueryOperation,
  CatalogProviderOptionQueryOutputMapping,
} from "./provider-integration-profiles";
import { parseProviderOptionAliasesFromJson, type ProviderOptionAliasRecord } from "./provider-option-aliases";

export type CatalogProviderIntegrationOption = Readonly<{
  providerKey: string;
  queryKind: string;
  value: string;
  label: string;
  description: string | null;
  parentValue: string | null;
  imageUrl: string | null;
  /** Typed equivalence aliases sharing the Catalog Alias vocabulary. */
  aliases: readonly ProviderOptionAliasRecord[];
  metadata: JsonObject;
}>;

export type CatalogProviderOptionQueryTransports = Readonly<{
  listTcgdexLanguages?: () => Promise<readonly JsonValue[]>;
  listTcgdexSeries?: (input: { languageCode: string }) => Promise<readonly JsonValue[]>;
  listTcgdexExpansions?: (input: { languageCode: string; seriesId: string | null }) => Promise<readonly JsonValue[]>;
  listTcgplayerProductLines?: () => Promise<readonly JsonValue[]>;
  listTcgplayerSetNames?: (input: { productLineId: number }) => Promise<readonly JsonValue[]>;
  listTcgplayerProducts?: (input: { setName: string }) => Promise<readonly JsonValue[]>;
  listTcgplayerSkus?: (input: { productId: number }) => Promise<readonly JsonValue[]>;
  listMtgjsonSets?: () => Promise<readonly JsonValue[]>;
  listMtgjsonCards?: (input: { setCode: string | null }) => Promise<readonly JsonValue[]>;
  listLorcanajsonSets?: () => Promise<readonly JsonValue[]>;
  listLorcanajsonCards?: (input: { setCode: string | null }) => Promise<readonly JsonValue[]>;
  listLorcastSets?: () => Promise<readonly JsonValue[]>;
  listLorcastCards?: (input: { setCode: string | null }) => Promise<readonly JsonValue[]>;
  listScryfallSets?: () => Promise<readonly JsonValue[]>;
  listScryfallCards?: (input: { setCode: string | null }) => Promise<readonly JsonValue[]>;
  listScrydexSets?: () => Promise<readonly JsonValue[]>;
  listScrydexOnePieceSets?: () => Promise<readonly JsonValue[]>;
  listScrydexOnePieceCards?: (input: { setId: string | null }) => Promise<readonly JsonValue[]>;
  listScrydexOnePieceSealedProducts?: (input: { setId: string | null }) => Promise<readonly JsonValue[]>;
  listScrydexLorcanaSets?: () => Promise<readonly JsonValue[]>;
  listScrydexLorcanaCards?: (input: { setId: string | null }) => Promise<readonly JsonValue[]>;
  listScrydexLorcanaSealedProducts?: (input: { setId: string | null }) => Promise<readonly JsonValue[]>;
  listYgoprodeckSets?: () => Promise<readonly JsonValue[]>;
  listYgoprodeckCards?: (input: { setCode: string | null }) => Promise<readonly JsonValue[]>;
  listYgojsonSets?: () => Promise<readonly JsonValue[]>;
  listYgojsonSealedProducts?: (input: { setCode: string | null }) => Promise<readonly JsonValue[]>;
  listYamlYugiSets?: () => Promise<readonly JsonValue[]>;
  listYamlYugiCards?: (input: { setCode: string | null }) => Promise<readonly JsonValue[]>;
}>;

export type CatalogProviderOptionQueryInvalidRequestCode =
  | "catalog_provider_option_query_parent_required"
  | "catalog_provider_option_query_invalid_parent_value";

export class CatalogProviderOptionQueryInvalidRequestError extends Error {
  readonly code: CatalogProviderOptionQueryInvalidRequestCode;

  constructor(code: CatalogProviderOptionQueryInvalidRequestCode, message: string) {
    super(message);
    this.name = "CatalogProviderOptionQueryInvalidRequestError";
    this.code = code;
  }
}

export async function listCatalogProviderIntegrationOptionsFromProfiles(input: {
  profiles: readonly CatalogProviderIntegrationProfile[];
  providerKey: string;
  queryKind: string;
  languageCode?: string | null;
  parentValue?: string | null;
  transports: CatalogProviderOptionQueryTransports;
  defaultProviderKey: string;
}): Promise<readonly CatalogProviderIntegrationOption[]> {
  const providerKey = normalizeIntegrationKey(input.providerKey || input.defaultProviderKey);
  const queryKind = normalizeIntegrationKey(input.queryKind);
  const languageCode = normalizeIntegrationKey(input.languageCode || "en");
  const parentValue = input.parentValue?.trim() || null;

  const providerListQuery = catalogProviderListOptionQuery();
  if (matchesOptionQuery(providerListQuery, queryKind)) {
    return mapOptionRecords({
      providerKey: "catalog",
      query: providerListQuery,
      records: input.profiles,
      languageCode,
      parentValue: null,
    });
  }

  const profile = input.profiles.find((candidate) => normalizeIntegrationKey(candidate.providerKey) === providerKey);
  if (!profile) {
    throw new Error(`Unsupported Catalog integration provider: ${providerKey}.`);
  }
  if (!profile.capabilities.includes("provider-option-query")) {
    throw new Error(`Catalog integration provider '${profile.providerKey}' does not support runtime option queries.`);
  }

  const query = profile.optionQueries.find((candidate) => matchesOptionQuery(candidate, queryKind));
  if (!query) {
    throw unsupportedQueryError(profile, queryKind);
  }

  if (query.parentValue?.required && !parentValue) {
    throw new CatalogProviderOptionQueryInvalidRequestError(
      "catalog_provider_option_query_parent_required",
      query.parentValue.diagnosticText,
    );
  }

  const records = await executeOptionQueryOperation({
    operation: query.operation,
    languageCode,
    parentValue,
    transports: input.transports,
  });

  return mapOptionRecords({
    providerKey: profile.providerKey,
    query,
    records,
    languageCode,
    parentValue,
  });
}

async function executeOptionQueryOperation(input: {
  operation: CatalogProviderOptionQueryOperation;
  languageCode: string;
  parentValue: string | null;
  transports: CatalogProviderOptionQueryTransports;
}): Promise<readonly JsonValue[]> {
  if (input.operation === "tcgdex-list-languages" && input.transports.listTcgdexLanguages) {
    return input.transports.listTcgdexLanguages();
  }
  if (input.operation === "tcgdex-list-series" && input.transports.listTcgdexSeries) {
    return input.transports.listTcgdexSeries({ languageCode: input.languageCode });
  }
  if (input.operation === "tcgdex-list-expansions" && input.transports.listTcgdexExpansions) {
    return input.transports.listTcgdexExpansions({ languageCode: input.languageCode, seriesId: input.parentValue });
  }
  if (input.operation === "tcgplayer-list-product-lines" && input.transports.listTcgplayerProductLines) {
    return input.transports.listTcgplayerProductLines();
  }
  if (input.operation === "tcgplayer-list-set-names" && input.transports.listTcgplayerSetNames) {
    const productLineId = parsePositiveInteger(input.parentValue);
    if (productLineId === null) {
      throw new CatalogProviderOptionQueryInvalidRequestError(
        "catalog_provider_option_query_invalid_parent_value",
        "TCGplayer set-name option queries require a productLineId/categoryId parent value.",
      );
    }
    return input.transports.listTcgplayerSetNames({ productLineId });
  }
  if (input.operation === "tcgplayer-list-products" && input.transports.listTcgplayerProducts) {
    if (!input.parentValue) {
      throw new CatalogProviderOptionQueryInvalidRequestError(
        "catalog_provider_option_query_parent_required",
        "TCGplayer product option queries require a set-name parent value.",
      );
    }
    return input.transports.listTcgplayerProducts({ setName: input.parentValue });
  }
  if (input.operation === "tcgplayer-list-skus" && input.transports.listTcgplayerSkus) {
    const productId = parsePositiveInteger(input.parentValue);
    if (productId === null) {
      throw new CatalogProviderOptionQueryInvalidRequestError(
        "catalog_provider_option_query_invalid_parent_value",
        "TCGplayer SKU option queries require a Product parent value.",
      );
    }
    return input.transports.listTcgplayerSkus({ productId });
  }
  if (input.operation === "mtgjson-list-sets" && input.transports.listMtgjsonSets) {
    return input.transports.listMtgjsonSets();
  }
  if (input.operation === "mtgjson-list-cards" && input.transports.listMtgjsonCards) {
    return input.transports.listMtgjsonCards({ setCode: input.parentValue });
  }
  if (input.operation === "lorcanajson-list-sets" && input.transports.listLorcanajsonSets) {
    return input.transports.listLorcanajsonSets();
  }
  if (input.operation === "lorcanajson-list-cards" && input.transports.listLorcanajsonCards) {
    return input.transports.listLorcanajsonCards({ setCode: input.parentValue });
  }
  if (input.operation === "lorcast-list-sets" && input.transports.listLorcastSets) {
    return input.transports.listLorcastSets();
  }
  if (input.operation === "lorcast-list-cards" && input.transports.listLorcastCards) {
    return input.transports.listLorcastCards({ setCode: input.parentValue });
  }
  if (input.operation === "scryfall-list-sets" && input.transports.listScryfallSets) {
    return input.transports.listScryfallSets();
  }
  if (input.operation === "scryfall-list-cards" && input.transports.listScryfallCards) {
    return input.transports.listScryfallCards({ setCode: input.parentValue });
  }
  if (input.operation === "scrydex-list-sets" && input.transports.listScrydexSets) {
    return input.transports.listScrydexSets();
  }
  if (input.operation === "scrydex-one-piece-list-sets" && input.transports.listScrydexOnePieceSets) {
    return input.transports.listScrydexOnePieceSets();
  }
  if (input.operation === "scrydex-one-piece-list-cards" && input.transports.listScrydexOnePieceCards) {
    return input.transports.listScrydexOnePieceCards({ setId: input.parentValue });
  }
  if (
    input.operation === "scrydex-one-piece-list-sealed-products" &&
    input.transports.listScrydexOnePieceSealedProducts
  ) {
    return input.transports.listScrydexOnePieceSealedProducts({ setId: input.parentValue });
  }
  if (input.operation === "scrydex-lorcana-list-sets" && input.transports.listScrydexLorcanaSets) {
    return input.transports.listScrydexLorcanaSets();
  }
  if (input.operation === "scrydex-lorcana-list-cards" && input.transports.listScrydexLorcanaCards) {
    return input.transports.listScrydexLorcanaCards({ setId: input.parentValue });
  }
  if (input.operation === "scrydex-lorcana-list-sealed-products" && input.transports.listScrydexLorcanaSealedProducts) {
    return input.transports.listScrydexLorcanaSealedProducts({ setId: input.parentValue });
  }
  if (input.operation === "ygoprodeck-list-sets" && input.transports.listYgoprodeckSets) {
    return input.transports.listYgoprodeckSets();
  }
  if (input.operation === "ygoprodeck-list-cards" && input.transports.listYgoprodeckCards) {
    return input.transports.listYgoprodeckCards({ setCode: input.parentValue });
  }
  if (input.operation === "ygojson-list-sets" && input.transports.listYgojsonSets) {
    return input.transports.listYgojsonSets();
  }
  if (input.operation === "ygojson-list-sealed-products" && input.transports.listYgojsonSealedProducts) {
    return input.transports.listYgojsonSealedProducts({ setCode: input.parentValue });
  }
  if (input.operation === "yaml-yugi-list-sets" && input.transports.listYamlYugiSets) {
    return input.transports.listYamlYugiSets();
  }
  if (input.operation === "yaml-yugi-list-cards" && input.transports.listYamlYugiCards) {
    return input.transports.listYamlYugiCards({ setCode: input.parentValue });
  }

  throw new Error(`Catalog integration option query operation '${input.operation}' is not available in this runtime.`);
}

function mapOptionRecords(input: {
  providerKey: string;
  query: CatalogProviderOptionQuery;
  records: readonly JsonValue[];
  languageCode: string;
  parentValue: string | null;
}): readonly CatalogProviderIntegrationOption[] {
  return input.records.flatMap((record) => {
    const value = stringForMapping(record, input.query.output.valuePath, input);
    const label = stringForMapping(record, input.query.output.labelPath, input);
    if (!value || !label) {
      return [];
    }

    return [
      {
        providerKey: input.providerKey === "catalog" ? value : input.providerKey,
        queryKind: input.query.queryKind,
        value,
        label,
        description: descriptionForMapping(record, input.query.output.description, input),
        parentValue: stringForOptionalMapping(record, input.query.output.parentValuePath, input),
        imageUrl: imageUrlForMapping(record, input.query.output, input),
        aliases: aliasesForMapping(record, input.query.output.aliasesPath),
        metadata: metadataForMapping(record, input.query.output.metadataPaths, input),
      },
    ];
  });
}

function descriptionForMapping(
  record: JsonValue,
  mapping: CatalogProviderOptionQueryDescriptionMapping | undefined,
  context: { languageCode: string; parentValue: string | null },
): string | null {
  if (!mapping) {
    return null;
  }
  if (mapping.kind === "path") {
    return stringAtPath(record, mapping.path);
  }
  if (mapping.kind === "tcgplayer-set-name") {
    return (
      [stringAtPath(record, "abbreviation"), stringAtPath(record, "releaseDate")].filter(Boolean).join(" - ") || null
    );
  }

  const officialCardCount = numberAtPath(record, "officialCardCount");
  const cardCount = numberAtPath(record, "cardCount");
  if (officialCardCount === null && cardCount === null) {
    return stringAtPath(record, "seriesName");
  }

  const count = officialCardCount !== null ? `${officialCardCount} official cards` : `${cardCount} cards`;
  const seriesName = stringAtPath(record, "seriesName");
  return seriesName ? `${seriesName} - ${count}` : count;
}

function imageUrlForMapping(
  record: JsonValue,
  mapping: CatalogProviderOptionQueryOutputMapping,
  context: { languageCode: string; parentValue: string | null },
): string | null {
  if (mapping.imageUrlCoalescePaths) {
    for (const path of mapping.imageUrlCoalescePaths) {
      const value = stringForOptionalMapping(record, path, context);
      if (value) {
        return value;
      }
    }
  }

  return stringForOptionalMapping(record, mapping.imageUrlPath, context);
}

function aliasesForMapping(record: JsonValue, aliasesPath: string | undefined): readonly ProviderOptionAliasRecord[] {
  if (!aliasesPath) {
    return [];
  }
  return parseProviderOptionAliasesFromJson(valueAtPath(record, aliasesPath));
}

function metadataForMapping(
  record: JsonValue,
  metadataPaths: Readonly<Record<string, string>>,
  context: { languageCode: string; parentValue: string | null },
): JsonObject {
  return Object.fromEntries(
    Object.entries(metadataPaths).map(([key, path]) => [key, valueForMapping(record, path, context) ?? null]),
  ) as JsonObject;
}

function stringForMapping(
  record: JsonValue,
  path: string,
  context: { languageCode: string; parentValue: string | null },
): string | null {
  const value = valueForMapping(record, path, context);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized ? normalized : null;
  }
  return null;
}

function stringForOptionalMapping(
  record: JsonValue,
  path: string | undefined,
  context: { languageCode: string; parentValue: string | null },
): string | null {
  return path ? stringForMapping(record, path, context) : null;
}

function valueForMapping(
  record: JsonValue,
  path: string,
  context: { languageCode: string; parentValue: string | null },
): JsonValue | undefined {
  if (path === "$languageCode") {
    return context.languageCode;
  }
  if (path === "$parentValue") {
    return context.parentValue;
  }
  if (path === "$parentValueNumber") {
    return parsePositiveInteger(context.parentValue);
  }
  return valueAtPath(record, path);
}

function unsupportedQueryError(profile: CatalogProviderIntegrationProfile, queryKind: string): Error {
  return new Error(
    `Unsupported Catalog integration query '${queryKind}' for provider '${profile.providerKey}'. Supported queries: ${profile.optionQueries
      .map((query) => query.queryKind)
      .join(", ")}.`,
  );
}

function matchesOptionQuery(query: CatalogProviderOptionQuery, queryKind: string): boolean {
  return query.queryKind === queryKind || (query.queryKeySynonyms ?? []).includes(queryKind);
}

function catalogProviderListOptionQuery(): CatalogProviderOptionQuery {
  return {
    queryKind: "providers",
    queryKeySynonyms: ["provider"],
    displayName: "Provider",
    scope: "product/card",
    parentScope: null,
    operation: "catalog-provider-profiles",
    output: {
      valuePath: "providerKey",
      labelPath: "displayName",
      description: { kind: "path", path: "capabilities" },
      metadataPaths: {
        providerKey: "providerKey",
        supportedScopes: "supportedScopes",
        status: "status",
        connectorKind: "connector.kind",
      },
    },
  };
}

function parsePositiveInteger(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeIntegrationKey(value: string): string {
  return value.trim().toLowerCase();
}

function numberAtPath(value: JsonValue, path: string): number | null {
  const found = valueAtPath(value, path);
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

function stringAtPath(value: JsonValue, path: string): string | null {
  const found = valueAtPath(value, path);
  if (typeof found === "string" || typeof found === "number" || typeof found === "boolean") {
    const normalized = String(found).trim();
    return normalized ? normalized : null;
  }
  if (Array.isArray(found)) {
    return found.map(String).join(", ");
  }
  return null;
}

function valueAtPath(value: JsonValue, path: string): JsonValue | undefined {
  const segments = path.split(".").filter(Boolean);
  let current: JsonValue | undefined = value;

  for (const segment of segments) {
    if (!isJsonRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
