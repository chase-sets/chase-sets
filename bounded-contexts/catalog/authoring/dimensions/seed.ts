import { catalogSeedIds } from "@chase-sets/dev-seeds";
import type { CatalogServices } from "../services";
import type { ChoiceId, DimensionId } from "../../ids";
import { sendSeedCommand } from "../seed-support";

type DimensionChoiceDef = {
  choiceId: ChoiceId;
  code: string;
  label: string;
  numericValue?: number;
};

type DimensionDef = {
  key: string;
  dimensionId: DimensionId;
  name: string;
  description: string;
  choices: DimensionChoiceDef[];
};

const dimensionDefs: DimensionDef[] = [
  {
    key: "form",
    dimensionId: catalogSeedIds.dimensions.form.dimensionId as DimensionId,
    name: "Form",
    description: "How the card is offered as a sellable version",
    choices: [
      {
        choiceId: catalogSeedIds.dimensions.form.choiceIds.raw as ChoiceId,
        code: "raw",
        label: "Raw",
      },
      {
        choiceId: catalogSeedIds.dimensions.form.choiceIds.graded as ChoiceId,
        code: "graded",
        label: "Graded",
      },
    ],
  },
  {
    key: "condition",
    dimensionId: catalogSeedIds.dimensions.condition.dimensionId as DimensionId,
    name: "Condition",
    description: "Physical condition of a raw, ungraded card",
    choices: [
      {
        choiceId: catalogSeedIds.dimensions.condition.choiceIds.mint as ChoiceId,
        code: "mint",
        label: "Mint",
      },
      {
        choiceId: catalogSeedIds.dimensions.condition.choiceIds.nearMint as ChoiceId,
        code: "near-mint",
        label: "Near Mint",
      },
      {
        choiceId: catalogSeedIds.dimensions.condition.choiceIds.lightlyPlayed as ChoiceId,
        code: "lightly-played",
        label: "Lightly Played",
      },
      {
        choiceId:
          catalogSeedIds.dimensions.condition.choiceIds.moderatelyPlayed as ChoiceId,
        code: "moderately-played",
        label: "Moderately Played",
      },
      {
        choiceId: catalogSeedIds.dimensions.condition.choiceIds.heavilyPlayed as ChoiceId,
        code: "heavily-played",
        label: "Heavily Played",
      },
      {
        choiceId: catalogSeedIds.dimensions.condition.choiceIds.damaged as ChoiceId,
        code: "damaged",
        label: "Damaged",
      },
    ],
  },
  {
    key: "grading-company",
    dimensionId: catalogSeedIds.dimensions.gradingCompany.dimensionId as DimensionId,
    name: "Grading Company",
    description:
      "Professional grading service that authenticated and graded the card",
    choices: [
      {
        choiceId: catalogSeedIds.dimensions.gradingCompany.choiceIds.psa as ChoiceId,
        code: "psa",
        label: "PSA",
      },
      {
        choiceId: catalogSeedIds.dimensions.gradingCompany.choiceIds.bgs as ChoiceId,
        code: "bgs",
        label: "BGS/Beckett",
      },
      {
        choiceId: catalogSeedIds.dimensions.gradingCompany.choiceIds.cgc as ChoiceId,
        code: "cgc",
        label: "CGC",
      },
      {
        choiceId: catalogSeedIds.dimensions.gradingCompany.choiceIds.sgc as ChoiceId,
        code: "sgc",
        label: "SGC",
      },
      {
        choiceId: catalogSeedIds.dimensions.gradingCompany.choiceIds.ace as ChoiceId,
        code: "ace",
        label: "ACE",
      },
      {
        choiceId: catalogSeedIds.dimensions.gradingCompany.choiceIds.tag as ChoiceId,
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
    choices: [
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.pristine10 as ChoiceId,
        code: "pristine-10",
        label: "Pristine 10",
        numericValue: 10.5,
      },
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.gemMint10 as ChoiceId,
        code: "gem-mint-10",
        label: "Gem Mint 10",
        numericValue: 10,
      },
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.mint95 as ChoiceId,
        code: "mint-9.5",
        label: "Mint 9.5",
        numericValue: 9.5,
      },
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.mint9 as ChoiceId,
        code: "mint-9",
        label: "Mint 9",
        numericValue: 9,
      },
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.nmMt85 as ChoiceId,
        code: "nm-mt-8.5",
        label: "NM-MT 8.5",
        numericValue: 8.5,
      },
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.nmMt8 as ChoiceId,
        code: "nm-mt-8",
        label: "NM-MT 8",
        numericValue: 8,
      },
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.nm7 as ChoiceId,
        code: "nm-7",
        label: "NM 7",
        numericValue: 7,
      },
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.ex6 as ChoiceId,
        code: "ex-6",
        label: "EX 6",
        numericValue: 6,
      },
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.ex5 as ChoiceId,
        code: "ex-5",
        label: "EX 5",
        numericValue: 5,
      },
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.vg4 as ChoiceId,
        code: "vg-4",
        label: "VG 4",
        numericValue: 4,
      },
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.good3 as ChoiceId,
        code: "good-3",
        label: "Good 3",
        numericValue: 3,
      },
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.good2 as ChoiceId,
        code: "good-2",
        label: "Good 2",
        numericValue: 2,
      },
      {
        choiceId: catalogSeedIds.dimensions.grade.choiceIds.poor1 as ChoiceId,
        code: "poor-1",
        label: "Poor 1",
        numericValue: 1,
      },
    ],
  },
];

export type DimensionIds = Record<
  string,
  { dimensionId: DimensionId; choiceIds: Record<string, ChoiceId> }
>;

export async function seedDimensions(
  services: CatalogServices,
): Promise<DimensionIds> {
  console.log("Seeding dimensions...");
  const result: DimensionIds = {};

  for (const def of dimensionDefs) {
    const streamId = `catalog.dimension-${def.dimensionId}`;
    const choiceIds: Record<string, ChoiceId> = {};

    await sendSeedCommand(services.dimensions.commandHandler, streamId, {
      type: "CreateDimension",
      dimensionId: def.dimensionId,
      key: def.key,
      name: def.name,
      description: def.description,
    });

    for (const choice of def.choices) {
      choiceIds[choice.code] = choice.choiceId;

      await sendSeedCommand(services.dimensions.commandHandler, streamId, {
        type: "AddChoice",
        choiceId: choice.choiceId,
        code: choice.code,
        labels: [{ locale: "en", value: choice.label }],
        numericValue: choice.numericValue ?? null,
      });
    }

    await sendSeedCommand(services.dimensions.commandHandler, streamId, {
      type: "ActivateDimension",
    });

    result[def.key] = { dimensionId: def.dimensionId, choiceIds };
    console.log(
      `  Dimension "${def.name}" created with ${def.choices.length} choices`,
    );
  }

  return result;
}
