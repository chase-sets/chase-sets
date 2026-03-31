import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogServices } from "../services";
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
    const formDimension = dimensions.form;

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "CreateBlueprint",
      blueprintId,
      key: "pokemon-card-single",
      name: "Pokemon Card Single",
      description:
        "Template for a specific printed Pokemon card with raw and graded sellable versions",
    });

    for (const compKey of ["single-card-identity", "single-card-versioning"] as const) {
      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "AttachComponentToBlueprint",
        componentId: components[compKey],
      });
    }

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "SetBlueprintFields",
      fieldRules: [
        { fieldId: fields["card-number"], required: true },
        { fieldId: fields["card-name"], required: true },
        { fieldId: fields["set-name"], required: true },
        { fieldId: fields.rarity, required: true },
        { fieldId: fields.language, required: true },
        { fieldId: fields.artist, required: false },
        { fieldId: fields["release-year"], required: false },
      ],
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "SetBlueprintDimensions",
      dimensionRules: [
        {
          dimensionId: formDimension.dimensionId,
          required: true,
          allowedChoiceIds: Object.values(formDimension.choiceIds),
        },
        {
          dimensionId: dimensions.condition.dimensionId,
          required: true,
          allowedChoiceIds: Object.values(dimensions.condition.choiceIds),
          appliesWhen: [
            {
              dimensionId: formDimension.dimensionId,
              choiceIds: [formDimension.choiceIds.raw],
            },
          ],
        },
        {
          dimensionId: dimensions["grading-company"].dimensionId,
          required: true,
          allowedChoiceIds: Object.values(dimensions["grading-company"].choiceIds),
          appliesWhen: [
            {
              dimensionId: formDimension.dimensionId,
              choiceIds: [formDimension.choiceIds.graded],
            },
          ],
        },
        {
          dimensionId: dimensions.grade.dimensionId,
          required: true,
          allowedChoiceIds: Object.values(dimensions.grade.choiceIds),
          appliesWhen: [
            {
              dimensionId: formDimension.dimensionId,
              choiceIds: [formDimension.choiceIds.graded],
            },
          ],
        },
      ],
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "SetBlueprintVersionRules",
      canonicalDimensionOrder: [
        formDimension.dimensionId,
        dimensions.condition.dimensionId,
        dimensions["grading-company"].dimensionId,
        dimensions.grade.dimensionId,
      ],
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "PublishBlueprint",
    });

    result["pokemon-card-single"] = blueprintId;
    console.log('  Blueprint "Pokemon Card Single" created and published');
  }

  {
    const blueprintId = createId("bpr") as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "CreateBlueprint",
      blueprintId,
      key: "pokemon-sealed-product",
      name: "Pokemon Sealed Product",
      description:
        "Template for Pokemon sealed products such as booster packs, booster boxes, and elite trainer boxes",
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "AttachComponentToBlueprint",
      componentId: components["sealed-product-identity"],
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "SetBlueprintFields",
      fieldRules: [
        { fieldId: fields["set-name"], required: true },
        { fieldId: fields.language, required: true },
        { fieldId: fields["release-year"], required: false },
        { fieldId: fields["pack-count"], required: true },
      ],
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "SetBlueprintDimensions",
      dimensionRules: [],
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "SetBlueprintVersionRules",
      canonicalDimensionOrder: [],
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "PublishBlueprint",
    });

    result["pokemon-sealed-product"] = blueprintId;
    console.log('  Blueprint "Pokemon Sealed Product" created and published');
  }

  return result;
}
