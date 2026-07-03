import { CatalogDomainError, type CatalogValue } from "../../../support/runtime-support/common";

export const catalogScopeProductDomains = ["pokemon", "magic", "yugioh", "one-piece", "lorcana"] as const;

export type CatalogScopeProductDomain = (typeof catalogScopeProductDomains)[number];

export const catalogScopeRecordKinds = ["product-line", "series", "expansion", "set"] as const;

export type CatalogScopeRecordKind = (typeof catalogScopeRecordKinds)[number];

export type CatalogScopeLeafRecordKind = "expansion" | "set";

export type CatalogScopeRecordAttributes = Readonly<{
  releaseDate: string | null;
  officialSetCode: string | null;
  languageEditions: readonly string[];
}>;

export type CatalogScopeProductDomainContract = Readonly<{
  productDomain: CatalogScopeProductDomain;
  productLineReferenceRecordKey: string;
  seriesReferenceTypeKey: "series";
  leafReferenceTypeKey: CatalogScopeLeafRecordKind;
  requiredLeafAttributeKeys: readonly ["release-date", "official-set-code", "language-editions"];
}>;

export type CatalogScopeRecordContractFixture = Readonly<{
  productDomain: CatalogScopeProductDomain;
  scopeKind: CatalogScopeLeafRecordKind;
  referenceTypeKey: CatalogScopeLeafRecordKind;
  referenceRecordKey: string;
  name: string;
  parentReferenceRecordKey: string;
  attributes: Readonly<Record<string, CatalogValue>>;
}>;

export const catalogScopeProductDomainContracts: Readonly<
  Record<CatalogScopeProductDomain, CatalogScopeProductDomainContract>
> = {
  pokemon: {
    productDomain: "pokemon",
    productLineReferenceRecordKey: "pokemon-trading-card-game",
    seriesReferenceTypeKey: "series",
    leafReferenceTypeKey: "expansion",
    requiredLeafAttributeKeys: ["release-date", "official-set-code", "language-editions"],
  },
  magic: {
    productDomain: "magic",
    productLineReferenceRecordKey: "magic-the-gathering",
    seriesReferenceTypeKey: "series",
    leafReferenceTypeKey: "set",
    requiredLeafAttributeKeys: ["release-date", "official-set-code", "language-editions"],
  },
  yugioh: {
    productDomain: "yugioh",
    productLineReferenceRecordKey: "yu-gi-oh-official-card-game",
    seriesReferenceTypeKey: "series",
    leafReferenceTypeKey: "set",
    requiredLeafAttributeKeys: ["release-date", "official-set-code", "language-editions"],
  },
  "one-piece": {
    productDomain: "one-piece",
    productLineReferenceRecordKey: "one-piece-card-game",
    seriesReferenceTypeKey: "series",
    leafReferenceTypeKey: "set",
    requiredLeafAttributeKeys: ["release-date", "official-set-code", "language-editions"],
  },
  lorcana: {
    productDomain: "lorcana",
    productLineReferenceRecordKey: "disney-lorcana",
    seriesReferenceTypeKey: "series",
    leafReferenceTypeKey: "set",
    requiredLeafAttributeKeys: ["release-date", "official-set-code", "language-editions"],
  },
};

const productDomainByProductLineReferenceRecordKey = new Map<string, CatalogScopeProductDomain>(
  Object.values(catalogScopeProductDomainContracts).map((contract) => [
    contract.productLineReferenceRecordKey,
    contract.productDomain,
  ]),
);

