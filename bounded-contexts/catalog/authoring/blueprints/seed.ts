import { createId } from "../../../../contracts/primitives/typed-ids";
import type { CatalogServices } from "../runtime";
import type { BlueprintId } from "../../ids";
import { sendSeedCommand } from "../seed-support";
import type { ComponentIds } from "../components/seed";
import type { DimensionIds } from "../dimensions/seed";
import type { FieldIds } from "../fields/seed";

export type BlueprintIds = Record<string, BlueprintId>;

export async function seedBlueprints(
  services: CatalogServices,
  components: ComponentIds,
  dimensions: DimensionIds,
  fields: FieldIds,
): Promise<BlueprintIds> {
  console.log("Seeding blueprints...");
  const result: BlueprintIds = {};

  {
    const blueprintId = createId("bpr") as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;

    await sendSeedCommand(services.blueprintHandler, streamId, {
      type: "CreateBlueprint",
      blueprintId,
      key: "raw-pokemon-card",
      name: "Raw Pokemon Card",
      description:
        "Template for ungraded Pokemon trading cards assessed by condition",
    });

    for (const compKey of ["base-card-info", "card-condition"] as const) {
      await sendSeedCommand(services.blueprintHandler, streamId, {
        type: "AttachComponentToBlueprint",
        componentId: components[compKey],
      });
    }

    await sendSeedCommand(services.blueprintHandler, streamId, {
      type: "SetBlueprintFields",
      fieldRules: [
        { fieldId: fields["card-number"], required: true },
        { fieldId: fields["card-name"], required: true },
        { fieldId: fields.artist, required: false },
        { fieldId: fields["year-printed"], required: false },
      ],
    });

    const rawDimKeys = [
      "pokemon-set",
      "rarity",
      "language",
      "condition",
    ] as const;

    await sendSeedCommand(services.blueprintHandler, streamId, {
      type: "SetBlueprintDimensions",
      dimensionRules: rawDimKeys.map((dimKey) => {
        const dim = dimensions[dimKey];
        return {
          dimensionId: dim.dimensionId,
          required: true,
          allowedChoiceIds: Object.values(dim.choiceIds),
        };
      }),
    });

    await sendSeedCommand(services.blueprintHandler, streamId, {
      type: "SetBlueprintVersionRules",
      canonicalDimensionOrder: rawDimKeys.map((key) => dimensions[key].dimensionId),
    });

    await sendSeedCommand(services.blueprintHandler, streamId, {
      type: "PublishBlueprint",
    });

    result["raw-pokemon-card"] = blueprintId;
    console.log('  Blueprint "Raw Pokemon Card" created and published');
  }

  {
    const blueprintId = createId("bpr") as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;

    await sendSeedCommand(services.blueprintHandler, streamId, {
      type: "CreateBlueprint",
      blueprintId,
      key: "graded-pokemon-card",
      name: "Graded Pokemon Card",
      description: "Template for professionally graded Pokemon trading cards",
    });

    for (const compKey of ["base-card-info", "card-grading"] as const) {
      await sendSeedCommand(services.blueprintHandler, streamId, {
        type: "AttachComponentToBlueprint",
        componentId: components[compKey],
      });
    }

    await sendSeedCommand(services.blueprintHandler, streamId, {
      type: "SetBlueprintFields",
      fieldRules: [
        { fieldId: fields["card-number"], required: true },
        { fieldId: fields["card-name"], required: true },
        { fieldId: fields.artist, required: false },
        { fieldId: fields["year-printed"], required: false },
        { fieldId: fields["cert-number"], required: false },
        { fieldId: fields["pop-count"], required: false },
      ],
    });

    const gradedDimKeys = [
      "pokemon-set",
      "rarity",
      "language",
      "grading-company",
      "grade",
    ] as const;

    await sendSeedCommand(services.blueprintHandler, streamId, {
      type: "SetBlueprintDimensions",
      dimensionRules: gradedDimKeys.map((dimKey) => {
        const dim = dimensions[dimKey];
        return {
          dimensionId: dim.dimensionId,
          required: true,
          allowedChoiceIds: Object.values(dim.choiceIds),
        };
      }),
    });

    await sendSeedCommand(services.blueprintHandler, streamId, {
      type: "SetBlueprintVersionRules",
      canonicalDimensionOrder: gradedDimKeys.map((key) => dimensions[key].dimensionId),
    });

    await sendSeedCommand(services.blueprintHandler, streamId, {
      type: "PublishBlueprint",
    });

    result["graded-pokemon-card"] = blueprintId;
    console.log('  Blueprint "Graded Pokemon Card" created and published');
  }

  return result;
}
