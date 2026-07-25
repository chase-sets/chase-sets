import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
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
  options: Readonly<{ reconcileExisting?: boolean }> = {},
): Promise<BlueprintIds> {
  console.log("Seeding blueprints...");
  const result: BlueprintIds = {};

  {
    const blueprintId = catalogSeedIds.blueprints.pokemonCardSingle as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;
    const formDimension = dimensions.form;

    if (!(options.reconcileExisting && (await blueprintExists(services, blueprintId, "pokemon-card-single")))) {
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
    }

    result["pokemon-card-single"] = blueprintId;
    console.log('  Blueprint "Pokemon Card Single" created and published');
  }

  {
    const blueprintId = catalogSeedIds.blueprints.pokemonSealedProduct as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;

    if (!(options.reconcileExisting && (await blueprintExists(services, blueprintId, "pokemon-sealed-product")))) {
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
    }

    result["pokemon-sealed-product"] = blueprintId;
    console.log('  Blueprint "Pokemon Sealed Product" created and published');
  }

  Object.assign(result, await seedMagicBlueprints(services, components, dimensions, fields, options));
  Object.assign(result, await seedOnePieceBlueprints(services, components, dimensions, fields, options));
  Object.assign(result, await seedLorcanaBlueprints(services, components, dimensions, fields, options));

  return result;
}

export async function seedMagicBlueprints(
  services: CatalogServices,
  components: ComponentIds,
  dimensions: DimensionIds,
  fields: FieldIds,
  options: Readonly<{ reconcileExisting?: boolean }> = { reconcileExisting: true },
): Promise<BlueprintIds> {
  const result: BlueprintIds = {};

  {
    const blueprintId = catalogSeedIds.blueprints.magicCardPrint as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;
    const formDimension = dimensions.form;

    if (!(options.reconcileExisting && (await blueprintExists(services, blueprintId, "magic-card-print")))) {
      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "CreateBlueprint",
        blueprintId,
        key: "magic-card-print",
        name: localizedTextMapFromEnglish("Magic Card Print"),
        description: localizedTextMapFromEnglish(
          "Template for a specific printed Magic card with raw and graded Products",
        ),
      });

      for (const compKey of ["magic-card-print-identity", "magic-card-product-resolution"] as const) {
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
          { fieldId: fields.set, required: true },
          { fieldId: fields.rarity, required: false },
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
            appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.raw] }],
          },
          {
            dimensionId: dimensions["grading-company"].dimensionId,
            required: true,
            allowedOptionIds: dimensions["grading-company"].orderedOptionIds,
            appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.graded] }],
          },
          {
            dimensionId: dimensions.grade.dimensionId,
            required: true,
            allowedOptionIds: dimensions.grade.orderedOptionIds,
            appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.graded] }],
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
    }

    result["magic-card-print"] = blueprintId;
  }

  {
    const blueprintId = catalogSeedIds.blueprints.magicSealedProduct as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;

    if (!(options.reconcileExisting && (await blueprintExists(services, blueprintId, "magic-sealed-product")))) {
      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "CreateBlueprint",
        blueprintId,
        key: "magic-sealed-product",
        name: localizedTextMapFromEnglish("Magic Sealed Product"),
        description: localizedTextMapFromEnglish("Template for Magic sealed products such as booster packs and boxes"),
      });

      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "AttachComponentToBlueprint",
        componentId: components["magic-sealed-product-identity"],
      });

      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "SetBlueprintFields",
        fieldRules: [
          { fieldId: fields.set, required: true },
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
    }

    result["magic-sealed-product"] = blueprintId;
  }

  return result;
}

export async function seedOnePieceBlueprints(
  services: CatalogServices,
  components: ComponentIds,
  dimensions: DimensionIds,
  fields: FieldIds,
  options: Readonly<{ reconcileExisting?: boolean }> = { reconcileExisting: true },
): Promise<BlueprintIds> {
  const result: BlueprintIds = {};

  {
    const blueprintId = catalogSeedIds.blueprints.onePieceCardPrint as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;
    const formDimension = dimensions.form;

    if (!(options.reconcileExisting && (await blueprintExists(services, blueprintId, "one-piece-card-print")))) {
      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "CreateBlueprint",
        blueprintId,
        key: "one-piece-card-print",
        name: localizedTextMapFromEnglish("One Piece Card Print"),
        description: localizedTextMapFromEnglish(
          "Template for a specific printed One Piece card with raw and graded Products",
        ),
      });

      for (const compKey of ["one-piece-card-print-identity", "one-piece-card-product-resolution"] as const) {
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
          { fieldId: fields.set, required: true },
          { fieldId: fields.rarity, required: false },
          { fieldId: fields["card-variant"], required: false },
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
            appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.raw] }],
          },
          {
            dimensionId: dimensions["grading-company"].dimensionId,
            required: true,
            allowedOptionIds: dimensions["grading-company"].orderedOptionIds,
            appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.graded] }],
          },
          {
            dimensionId: dimensions.grade.dimensionId,
            required: true,
            allowedOptionIds: dimensions.grade.orderedOptionIds,
            appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.graded] }],
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
    }

    result["one-piece-card-print"] = blueprintId;
  }

  {
    const blueprintId = catalogSeedIds.blueprints.onePieceSealedProduct as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;

    if (!(options.reconcileExisting && (await blueprintExists(services, blueprintId, "one-piece-sealed-product")))) {
      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "CreateBlueprint",
        blueprintId,
        key: "one-piece-sealed-product",
        name: localizedTextMapFromEnglish("One Piece Sealed Product"),
        description: localizedTextMapFromEnglish(
          "Template for One Piece sealed products such as booster packs, booster boxes, and starter decks",
        ),
      });

      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "AttachComponentToBlueprint",
        componentId: components["one-piece-sealed-product-identity"],
      });

      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "SetBlueprintFields",
        fieldRules: [
          { fieldId: fields.set, required: true },
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
    }

    result["one-piece-sealed-product"] = blueprintId;
  }

  return result;
}

