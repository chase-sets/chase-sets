import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { OptionId, DimensionId } from "../../../ids";
import { sendSeedCommand } from "../../../support/seed-support/context";
import { loadSeedAggregateState } from "../../../support/seed-support/aggregate-state";
import {
  decideDimension,
  evolveDimension,
  initialDimensionState,
  type DimensionCommand,
  type DimensionEvent,
  type DimensionState,
} from "../domain/domain";

type DimensionOptionDef = {
  optionId: OptionId;
  code: string;
  label: string;
  numericValue?: number;
  guideline?: Readonly<{
    summary: string;
    typicalCharacteristics?: readonly string[];
    possibleIssues?: readonly string[];
    verificationRequirements?: readonly string[];
  }>;
};

type DimensionDef = {
  key: string;
  dimensionId: DimensionId;
  name: string;
  description: string;
  valueKind: "unordered" | "ordered" | "numeric";
  options: DimensionOptionDef[];
};

const dimensionDefs: DimensionDef[] = [
  {
    key: "form",
    dimensionId: catalogSeedIds.dimensions.form.dimensionId as DimensionId,
    name: "Form",
    description: "How the card is offered as a sellable Product",
    valueKind: "unordered",
    options: [
      {
        optionId: catalogSeedIds.dimensions.form.optionIds.raw as OptionId,
        code: "raw",
        label: "Raw",
      },
      {
        optionId: catalogSeedIds.dimensions.form.optionIds.graded as OptionId,
        code: "graded",
        label: "Graded",
      },
    ],
  },
  {
    key: "condition",
    dimensionId: catalogSeedIds.dimensions.condition.dimensionId as DimensionId,
    name: "Condition",
    description: "Conditioning guideline for a raw, ungraded card",
    valueKind: "ordered",
    options: [
      {
        optionId: catalogSeedIds.dimensions.condition.optionIds.pristine as OptionId,
        code: "pristine",
        label: "Pristine",
        numericValue: 7,
        guideline: {
          summary:
            "No visible flaws to the naked eye under normal inspection. Card remains flawless when tilted under strong light. No noticeable centering issues.",
          typicalCharacteristics: [
            "Perfect corners and edges",
            "No scratches, dents, or whitening",
            "Centering within roughly 55/45 or better",
          ],
          verificationRequirements: [
            "Front straight on photo required",
            "Back straight on photo required",
            "Front under light photo required",
            "Back under light photo required",
          ],
        },
      },
      {
        optionId: catalogSeedIds.dimensions.condition.optionIds.mint as OptionId,
        code: "mint",
        label: "Mint",
        numericValue: 6,
        guideline: {
          summary:
            "Card appears flawless under normal viewing conditions. Extremely minor imperfections may exist but require deliberate angled lighting to detect.",
          possibleIssues: [
            "One faint hairline surface scratch under tilted light",
            "Tiny corner speck or edge nick",
            "Slight centering imperfection 60/40 or better",
          ],
          verificationRequirements: ["Front straight on photo required", "Back straight on photo required"],
        },
      },
      {
        optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint as OptionId,
        code: "near-mint",
        label: "Near Mint",
        numericValue: 5,
        guideline: {
          summary:
            "Card appears clean and well preserved at first glance. Minor imperfections may be visible on close inspection.",
          possibleIssues: [
            "Small corner whitening",
            "Minor edge wear",
            "Light surface scratches or print lines",
            "Slight centering imbalance 70/30 or better",
            "Often equivalent to pack-fresh condition.",
          ],
        },
      },
      {
        optionId: catalogSeedIds.dimensions.condition.optionIds.excellent as OptionId,
        code: "excellent",
        label: "Excellent",
        numericValue: 4,
        guideline: {
          summary: "Noticeable wear but the card still presents well overall.",
          possibleIssues: [
            "Multiple small edge chips",
            "Moderate corner wear",
            "Surface scratching visible under normal light",
            "Minor surface scuffing",
            "Card still looks good in a binder or display.",
          ],
        },
      },
      {
        optionId: catalogSeedIds.dimensions.condition.optionIds.good as OptionId,
        code: "good",
        label: "Good",
        numericValue: 3,
        guideline: {
          summary:
            "Clear wear is visible across multiple areas of the card but the card remains visually complete and structurally intact.",
          possibleIssues: [
            "Heavier corner rounding",
            "Edge wear across multiple sides",
            "Surface scratches or scuffing",
            "Minor indentations or pressure marks",
            "Still fully intact and collectible.",
          ],
        },
      },
      {
        optionId: catalogSeedIds.dimensions.condition.optionIds.poor as OptionId,
        code: "poor",
        label: "Poor",
        numericValue: 2,
        guideline: {
          summary: "Significant visible wear across much of the card, though the card remains structurally intact.",
          possibleIssues: [
            "Heavy corner rounding",
            "Major edge wear",
            "Surface scuffs or scratches across large areas",
            "Multiple dents or impressions",
            "Card remains identifiable and collectible but clearly worn.",
          ],
        },
      },
      {
        optionId: catalogSeedIds.dimensions.condition.optionIds.damaged as OptionId,
        code: "damaged",
        label: "Damaged",
        numericValue: 1,
        guideline: {
          summary: "Card has structural damage but remains identifiable and authentic.",
          possibleIssues: ["Creases or folds", "Tears", "Water damage or staining", "Peeling layers or severe dents"],
          verificationRequirements: ["Front straight on photo required", "Back straight on photo required"],
        },
      },
    ],
  },
  {
    key: "grading-company",
    dimensionId: catalogSeedIds.dimensions.gradingCompany.dimensionId as DimensionId,
    name: "Grading Company",
    description: "Professional grading service that authenticated and graded the card",
    valueKind: "unordered",
    options: [
      {
        optionId: catalogSeedIds.dimensions.gradingCompany.optionIds.psa as OptionId,
        code: "psa",
        label: "PSA",
      },
      {
        optionId: catalogSeedIds.dimensions.gradingCompany.optionIds.bgs as OptionId,
        code: "bgs",
        label: "BGS",
      },
      {
        optionId: catalogSeedIds.dimensions.gradingCompany.optionIds.cgc as OptionId,
        code: "cgc",
        label: "CGC",
      },
      {
        optionId: catalogSeedIds.dimensions.gradingCompany.optionIds.sgc as OptionId,
        code: "sgc",
        label: "SGC",
      },
      {
        optionId: catalogSeedIds.dimensions.gradingCompany.optionIds.ace as OptionId,
        code: "ace",
        label: "ACE",
      },
      {
        optionId: catalogSeedIds.dimensions.gradingCompany.optionIds.tag as OptionId,
        code: "tag",
        label: "TAG",
      },
    ],
  },
  {
    key: "grade",
    dimensionId: catalogSeedIds.dimensions.grade.dimensionId as DimensionId,
    name: "Grade",
    description: "Numeric grade assigned by a professional grading company",
    valueKind: "numeric",
    options: [
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.pristine10 as OptionId,
        code: "pristine-10",
        label: "Pristine 10",
        numericValue: 10.5,
      },
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.gemMint10 as OptionId,
        code: "gem-mint-10",
        label: "Gem Mint 10",
        numericValue: 10,
      },
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.mint95 as OptionId,
        code: "mint-9.5",
        label: "Mint 9.5",
        numericValue: 9.5,
      },
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.mint9 as OptionId,
        code: "mint-9",
        label: "Mint 9",
        numericValue: 9,
      },
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.nmMt85 as OptionId,
        code: "nm-mt-8.5",
        label: "NM-MT 8.5",
        numericValue: 8.5,
      },
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.nmMt8 as OptionId,
        code: "nm-mt-8",
        label: "NM-MT 8",
        numericValue: 8,
      },
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.nm7 as OptionId,
        code: "nm-7",
        label: "NM 7",
        numericValue: 7,
      },
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.ex6 as OptionId,
        code: "ex-6",
        label: "EX 6",
        numericValue: 6,
      },
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.ex5 as OptionId,
        code: "ex-5",
        label: "EX 5",
        numericValue: 5,
      },
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.vg4 as OptionId,
        code: "vg-4",
        label: "VG 4",
        numericValue: 4,
      },
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.good3 as OptionId,
        code: "good-3",
        label: "Good 3",
        numericValue: 3,
      },
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.good2 as OptionId,
        code: "good-2",
        label: "Good 2",
        numericValue: 2,
      },
      {
        optionId: catalogSeedIds.dimensions.grade.optionIds.poor1 as OptionId,
        code: "poor-1",
        label: "Poor 1",
        numericValue: 1,
      },
    ],
  },
];