export const representativeCatalogScopeRecordFixtures: readonly CatalogScopeRecordContractFixture[] = [
  {
    productDomain: "pokemon",
    scopeKind: "expansion",
    referenceTypeKey: "expansion",
    referenceRecordKey: "paldean-fates",
    name: "Paldean Fates",
    parentReferenceRecordKey: "scarlet-violet",
    attributes: {
      "release-date": "2024-01-26",
      "official-set-code": "PAF",
      "language-editions": ["en", "ja"],
    },
  },
  {
    productDomain: "magic",
    scopeKind: "set",
    referenceTypeKey: "set",
    referenceRecordKey: "time-spiral",
    name: "Time Spiral",
    parentReferenceRecordKey: "magic-the-gathering",
    attributes: {
      "release-date": "2006-10-06",
      "official-set-code": "TSP",
      "language-editions": ["en", "fr", "de", "it", "ja", "pt", "ru", "es"],
    },
  },
  {
    productDomain: "yugioh",
    scopeKind: "set",
    referenceTypeKey: "set",
    referenceRecordKey: "legend-of-blue-eyes-white-dragon",
    name: "Legend of Blue Eyes White Dragon",
    parentReferenceRecordKey: "yu-gi-oh-official-card-game",
    attributes: {
      "release-date": "2002-03-08",
      "official-set-code": "LOB",
      "language-editions": ["en", "ja"],
    },
  },
  {
    productDomain: "one-piece",
    scopeKind: "set",
    referenceTypeKey: "set",
    referenceRecordKey: "romance-dawn",
    name: "Romance Dawn",
    parentReferenceRecordKey: "one-piece-card-game",
    attributes: {
      "release-date": "2022-12-02",
      "official-set-code": "OP-01",
      "language-editions": ["en", "ja"],
    },
  },
  {
    productDomain: "lorcana",
    scopeKind: "set",
    referenceTypeKey: "set",
    referenceRecordKey: "the-first-chapter",
    name: "The First Chapter",
    parentReferenceRecordKey: "disney-lorcana",
    attributes: {
      "release-date": "2023-08-18",
      "official-set-code": "1",
      "language-editions": ["en", "fr", "de"],
    },
  },
];

export function catalogScopeProductDomainForProductLineKey(
  referenceRecordKey: string,
): CatalogScopeProductDomain | null {
  return productDomainByProductLineReferenceRecordKey.get(normalizeScopeKey(referenceRecordKey)) ?? null;
}

export function normalizeCatalogScopeProductDomain(value: string | null | undefined): CatalogScopeProductDomain | null {
  const normalized = normalizeOptionalScopeKey(value);
  const canonical = normalized === "mtg" ? "magic" : normalized;
  return catalogScopeProductDomains.includes(canonical as CatalogScopeProductDomain)
    ? (canonical as CatalogScopeProductDomain)
    : null;
}

export function catalogScopeRecordKindForReferenceTypeKey(referenceTypeKey: string): CatalogScopeRecordKind | null {
  const normalized = normalizeScopeKey(referenceTypeKey);
  return catalogScopeRecordKinds.includes(normalized as CatalogScopeRecordKind)
    ? (normalized as CatalogScopeRecordKind)
    : null;
}

export function isReferenceTypeKeyAllowedForCatalogScopeProductDomain(
  productDomain: CatalogScopeProductDomain,
  referenceTypeKey: string,
): boolean {
  const scopeKind = catalogScopeRecordKindForReferenceTypeKey(referenceTypeKey);
  if (scopeKind === "product-line" || scopeKind === "series") {
    return true;
  }
  return scopeKind === catalogScopeProductDomainContracts[productDomain].leafReferenceTypeKey;
}

export function extractCatalogScopeRecordAttributes(
  attributes: Readonly<Record<string, CatalogValue>>,
): CatalogScopeRecordAttributes {
  return {
    releaseDate: optionalStringAttribute(attributes["release-date"]),
    officialSetCode:
      optionalStringAttribute(attributes["official-set-code"]) ??
      optionalStringAttribute(attributes["set-code"]) ??
      optionalStringAttribute(attributes.abbreviation),
    languageEditions: stringArrayAttribute(attributes["language-editions"]),
  };
}

export function assertCatalogScopeRecordFixtureMatchesContract(fixture: CatalogScopeRecordContractFixture): void {
  const contract = catalogScopeProductDomainContracts[fixture.productDomain];
  if (fixture.referenceTypeKey !== contract.leafReferenceTypeKey) {
    throw new CatalogDomainError(
      `${fixture.productDomain} scope records use '${contract.leafReferenceTypeKey}', not '${fixture.referenceTypeKey}'.`,
    );
  }
  const attributes = extractCatalogScopeRecordAttributes(fixture.attributes);
  if (!attributes.releaseDate || Number.isNaN(Date.parse(attributes.releaseDate))) {
    throw new CatalogDomainError(`${fixture.referenceRecordKey} requires a valid release-date attribute.`);
  }
  if (!attributes.officialSetCode) {
    throw new CatalogDomainError(`${fixture.referenceRecordKey} requires an official-set-code attribute.`);
  }
  if (attributes.languageEditions.length === 0) {
    throw new CatalogDomainError(`${fixture.referenceRecordKey} requires at least one language edition.`);
  }
}

function normalizeScopeKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOptionalScopeKey(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function optionalStringAttribute(value: CatalogValue | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArrayAttribute(value: CatalogValue | undefined): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}
