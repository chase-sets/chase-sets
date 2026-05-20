import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import { catalogSeedIds } from "../../../support/seed-support/ids";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { BlueprintId } from "../../../ids";
import { sendSeedCommand } from "../../../support/seed-support/context";
import type { ComponentIds } from "../../components/api/seed";
import type { DimensionIds } from "../../dimensions/api/seed";
import type { FieldIds } from "../../fields/api/seed";

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
    const blueprintId = catalogSeedIds.blueprints.pokemonCardSingle as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;
    const formDimension = dimensions.form;

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "CreateBlueprint",
      blueprintId,
      key: "pokemon-card-single",
      name: localizedTextMapFromEnglish("Pokemon Card Single"),
      description: localizedTextMapFromEnglish(
        "Template for a specific printed Pokemon card with raw and graded Products",
      ),
    });

    for (const compKey of ["single-card-identity", "single-card-product-resolution"] as const) {
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
        { fieldId: fields.expansion, required: true },
        { fieldId: fields.rarity, required: true },
        { fieldId: fields["card-variant"], required: false },
        { fieldId: fields["card-illustrator"], required: false },
        { fieldId: fields["release-year"], required: false },
      ],
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "SetBlueprintDimensions",
      dimensionRules: [
        {
          dimensionId: formDimension.dimensionId,
          required: true,
          allowedOptionIds: formDimension.orderedOptionIds,
        },
        {
          dimensionId: dimensions.condition.dimensionId,
          required: true,
          allowedOptionIds: dimensions.condition.orderedOptionIds,
          appliesWhen: [
            {
              dimensionId: formDimension.dimensionId,
              optionIds: [formDimension.optionIds.raw],
            },
          ],
        },
        {
          dimensionId: dimensions["grading-company"].dimensionId,
          required: true,
          allowedOptionIds: dimensions["grading-company"].orderedOptionIds,
          appliesWhen: [
            {
              dimensionId: formDimension.dimensionId,
              optionIds: [formDimension.optionIds.graded],
            },
          ],
        },
        {
          dimensionId: dimensions.grade.dimensionId,
          required: true,
          allowedOptionIds: dimensions.grade.orderedOptionIds,
          appliesWhen: [
            {
              dimensionId: formDimension.dimensionId,
              optionIds: [formDimension.optionIds.graded],
            },
          ],
        },
      ],
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "SetBlueprintProductResolutionRules",
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
    const blueprintId =
      catalogSeedIds.blueprints.pokemonSealedProduct as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "CreateBlueprint",
      blueprintId,
      key: "pokemon-sealed-product",
      name: localizedTextMapFromEnglish("Pokemon Sealed Product"),
      description: localizedTextMapFromEnglish(
        "Template for Pokemon sealed products such as booster packs, booster boxes, and elite trainer boxes",
      ),
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "AttachComponentToBlueprint",
      componentId: components["sealed-product-identity"],
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "SetBlueprintFields",
      fieldRules: [
        { fieldId: fields.expansion, required: true },
        { fieldId: fields["release-year"], required: false },
        { fieldId: fields["pack-count"], required: true },
      ],
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "SetBlueprintDimensions",
      dimensionRules: [],
    });

    await sendSeedCommand(services.blueprints.commandHandler, streamId, {
      type: "SetBlueprintProductResolutionRules",
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
