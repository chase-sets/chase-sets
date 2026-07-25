import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { ComponentId } from "../../../ids";
import { sendSeedCommand } from "../../../support/seed-support/context";
import type { DimensionIds } from "../../dimensions/api/seed";
import type { FieldIds } from "../../fields/api/seed";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";

export type ComponentIds = Record<string, ComponentId>;

export async function seedComponents(
  services: CatalogServices,
  dimensions: DimensionIds,
  fields: FieldIds,
  options: Readonly<{ reconcileExisting?: boolean }> = {},
): Promise<ComponentIds> {
  console.log("Seeding components...");
  const result: ComponentIds = {};

  {
    const componentId = catalogSeedIds.components.singleCardIdentity as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    if (!(options.reconcileExisting && (await componentExists(services, componentId, "single-card-identity")))) {
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "CreateComponent",
        componentId,
        key: "single-card-identity",
        name: localizedTextMapFromEnglish("Single Card Identity"),
        description: localizedTextMapFromEnglish("Descriptive fields for a specific printed Pokemon card"),
      });

      for (const [fieldKey, required] of [
        ["card-number", true],
        ["card-name", true],
        ["expansion", true],
        ["rarity", true],
        ["card-illustrator", false],
        ["release-year", false],
      ] as const) {
        await sendSeedCommand(services.components.commandHandler, streamId, {
          type: "AddFieldRuleToComponent",
          fieldId: fields[fieldKey],
          required,
        });
      }

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "ActivateComponent",
      });
    }

    result["single-card-identity"] = componentId;
    console.log('  Component "Single Card Identity" created');
  }

  {
    const componentId = catalogSeedIds.components.singleCardProductResolution as ComponentId;
    const streamId = `catalog.component-${componentId}`;
    const formDimension = dimensions.form;

    if (
      !(options.reconcileExisting && (await componentExists(services, componentId, "single-card-product-resolution")))
    ) {
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "CreateComponent",
        componentId,
        key: "single-card-product-resolution",
        name: localizedTextMapFromEnglish("Single Card Product Resolution"),
        description: localizedTextMapFromEnglish("Product-resolution rules for raw and graded card variants"),
      });

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: formDimension.dimensionId,
        required: true,
        allowedOptionIds: formDimension.orderedOptionIds,
      });

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: dimensions.condition.dimensionId,
        required: true,
        allowedOptionIds: dimensions.condition.orderedOptionIds,
        appliesWhen: [
          {
            dimensionId: formDimension.dimensionId,
            optionIds: [formDimension.optionIds.raw],
          },
        ],
      });

      for (const dimKey of ["grading-company", "grade"] as const) {
        const dimension = dimensions[dimKey];
        await sendSeedCommand(services.components.commandHandler, streamId, {
          type: "AddDimensionRuleToComponent",
          dimensionId: dimension.dimensionId,
          required: true,
          allowedOptionIds: dimension.orderedOptionIds,
          appliesWhen: [
            {
              dimensionId: formDimension.dimensionId,
              optionIds: [formDimension.optionIds.graded],
            },
          ],
        });
      }

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "ActivateComponent",
      });
    }

    result["single-card-product-resolution"] = componentId;
    console.log('  Component "Single Card Product Resolution" created');
  }

  {
    const componentId = catalogSeedIds.components.sealedProductIdentity as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    if (!(options.reconcileExisting && (await componentExists(services, componentId, "sealed-product-identity")))) {
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "CreateComponent",
        componentId,
        key: "sealed-product-identity",
        name: localizedTextMapFromEnglish("Sealed Product Identity"),
        description: localizedTextMapFromEnglish("Descriptive fields for Pokemon sealed products"),
      });

      for (const [fieldKey, required] of [
        ["expansion", true],
        ["release-year", false],
        ["pack-count", true],
      ] as const) {
        await sendSeedCommand(services.components.commandHandler, streamId, {
          type: "AddFieldRuleToComponent",
          fieldId: fields[fieldKey],
          required,
        });
      }

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "ActivateComponent",
      });
    }

    result["sealed-product-identity"] = componentId;
    console.log('  Component "Sealed Product Identity" created');
  }

  Object.assign(result, await seedMagicComponents(services, dimensions, fields, options));
  Object.assign(result, await seedOnePieceComponents(services, dimensions, fields, options));
  Object.assign(result, await seedLorcanaComponents(services, dimensions, fields, options));

  return result;
}