export async function seedLorcanaBlueprints(
  services: CatalogServices,
  components: ComponentIds,
  dimensions: DimensionIds,
  fields: FieldIds,
  options: Readonly<{ reconcileExisting?: boolean }> = { reconcileExisting: true },
): Promise<BlueprintIds> {
  const result: BlueprintIds = {};

  {
    const blueprintId = catalogSeedIds.blueprints.lorcanaCardPrint as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;
    const formDimension = dimensions.form;

    if (!(options.reconcileExisting && (await blueprintExists(services, blueprintId, "lorcana-card-print")))) {
      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "CreateBlueprint",
        blueprintId,
        key: "lorcana-card-print",
        name: localizedTextMapFromEnglish("Lorcana Card Print"),
        description: localizedTextMapFromEnglish(
          "Template for a specific printed Disney Lorcana card with raw and graded Products",
        ),
      });

      for (const compKey of ["lorcana-card-print-identity", "lorcana-card-product-resolution"] as const) {
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
          { fieldId: fields.set, required: true },
          { fieldId: fields.rarity, required: false },
          { fieldId: fields["card-variant"], required: false },
          { fieldId: fields["ink-color"], required: false },
          { fieldId: fields["card-type"], required: false },
          { fieldId: fields["card-classifications"], required: false },
          { fieldId: fields["card-properties"], required: false },
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
            appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.raw] }],
          },
          {
            dimensionId: dimensions["grading-company"].dimensionId,
            required: true,
            allowedOptionIds: dimensions["grading-company"].orderedOptionIds,
            appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.graded] }],
          },
          {
            dimensionId: dimensions.grade.dimensionId,
            required: true,
            allowedOptionIds: dimensions.grade.orderedOptionIds,
            appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.graded] }],
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
    }

    result["lorcana-card-print"] = blueprintId;
  }

  {
    const blueprintId = catalogSeedIds.blueprints.lorcanaSealedProduct as BlueprintId;
    const streamId = `catalog.blueprint-${blueprintId}`;

    if (!(options.reconcileExisting && (await blueprintExists(services, blueprintId, "lorcana-sealed-product")))) {
      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "CreateBlueprint",
        blueprintId,
        key: "lorcana-sealed-product",
        name: localizedTextMapFromEnglish("Lorcana Sealed Product"),
        description: localizedTextMapFromEnglish(
          "Template for Disney Lorcana sealed products such as booster packs, troves, gift sets, and starter decks",
        ),
      });

      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "AttachComponentToBlueprint",
        componentId: components["lorcana-sealed-product-identity"],
      });

      await sendSeedCommand(services.blueprints.commandHandler, streamId, {
        type: "SetBlueprintFields",
        fieldRules: [
          { fieldId: fields.set, required: true },
          { fieldId: fields["sealed-product-form"], required: true },
          { fieldId: fields["pack-count"], required: false },
          { fieldId: fields["release-year"], required: false },
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
    }

    result["lorcana-sealed-product"] = blueprintId;
  }

  return result;
}

async function blueprintExists(services: CatalogServices, blueprintId: BlueprintId, key: string): Promise<boolean> {
  const existing = await services.db.query<{ blueprint_id: string; key: string; status: string }>(
    `SELECT blueprint_id, key, status
     FROM catalog_blueprints
     WHERE blueprint_id = $1 OR key = $2`,
    [blueprintId, key],
  );
  const row = existing.rows.find((candidate) => candidate.blueprint_id === blueprintId);
  if (existing.rows.length === 0) {
    return false;
  }
  if (!row || row.key !== key || existing.rows.length > 1) {
    throw new Error(`Catalog integration bootstrap blueprint '${key}' conflicts with existing metadata.`);
  }
  if (row.status !== "active") {
    throw new Error(`Catalog integration bootstrap requires active blueprint '${key}'.`);
  }
  return true;
}