export type DimensionIds = Record<
  string,
  { dimensionId: DimensionId; optionIds: Record<string, OptionId>; orderedOptionIds: OptionId[] }
>;

export const dimensionSeedRequirements = dimensionDefs.map((def) => ({
  aggregateName: "Dimension",
  id: def.dimensionId,
  key: def.key,
  streamId: `catalog.dimension-${def.dimensionId}`,
})) as readonly Readonly<{ aggregateName: "Dimension"; id: DimensionId; key: string; streamId: string }>[];

export async function seedDimensions(services: CatalogServices): Promise<DimensionIds> {
  console.log("Seeding dimensions...");
  const result: DimensionIds = {};
  const states = new Map<string, DimensionState>();

  for (const def of dimensionDefs) {
    const streamId = `catalog.dimension-${def.dimensionId}`;
    const optionIds: Record<string, OptionId> = {};
    const orderedOptionIds: OptionId[] = [];

    await sendDimensionSeedCommand(services, states, streamId, {
      type: "CreateDimension",
      dimensionId: def.dimensionId,
      key: def.key,
      name: localizedTextMapFromEnglish(def.name),
      description: localizedTextMapFromEnglish(def.description),
      valueKind: def.valueKind,
    });

    for (const option of def.options) {
      optionIds[option.code] = option.optionId;
      orderedOptionIds.push(option.optionId);

      await sendDimensionSeedCommand(services, states, streamId, {
        type: "AddOption",
        optionId: option.optionId,
        code: option.code,
        label: localizedTextMapFromEnglish(option.label),
        numericValue: option.numericValue ?? null,
      });
    }

    await sendDimensionSeedCommand(services, states, streamId, {
      type: "ActivateDimension",
    });

    result[def.key] = { dimensionId: def.dimensionId, optionIds, orderedOptionIds };
    console.log(`  Dimension "${def.name}" created with ${def.options.length} options`);
  }

  return result;
}