export async function seedMagicComponents(
  services: CatalogServices,
  dimensions: DimensionIds,
  fields: FieldIds,
  options: Readonly<{ reconcileExisting?: boolean }> = { reconcileExisting: true },
): Promise<ComponentIds> {
  const result: ComponentIds = {};

  {
    const componentId = catalogSeedIds.components.magicCardPrintIdentity as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    if (!(options.reconcileExisting && (await componentExists(services, componentId, "magic-card-print-identity")))) {
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "CreateComponent",
        componentId,
        key: "magic-card-print-identity",
        name: localizedTextMapFromEnglish("Magic Card Print Identity"),
        description: localizedTextMapFromEnglish("Descriptive fields for a specific printed Magic card"),
      });

      for (const [fieldKey, required] of [
        ["card-number", true],
        ["card-name", true],
        ["set", true],
        ["rarity", false],
        ["card-variant", false],
        ["card-illustrator", false],
        ["release-year", false],
      ] as const) {
        await sendSeedCommand(services.components.commandHandler, streamId, {
          type: "AddFieldRuleToComponent",
          fieldId: fields[fieldKey],
          required,
        });
      }

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "ActivateComponent",
      });
    }

    result["magic-card-print-identity"] = componentId;
  }

  {
    const componentId = catalogSeedIds.components.magicCardProductResolution as ComponentId;
    const streamId = `catalog.component-${componentId}`;
    const formDimension = dimensions.form;

    if (
      !(options.reconcileExisting && (await componentExists(services, componentId, "magic-card-product-resolution")))
    ) {
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "CreateComponent",
        componentId,
        key: "magic-card-product-resolution",
        name: localizedTextMapFromEnglish("Magic Card Product Resolution"),
        description: localizedTextMapFromEnglish("Product-resolution rules for raw and graded Magic card variants"),
      });

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: formDimension.dimensionId,
        required: true,
        allowedOptionIds: formDimension.orderedOptionIds,
      });

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: dimensions.condition.dimensionId,
        required: true,
        allowedOptionIds: dimensions.condition.orderedOptionIds,
        appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.raw] }],
      });

      for (const dimKey of ["grading-company", "grade"] as const) {
        const dimension = dimensions[dimKey];
        await sendSeedCommand(services.components.commandHandler, streamId, {
          type: "AddDimensionRuleToComponent",
          dimensionId: dimension.dimensionId,
          required: true,
          allowedOptionIds: dimension.orderedOptionIds,
          appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.graded] }],
        });
      }

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "ActivateComponent",
      });
    }

    result["magic-card-product-resolution"] = componentId;
  }

  {
    const componentId = catalogSeedIds.components.magicSealedProductIdentity as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    if (
      !(options.reconcileExisting && (await componentExists(services, componentId, "magic-sealed-product-identity")))
    ) {
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "CreateComponent",
        componentId,
        key: "magic-sealed-product-identity",
        name: localizedTextMapFromEnglish("Magic Sealed Product Identity"),
        description: localizedTextMapFromEnglish("Descriptive fields for Magic sealed products"),
      });

      for (const [fieldKey, required] of [
        ["set", true],
        ["release-year", false],
        ["pack-count", true],
      ] as const) {
        await sendSeedCommand(services.components.commandHandler, streamId, {
          type: "AddFieldRuleToComponent",
          fieldId: fields[fieldKey],
          required,
        });
      }

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "ActivateComponent",
      });
    }

    result["magic-sealed-product-identity"] = componentId;
  }

  return result;
}

