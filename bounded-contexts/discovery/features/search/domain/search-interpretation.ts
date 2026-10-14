import type {
  DiscoverySearchInterpretation,
  DiscoverySearchInterpretationValue,
} from "../../../support/client-support/contracts";
import { foldSearchDiacritics } from "./normalization";
import { tokenizeSearchText, type ProtectedSearchToken } from "./protected-search-tokens";

/** One active Catalog option a search word may name: a Condition, Grading Company, or Grade. */
export type SearchInterpretationOption = Readonly<{
  dimensionId: string;
  optionId: string;
  code: string;
  label: string;
  numericValue: number | null;
}>;

export type SearchInterpretationVocabulary = Readonly<{
  gradingCompanyDimensionId: string;
  gradeDimensionId: string;
  options: readonly SearchInterpretationOption[];
}>;

export type SearchInterpretationSelection = Readonly<{
  language?: string;
  dimensionFilters?: readonly Readonly<{ dimensionId: string; optionId: string }>[];
}>;

/** The interpretation plus the Filter State it newly applies on top of the explicit selection. */
export type SearchTextInterpretation = DiscoverySearchInterpretation &
  Readonly<{
    dimensionFilters: readonly Readonly<{ dimensionId: string; optionId: string }>[];
    language: string | null;
  }>;

/** Supported Search Index languages a shopper may name in words. */
export const SEARCH_INTERPRETATION_LANGUAGES: Readonly<Record<string, Readonly<{ code: string; label: string }>>> = {
  english: { code: "en", label: "English" },
  japanese: { code: "ja", label: "Japanese" },
};

const MAX_PHRASE_TOKENS = 3;
const GRADE_QUALIFIER = "grade";
const BARE_NUMBER = /^\d+(?:\.\d+)?$/u;

type PhraseTarget =
  | Readonly<{ kind: "dimension"; dimensionId: string; optionId: string; label: string }>
  | Readonly<{ kind: "language"; language: string; label: string }>;

type Decision = "apply" | "consume" | "literal";

/**
 * Turns Condition, Grading Company, Grade, and language words into Filter State.
 *
 * Matches are complete, longest, non-overlapping, left-to-right phrases of at most three
 * tokens. A phrase naming options in more than one dimension stays literal, as does a set
 * code or other non-numeric protected identifier. A bare number names a Grade only when it
 * directly follows a consumed Grading Company or the word "grade", and only by exact
 * numeric equality. An explicit selection wins: an equal value is consumed silently and a
 * different value leaves the words literal. Returns null when no word was consumed.
 */
