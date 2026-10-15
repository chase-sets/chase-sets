import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { classifyProtectedSearchTokens } from "./protected-search-tokens";
import {
  interpretSearchText,
  type SearchInterpretationOption,
  type SearchInterpretationSelection,
  type SearchInterpretationVocabulary,
} from "./search-interpretation";

const { condition, gradingCompany, grade } = catalogSeedIds.dimensions;
const seedOption = (
  dimension: { dimensionId: string; optionIds: Record<string, string> },
  key: string,
  code: string,
  label: string,
  numericValue: number | null = null,
): SearchInterpretationOption => ({
  dimensionId: dimension.dimensionId,
  optionId: dimension.optionIds[key],
  code,
  label,
  numericValue,
});

// Copied from bounded-contexts/catalog/features/dimensions/api/seed.ts; the first test pins it.
const SEED_OPTIONS: readonly SearchInterpretationOption[] = [
  seedOption(condition, "pristine", "pristine", "Pristine", 7),
  seedOption(condition, "mint", "mint", "Mint", 6),
  seedOption(condition, "nearMint", "near-mint", "Near Mint", 5),
  seedOption(condition, "excellent", "excellent", "Excellent", 4),
  seedOption(condition, "good", "good", "Good", 3),
  seedOption(condition, "poor", "poor", "Poor", 2),
  seedOption(condition, "damaged", "damaged", "Damaged", 1),
  seedOption(gradingCompany, "psa", "psa", "PSA"),
  seedOption(gradingCompany, "bgs", "bgs", "BGS"),
  seedOption(gradingCompany, "cgc", "cgc", "CGC"),
  seedOption(gradingCompany, "sgc", "sgc", "SGC"),
  seedOption(gradingCompany, "ace", "ace", "ACE"),
  seedOption(gradingCompany, "tag", "tag", "TAG"),
  seedOption(grade, "pristine10", "pristine-10", "Pristine 10", 10.5),
  seedOption(grade, "gemMint10", "gem-mint-10", "Gem Mint 10", 10),
  seedOption(grade, "mint95", "mint-9.5", "Mint 9.5", 9.5),
  seedOption(grade, "mint9", "mint-9", "Mint 9", 9),
  seedOption(grade, "nmMt85", "nm-mt-8.5", "NM-MT 8.5", 8.5),
  seedOption(grade, "nmMt8", "nm-mt-8", "NM-MT 8", 8),
  seedOption(grade, "nm7", "nm-7", "NM 7", 7),
  seedOption(grade, "ex6", "ex-6", "EX 6", 6),
  seedOption(grade, "ex5", "ex-5", "EX 5", 5),
  seedOption(grade, "vg4", "vg-4", "VG 4", 4),
  seedOption(grade, "good3", "good-3", "Good 3", 3),
  seedOption(grade, "good2", "good-2", "Good 2", 2),
  seedOption(grade, "poor1", "poor-1", "Poor 1", 1),
];
const vocabulary = (options: readonly SearchInterpretationOption[] = SEED_OPTIONS): SearchInterpretationVocabulary => ({
  gradingCompanyDimensionId: gradingCompany.dimensionId,
  gradeDimensionId: grade.dimensionId,
  options,
});
const psa = { dimensionId: gradingCompany.dimensionId, optionId: gradingCompany.optionIds.psa };
const bgs = { dimensionId: gradingCompany.dimensionId, optionId: gradingCompany.optionIds.bgs };
const gemMint10 = { dimensionId: grade.dimensionId, optionId: grade.optionIds.gemMint10 };

async function interpret(
  search: string,
  explicit: SearchInterpretationSelection = {},
  options: readonly SearchInterpretationOption[] = SEED_OPTIONS,
  setCodes: readonly string[] = [],
) {
  const tokens = await classifyProtectedSearchTokens(search, async () => new Set(setCodes));
  return interpretSearchText(tokens, vocabulary(options), explicit);
}

function summary(result: Awaited<ReturnType<typeof interpret>>) {
  return (
    result && { q: result.remainingQuery, applied: result.applied.map((value) => `${value.param}=${value.label}`) }
  );
}