export async function seedOnePieceComponents(
  services: CatalogServices,
  dimensions: DimensionIds,
  fields: FieldIds,
  options: Readonly<{ reconcileExisting?: boolean }> = { reconcileExisting: true },
): Promise<ComponentIds> {
  const result: ComponentIds = {};

  {
    const componentId = catalogSeedIds.components.onePieceCardPrintIdentity as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    if (
      !(options.reconcileExisting && (await componentExists(services, componentId, "one-piece-card-print-identity")))
    ) {
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "CreateComponent",
        componentId,
        key: "one-piece-card-print-identity",
        name: localizedTextMapFromEnglish("One Piece Card Print Identity"),
        description: localizedTextMapFromEnglish("Descriptive fields for a specific printed One Piece card"),
      });

      for (const [fieldKey, required] of [
        ["card-number", true],
        ["card-name", true],
        ["set", true],
        ["rarity", false],
        ["card-variant", false],
        ["release-year", false],
      ] as const) {
        await sendSeedCommand(services.components.commandHandler, streamId, {
          type: "AddFieldRuleToComponent",
          fieldId: fields[fieldKey],
          required,
        });
      }

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "ActivateComponent",
      });
    }

    result["one-piece-card-print-identity"] = componentId;
  }

  {
    const componentId = catalogSeedIds.components.onePieceCardProductResolution as ComponentId;
    const streamId = `catalog.component-${componentId}`;
    const formDimension = dimensions.form;

    if (
      !(
        options.reconcileExisting && (await componentExists(services, componentId, "one-piece-card-product-resolution"))
      )
    ) {
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "CreateComponent",
        componentId,
        key: "one-piece-card-product-resolution",
        name: localizedTextMapFromEnglish("One Piece Card Product Resolution"),
        description: localizedTextMapFromEnglish("Product-resolution rules for raw and graded One Piece card variants"),
      });

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: formDimension.dimensionId,
        required: true,
        allowedOptionIds: formDimension.orderedOptionIds,
      });

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: dimensions.condition.dimensionId,
        required: true,
        allowedOptionIds: dimensions.condition.orderedOptionIds,
        appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.raw] }],
      });

      for (const dimKey of ["grading-company", "grade"] as const) {
        const dimension = dimensions[dimKey];
        await sendSeedCommand(services.components.commandHandler, streamId, {
          type: "AddDimensionRuleToComponent",
          dimensionId: dimension.dimensionId,
          required: true,
          allowedOptionIds: dimension.orderedOptionIds,
          appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.graded] }],
        });
      }

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "ActivateComponent",
      });
    }

    result["one-piece-card-product-resolution"] = componentId;
  }

  {
    const componentId = catalogSeedIds.components.onePieceSealedProductIdentity as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    if (
      !(
        options.reconcileExisting && (await componentExists(services, componentId, "one-piece-sealed-product-identity"))
      )
    ) {
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "CreateComponent",
        componentId,
        key: "one-piece-sealed-product-identity",
        name: localizedTextMapFromEnglish("One Piece Sealed Product Identity"),
        description: localizedTextMapFromEnglish("Descriptive fields for One Piece sealed products"),
      });

      for (const [fieldKey, required] of [
        ["set", true],
        ["release-year", false],
        ["pack-count", true],
      ] as const) {
        await sendSeedCommand(services.components.commandHandler, streamId, {
          type: "AddFieldRuleToComponent",
          fieldId: fields[fieldKey],
          required,
        });
      }

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "ActivateComponent",
      });
    }

    result["one-piece-sealed-product-identity"] = componentId;
  }

  return result;
}