export function interpretSearchText(
  tokens: readonly ProtectedSearchToken[],
  vocabulary: SearchInterpretationVocabulary,
  explicit: SearchInterpretationSelection,
): SearchTextInterpretation | null {
  const phrases = buildPhraseIndex(vocabulary.options);
  const keys = tokens.map((token) => foldSearchDiacritics(token.raw).toLowerCase());
  const identifier = (index: number) => tokens[index].protected && !/\p{N}/u.test(tokens[index].raw);
  const explicitOptions = new Map<string, Set<string>>();
  for (const filter of explicit.dimensionFilters ?? []) {
    explicitOptions.set(
      filter.dimensionId,
      (explicitOptions.get(filter.dimensionId) ?? new Set()).add(filter.optionId),
    );
  }
  const consumed = new Set<number>();
  const applied: DiscoverySearchInterpretationValue[] = [];
  const dimensionFilters: { dimensionId: string; optionId: string }[] = [];
  let language: string | null = null;

  const decideDimension = (dimensionId: string, optionIds: readonly string[]): Decision => {
    const selected = explicitOptions.get(dimensionId);
    if (!selected) return "apply";
    return optionIds.every((optionId) => selected.has(optionId)) ? "consume" : "literal";
  };
  const decideLanguage = (code: string): Decision => {
    if (explicit.language) return explicit.language === code ? "consume" : "literal";
    if (language) return language === code ? "consume" : "literal";
    return "apply";
  };
  const apply = (targets: readonly PhraseTarget[]) => {
    for (const target of targets) {
      if (target.kind === "language") {
        language = target.language;
        applied.push({ param: "language", language: target.language, label: target.label });
      } else if (
        !dimensionFilters.some(
          (filter) => filter.dimensionId === target.dimensionId && filter.optionId === target.optionId,
        )
      ) {
        dimensionFilters.push({ dimensionId: target.dimensionId, optionId: target.optionId });
        applied.push({ param: `dimension.${target.dimensionId}`, optionId: target.optionId, label: target.label });
      }
    }
  };
  const consumeQualifiedGrade = (index: number): boolean => {
    if (index >= tokens.length || !BARE_NUMBER.test(keys[index])) return false;
    const value = Number(keys[index]);
    const grades = vocabulary.options.filter(
      (option) => option.dimensionId === vocabulary.gradeDimensionId && option.numericValue === value,
    );
    if (grades.length === 0) return false;
    const decision = decideDimension(
      vocabulary.gradeDimensionId,
      grades.map((option) => option.optionId),
    );
    if (decision === "literal") return false;
    if (decision === "apply") apply(grades.map(dimensionTarget));
    consumed.add(index);
    return true;
  };

  let index = 0;
  while (index < tokens.length) {
    if (identifier(index)) {
      index++;
      continue;
    }
    const match = longestPhrase(phrases, keys, index, identifier);
    if (match) {
      const groups = new Set(
        match.targets.map((target) => (target.kind === "language" ? "language" : `dimension.${target.dimensionId}`)),
      );
      const end = index + match.length;
      if (groups.size !== 1) {
        index = end;
        continue;
      }
      const [first] = match.targets;
      const decision =
        first.kind === "language"
          ? decideLanguage(first.language)
          : decideDimension(
              first.dimensionId,
              match.targets.flatMap((target) => (target.kind === "dimension" ? [target.optionId] : [])),
            );
      index = end;
      if (decision === "literal") continue;
      if (decision === "apply") apply(match.targets);
      for (let consumedIndex = end - match.length; consumedIndex < end; consumedIndex++) consumed.add(consumedIndex);
      if (first.kind === "dimension" && first.dimensionId === vocabulary.gradingCompanyDimensionId) {
        if (consumeQualifiedGrade(index)) index++;
      }
      continue;
    }
    if (keys[index] === GRADE_QUALIFIER && consumeQualifiedGrade(index + 1)) {
      consumed.add(index);
      index += 2;
      continue;
    }
    index++;
  }

  if (consumed.size === 0) return null;
  return {
    remainingQuery: tokens
      .filter((_token, tokenIndex) => !consumed.has(tokenIndex))
      .map((token) => token.raw)
      .join(" "),
    applied,
    dimensionFilters,
    language,
  };
}

function buildPhraseIndex(options: readonly SearchInterpretationOption[]): ReadonlyMap<string, PhraseTarget[]> {
  const index = new Map<string, PhraseTarget[]>();
  const add = (phrase: string, target: PhraseTarget) => {
    const tokens = tokenizeSearchText(phrase).map((token) => foldSearchDiacritics(token.raw).toLowerCase());
    if (tokens.length === 0 || tokens.length > MAX_PHRASE_TOKENS) return;
    const key = tokens.join(" ");
    const targets = index.get(key) ?? [];
    const duplicate = targets.some(
      (existing) =>
        existing.kind === target.kind &&
        (existing.kind === "language"
          ? target.kind === "language" && existing.language === target.language
          : target.kind === "dimension" &&
            existing.dimensionId === target.dimensionId &&
            existing.optionId === target.optionId),
    );
    if (!duplicate) index.set(key, [...targets, target]);
  };
  for (const option of options) {
    const target = dimensionTarget(option);
    add(option.label, target);
    if (option.code) add(option.code, target);
  }
  for (const [name, language] of Object.entries(SEARCH_INTERPRETATION_LANGUAGES)) {
    add(name, { kind: "language", language: language.code, label: language.label });
  }
  return index;
}

function dimensionTarget(option: SearchInterpretationOption): PhraseTarget {
  return { kind: "dimension", dimensionId: option.dimensionId, optionId: option.optionId, label: option.label };
}

function longestPhrase(
  phrases: ReadonlyMap<string, PhraseTarget[]>,
  keys: readonly string[],
  start: number,
  identifier: (index: number) => boolean,
): Readonly<{ length: number; targets: readonly PhraseTarget[] }> | null {
  for (let length = Math.min(MAX_PHRASE_TOKENS, keys.length - start); length > 0; length--) {
    let blocked = false;
    for (let offset = 0; offset < length; offset++) blocked ||= identifier(start + offset);
    if (blocked) continue;
    const targets = phrases.get(keys.slice(start, start + length).join(" "));
    if (targets) return { length, targets };
  }
  return null;
}
