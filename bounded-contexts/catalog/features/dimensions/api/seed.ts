import { catalogSeedIds } from "../../../support/seed-support/ids";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { ChoiceId, DimensionId } from "../../../ids";
import { sendSeedCommand } from "../../../support/seed-support/context";

type DimensionChoiceDef = {
  choiceId: ChoiceId;
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
    description: "Conditioning guideline for a raw, ungraded card",
    choices: [
      {
        choiceId: catalogSeedIds.dimensions.condition.choiceIds.pristine as ChoiceId,
        code: "pristine",
        label: "Pristine",
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
        choiceId: catalogSeedIds.dimensions.condition.choiceIds.mint as ChoiceId,
        code: "mint",
        label: "Mint",
        guideline: {
          summary:
            "Card appears flawless under normal viewing conditions. Extremely minor imperfections may exist but require deliberate angled lighting to detect.",
          possibleIssues: [
            "One faint hairline surface scratch under tilted light",
            "Tiny corner speck or edge nick",
            "Slight centering imperfection 60/40 or better",
          ],
          verificationRequirements: [
            "Front straight on photo required",
            "Back straight on photo required",
          ],
        },
      },
      {
        choiceId: catalogSeedIds.dimensions.condition.choiceIds.nearMint as ChoiceId,
        code: "near-mint",
        label: "Near Mint",
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
        choiceId: catalogSeedIds.dimensions.condition.choiceIds.excellent as ChoiceId,
        code: "excellent",
        label: "Excellent",
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
        choiceId: catalogSeedIds.dimensions.condition.choiceIds.good as ChoiceId,
        code: "good",
        label: "Good",
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
        choiceId: catalogSeedIds.dimensions.condition.choiceIds.poor as ChoiceId,
        code: "poor",
        label: "Poor",
        guideline: {
          summary:
            "Significant visible wear across much of the card, though the card remains structurally intact.",
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
        choiceId: catalogSeedIds.dimensions.condition.choiceIds.damaged as ChoiceId,
        code: "damaged",
        label: "Damaged",
        guideline: {
          summary:
            "Card has structural damage but remains identifiable and authentic.",
          possibleIssues: [
            "Creases or folds",
            "Tears",
            "Water damage or staining",
            "Peeling layers or severe dents",
          ],
          verificationRequirements: [
            "Front straight on photo required",
            "Back straight on photo required",
          ],
        },
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