async function sendDimensionSeedCommand(
  services: CatalogServices,
  states: Map<string, DimensionState>,
  streamId: string,
  command: DimensionCommand,
): Promise<void> {
  const expectedId =
    command.type === "CreateDimension"
      ? command.dimensionId
      : (dimensionDefs.find((def) => `catalog.dimension-${def.dimensionId}` === streamId)?.dimensionId ??
        (() => {
          throw new Error(`Unknown Catalog integration Dimension stream '${streamId}'.`);
        })());
  const def = dimensionDefs.find((candidate) => candidate.dimensionId === expectedId);
  if (!def) {
    throw new Error(`Unknown Catalog integration Dimension '${expectedId}'.`);
  }
  const persisted = states.has(streamId)
    ? undefined
    : await loadSeedAggregateState({
        db: services.db,
        aggregateName: "Dimension",
        streamId,
        createdEventType: "catalog.dimension.created",
        createdIdField: "dimensionId",
        expectedId: def.dimensionId,
        expectedKey: def.key,
        initialState: initialDimensionState,
        evolve: evolveDimension,
      });
  const state = states.get(streamId) ?? persisted?.state ?? initialDimensionState;
  const kind = persisted?.kind ?? (state.id === null ? "absent" : state.status === "active" ? "active" : "draft");
  states.set(streamId, state);

  if (kind === "active") {
    return;
  }
  if (command.type === "CreateDimension") {
    if (kind === "draft") {
      return;
    }
  } else if (kind === "absent") {
    throw new Error(`Catalog integration bootstrap Dimension '${def.key}' must be created before '${command.type}'.`);
  }

  if (command.type === "AddOption") {
    const sameId = state.options.find((option) => option.id === command.optionId);
    const sameCode = state.options.find((option) => option.code === command.code);
    if (sameId && sameCode && sameId.id === sameCode.id) {
      return;
    }
    if (sameId || sameCode) {
      const found = sameId ?? sameCode;
      throw new Error(
        `Catalog integration bootstrap Dimension '${def.key}' expected Option id '${command.optionId}' and code '${command.code}', but found id '${found?.id ?? "null"}' and code '${found?.code ?? "null"}'.`,
      );
    }
  }

  await sendSeedCommand(services.dimensions.commandHandler, streamId, command);
  states.set(streamId, decideDimension(state, command).reduce(evolveDimension, state));
}