export async function seedLorcanaComponents(
  services: CatalogServices,
  dimensions: DimensionIds,
  fields: FieldIds,
  options: Readonly<{ reconcileExisting?: boolean }> = { reconcileExisting: true },
): Promise<ComponentIds> {
  const result: ComponentIds = {};

  {
    const componentId = catalogSeedIds.components.lorcanaCardPrintIdentity as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    if (!(options.reconcileExisting && (await componentExists(services, componentId, "lorcana-card-print-identity")))) {
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "CreateComponent",
        componentId,
        key: "lorcana-card-print-identity",
        name: localizedTextMapFromEnglish("Lorcana Card Print Identity"),
        description: localizedTextMapFromEnglish("Descriptive fields for a specific printed Disney Lorcana card"),
      });

      for (const [fieldKey, required] of [
        ["card-number", true],
        ["card-name", true],
        ["set", true],
        ["rarity", false],
        ["card-variant", false],
        ["ink-color", false],
        ["card-type", false],
        ["card-classifications", false],
        ["card-properties", false],
        ["card-illustrator", false],
        ["release-year", false],
      ] as const) {
        await sendSeedCommand(services.components.commandHandler, streamId, {
          type: "AddFieldRuleToComponent",
          fieldId: fields[fieldKey],
          required,
        });
      }

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "ActivateComponent",
      });
    }

    result["lorcana-card-print-identity"] = componentId;
  }

  {
    const componentId = catalogSeedIds.components.lorcanaCardProductResolution as ComponentId;
    const streamId = `catalog.component-${componentId}`;
    const formDimension = dimensions.form;

    if (
      !(options.reconcileExisting && (await componentExists(services, componentId, "lorcana-card-product-resolution")))
    ) {
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "CreateComponent",
        componentId,
        key: "lorcana-card-product-resolution",
        name: localizedTextMapFromEnglish("Lorcana Card Product Resolution"),
        description: localizedTextMapFromEnglish("Product-resolution rules for raw and graded Lorcana card variants"),
      });

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: formDimension.dimensionId,
        required: true,
        allowedOptionIds: formDimension.orderedOptionIds,
      });

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: dimensions.condition.dimensionId,
        required: true,
        allowedOptionIds: dimensions.condition.orderedOptionIds,
        appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.raw] }],
      });

      for (const dimKey of ["grading-company", "grade"] as const) {
        const dimension = dimensions[dimKey];
        await sendSeedCommand(services.components.commandHandler, streamId, {
          type: "AddDimensionRuleToComponent",
          dimensionId: dimension.dimensionId,
          required: true,
          allowedOptionIds: dimension.orderedOptionIds,
          appliesWhen: [{ dimensionId: formDimension.dimensionId, optionIds: [formDimension.optionIds.graded] }],
        });
      }

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "ActivateComponent",
      });
    }

    result["lorcana-card-product-resolution"] = componentId;
  }

  {
    const componentId = catalogSeedIds.components.lorcanaSealedProductIdentity as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    if (
      !(options.reconcileExisting && (await componentExists(services, componentId, "lorcana-sealed-product-identity")))
    ) {
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "CreateComponent",
        componentId,
        key: "lorcana-sealed-product-identity",
        name: localizedTextMapFromEnglish("Lorcana Sealed Product Identity"),
        description: localizedTextMapFromEnglish("Descriptive fields for Disney Lorcana sealed products"),
      });

      for (const [fieldKey, required] of [
        ["set", true],
        ["sealed-product-form", true],
        ["pack-count", false],
        ["release-year", false],
      ] as const) {
        await sendSeedCommand(services.components.commandHandler, streamId, {
          type: "AddFieldRuleToComponent",
          fieldId: fields[fieldKey],
          required,
        });
      }

      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "ActivateComponent",
      });
    }

    result["lorcana-sealed-product-identity"] = componentId;
  }

  return result;
}

async function componentExists(services: CatalogServices, componentId: ComponentId, key: string): Promise<boolean> {
  const existing = await services.db.query<{ component_id: string; key: string; status: string }>(
    `SELECT component_id, key, status
     FROM catalog_components
     WHERE component_id = $1 OR key = $2`,
    [componentId, key],
  );
  const row = existing.rows.find((candidate) => candidate.component_id === componentId);
  if (existing.rows.length === 0) {
    return false;
  }
  if (!row || row.key !== key || existing.rows.length > 1) {
    throw new Error(`Catalog integration bootstrap component '${key}' conflicts with existing metadata.`);
  }
  if (row.status !== "active") {
    throw new Error(`Catalog integration bootstrap requires active component '${key}'.`);
  }
  return true;
}
