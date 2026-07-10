import { createHash } from "node:crypto";

export const DISCOVERY_EMBEDDING_DESCRIPTION_MAX_CHARACTERS = 4_000;

export type DiscoveryEmbeddingDocumentInput = Readonly<{
  title: string;
  titleI18n?: unknown;
  subtitle?: string | null;
  subtitleI18n?: unknown;
  resolvedAliases?: unknown;
  categoryNames?: unknown;
  keyFieldValues?: readonly string[];
  description?: string;
  descriptionI18n?: unknown;
}>;

export type DiscoveryEmbeddingDocument = Readonly<{
  text: string;
  hash: string;
}>;

/**
 * Builds the stable retrieval document embedded for one Discovery Search Index
 * row. Locale variants are retained (including CJK), while unordered facts are
 * sorted so event replay and index rebuild produce the same text and hash.
 */
export function buildDiscoveryEmbeddingDocument(input: DiscoveryEmbeddingDocumentInput): DiscoveryEmbeddingDocument {
  const sections = [
    section("title", localizedValues(input.titleI18n, input.title)),
    section("subtitle", localizedValues(input.subtitleI18n, input.subtitle ?? "")),
    section("aliases", resolvedAliasValues(input.resolvedAliases)),
    section("categories", stringArray(input.categoryNames)),
    section("fields", input.keyFieldValues ?? []),
    section(
      "description",
      truncateValues(
        localizedValues(input.descriptionI18n, input.description ?? ""),
        DISCOVERY_EMBEDDING_DESCRIPTION_MAX_CHARACTERS,
      ),
    ),
  ].filter((value): value is string => value !== null);

  const text = sections.join("\n");
  return {
    text,
    hash: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

export function estimateDiscoveryEmbeddingTokens(text: string): number {
  let cjkCharacters = 0;
  let otherCharacters = 0;
  for (const character of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) {
      cjkCharacters += 1;
    } else {
      otherCharacters += 1;
    }
  }

  return Math.max(1, cjkCharacters + Math.ceil(otherCharacters / 4));
}

function section(label: string, values: readonly string[]): string | null {
  const normalized = normalizedUniqueStrings(values);
  return normalized.length > 0 ? `${label}: ${normalized.join(" | ")}` : null;
}

function localizedValues(value: unknown, fallback: string): string[] {
  const values: string[] = [];
  if (value && typeof value === "object" && !Array.isArray(value) && "values" in value) {
    const localized = (value as { values?: unknown }).values;
    if (localized && typeof localized === "object" && !Array.isArray(localized)) {
      for (const locale of Object.keys(localized).sort()) {
        const text = (localized as Record<string, unknown>)[locale];
        if (typeof text === "string") {
          values.push(text);
        }
      }
    }
  }
  values.push(fallback);
  return normalizedUniqueStrings(values);
}

function resolvedAliasValues(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .flatMap((languageCode) => {
      const aliases = (value as Record<string, unknown>)[languageCode];
      if (!Array.isArray(aliases)) {
        return [];
      }
      return aliases.flatMap((alias) => {
        if (!alias || typeof alias !== "object") {
          return [];
        }
        const aliasText = (alias as { aliasText?: unknown }).aliasText;
        return typeof aliasText === "string" ? [aliasText] : [];
      });
    });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.normalize("NFKC").trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

function truncateValues(values: readonly string[], maximumCharacters: number): string[] {
  let remaining = maximumCharacters;
  const truncated: string[] = [];
  for (const value of values) {
    if (remaining <= 0) {
      break;
    }
    const next = [...value].slice(0, remaining).join("");
    if (next) {
      truncated.push(next);
      remaining -= [...next].length;
    }
  }
  return truncated;
}