describe("search interpretation", () => {
  it("uses the Catalog seed values unchanged", () => {
    const seed = readFileSync(
      new URL("../../../../catalog/features/dimensions/api/seed.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    for (const option of SEED_OPTIONS) {
      const numeric = option.numericValue === null ? "" : String.raw`\s*numericValue: ${option.numericValue},`;
      const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(seed).toMatch(
        new RegExp(String.raw`code: "${escape(option.code)}",\s*label: "${escape(option.label)}",${numeric}`),
      );
    }
    expect(SEED_OPTIONS.map((option) => option.optionId).every(Boolean)).toBe(true);
  });

  it.each([
    [
      "charzard psa 10",
      {
        q: "charzard",
        applied: [`dimension.${gradingCompany.dimensionId}=PSA`, `dimension.${grade.dimensionId}=Gem Mint 10`],
      },
    ],
    [
      "zard BGS 10",
      {
        q: "zard",
        applied: [`dimension.${gradingCompany.dimensionId}=BGS`, `dimension.${grade.dimensionId}=Gem Mint 10`],
      },
    ],
    ["charizard grade 9.5", { q: "charizard", applied: [`dimension.${grade.dimensionId}=Mint 9.5`] }],
    ["charizard pristine 10", { q: "charizard", applied: [`dimension.${grade.dimensionId}=Pristine 10`] }],
    ["charizard gem mint 10", { q: "charizard", applied: [`dimension.${grade.dimensionId}=Gem Mint 10`] }],
    ["charizard mint 9", { q: "charizard", applied: [`dimension.${grade.dimensionId}=Mint 9`] }],
    ["charizard near mint", { q: "charizard", applied: [`dimension.${condition.dimensionId}=Near Mint`] }],
    ["charizard Near-Mint", { q: "charizard", applied: [`dimension.${condition.dimensionId}=Near Mint`] }],
    ["charizard mint", { q: "charizard", applied: [`dimension.${condition.dimensionId}=Mint`] }],
    ["charizard nm-mt 8.5", { q: "charizard", applied: [`dimension.${grade.dimensionId}=NM-MT 8.5`] }],
    ["charizard good 3", { q: "charizard", applied: [`dimension.${grade.dimensionId}=Good 3`] }],
    ["charizard japanese", { q: "charizard", applied: ["language=Japanese"] }],
    ["English charizard", { q: "charizard", applied: ["language=English"] }],
    [
      "charizard cgc sgc ace tag",
      {
        q: "charizard",
        applied: ["CGC", "SGC", "ACE", "TAG"].map((label) => `dimension.${gradingCompany.dimensionId}=${label}`),
      },
    ],
  ])("seed-faithful words become Filter State: %s", async (search, expected) => {
    expect(summary(await interpret(search))).toEqual(expected);
  });

  it("names only an exactly equal numeric Grade beside a company, never Pristine 10 for a bare 10", async () => {
    const result = await interpret("charizard psa 10");
    expect(result?.dimensionFilters).toEqual([psa, gemMint10]);
    expect(result?.applied).toEqual([
      { param: `dimension.${gradingCompany.dimensionId}`, optionId: psa.optionId, label: "PSA" },
      { param: `dimension.${grade.dimensionId}`, optionId: gemMint10.optionId, label: "Gem Mint 10" },
    ]);
    expect(summary(await interpret("charizard psa 10.5"))?.applied).toEqual([
      `dimension.${gradingCompany.dimensionId}=PSA`,
      `dimension.${grade.dimensionId}=Pristine 10`,
    ]);
    expect(summary(await interpret("charizard psa 11"))).toEqual({
      q: "charizard 11",
      applied: [`dimension.${gradingCompany.dimensionId}=PSA`],
    });
  });

  it("ORs every equal-valued Grade option and ANDs it with the company", async () => {
    const equal = seedOption(grade, "gemMint10", "test-ten", "Test Ten", 10);
    const result = await interpret("charizard psa 10", {}, [...SEED_OPTIONS, { ...equal, optionId: "chc_test_ten" }]);
    expect(result?.dimensionFilters).toEqual([
      psa,
      gemMint10,
      { dimensionId: grade.dimensionId, optionId: "chc_test_ten" },
    ]);
  });

  it.each([
    "charizard 10",
    "charizard 4/102",
    "pikachu 25 holo",
    "charizard foil",
    "base 4 holo",
    "charizard grade",
    "charizard grade 11",
  ])("leaves collector, set, unqualified numbers, holo, Finish and title words literal: %s", async (search) => {
    expect(await interpret(search, {}, SEED_OPTIONS, ["base"])).toBeNull();
  });

  it("never lets a numeric option code or label consume a number outside the exact numeric path", async () => {
    // Synthetic active Grade options whose numeric code or label differs from their numericValue.
    const numericOptions: readonly SearchInterpretationOption[] = [
      ...SEED_OPTIONS,
      { ...gemMint10, optionId: "chc_synthetic_code_10", code: "10", label: "Synthetic Pristine", numericValue: 10.5 },
      { ...gemMint10, optionId: "chc_synthetic_label_8", code: "synthetic-eight", label: "8", numericValue: 8.25 },
    ];
    for (const search of ["charizard 10", "charizard 8", "10 charizard"]) {
      expect(await interpret(search, {}, numericOptions)).toBeNull();
    }
    expect((await interpret("charizard psa 10", {}, numericOptions))?.dimensionFilters).toEqual([psa, gemMint10]);
    expect(summary(await interpret("charizard psa 8", {}, numericOptions))?.applied).toEqual([
      `dimension.${gradingCompany.dimensionId}=PSA`,
      `dimension.${grade.dimensionId}=NM-MT 8`,
    ]);
    for (const [search, label] of [
      ["charizard grade 9.5", "Mint 9.5"],
      ["charizard pristine 10", "Pristine 10"],
      ["charizard mint 9", "Mint 9"],
      ["charizard gem-mint-10", "Gem Mint 10"],
    ]) {
      expect(summary(await interpret(search, {}, numericOptions))).toEqual({
        q: "charizard",
        applied: [`dimension.${grade.dimensionId}=${label}`],
      });
    }
  });

  it("qualifies only a number that follows its company", async () => {
    expect(summary(await interpret("charizard 10 psa"))).toEqual({
      q: "charizard 10",
      applied: [`dimension.${gradingCompany.dimensionId}=PSA`],
    });
  });

  it("keeps a served set code literal even when it spells a company", async () => {
    expect(await interpret("charizard tag 10", {}, SEED_OPTIONS, ["tag"])).toBeNull();
  });

  it("keeps a phrase naming options in more than one dimension literal", async () => {
    const collision = {
      dimensionId: condition.dimensionId,
      optionId: "chc_test_psa",
      code: "psa",
      label: "PSA",
      numericValue: 8,
    };
    expect(await interpret("charizard psa 10", {}, [...SEED_OPTIONS, collision])).toBeNull();
    const languageCollision = { ...collision, code: "japanese", label: "Japanese" };
    expect(summary(await interpret("charizard japanese psa", {}, [...SEED_OPTIONS, languageCollision]))).toEqual({
      q: "charizard japanese",
      applied: [`dimension.${gradingCompany.dimensionId}=PSA`],
    });
  });

  it("ignores inactive options because the vocabulary holds only active ones", async () => {
    const active = SEED_OPTIONS.filter((option) => option.optionId !== gradingCompany.optionIds.psa);
    expect(await interpret("charizard psa 10", {}, active)).toBeNull();
  });

  it("explicit filters win: a different value stays literal, an equal value is consumed silently", async () => {
    expect(summary(await interpret("charizard bgs 10", { dimensionFilters: [psa] }))).toBeNull();
    expect(summary(await interpret("charizard psa 10", { dimensionFilters: [psa] }))).toEqual({
      q: "charizard",
      applied: [`dimension.${grade.dimensionId}=Gem Mint 10`],
    });
    expect(summary(await interpret("charizard psa 10", { dimensionFilters: [psa, gemMint10] }))).toEqual({
      q: "charizard",
      applied: [],
    });
    expect(summary(await interpret("charizard japanese", { language: "en" }))).toBeNull();
    expect(summary(await interpret("charizard english", { language: "en" }))).toEqual({ q: "charizard", applied: [] });
    expect(summary(await interpret("charizard psa 10", { dimensionFilters: [bgs] }))).toBeNull();
  });

  it("never applies a second typed language over the first", async () => {
    expect(summary(await interpret("charizard japanese english"))).toEqual({
      q: "charizard english",
      applied: ["language=Japanese"],
    });
  });

  it("returns an empty remainder when every word was consumed", async () => {
    expect(summary(await interpret("psa 10"))).toEqual({
      q: "",
      applied: [`dimension.${gradingCompany.dimensionId}=PSA`, `dimension.${grade.dimensionId}=Gem Mint 10`],
    });
  });
});
