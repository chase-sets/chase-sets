import { catalogSeedIds } from "../../../support/seed-support/ids";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { ComponentId } from "../../../ids";
import { sendSeedCommand } from "../../../support/seed-support/context";
import type { DimensionIds } from "../../dimensions/api/seed";
import type { FieldIds } from "../../fields/api/seed";

export type ComponentIds = Record<string, ComponentId>;

export async function seedComponents(
  services: CatalogServices,
  dimensions: DimensionIds,
  fields: FieldIds,
): Promise<ComponentIds> {
  console.log("Seeding components...");
  const result: ComponentIds = {};

  {
    const componentId = catalogSeedIds.components.singleCardIdentity as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    await sendSeedCommand(services.components.commandHandler, streamId, {
      type: "CreateComponent",
      componentId,
      key: "single-card-identity",
      name: "Single Card Identity",
      description: "Descriptive fields for a specific printed Pokemon card",
    });

    for (const [fieldKey, required] of [
      ["card-number", true],
      ["card-name", true],
      ["set-name", true],
      ["rarity", true],
      ["language", true],
      ["artist", false],
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

    result["single-card-identity"] = componentId;
    console.log('  Component "Single Card Identity" created');
  }

  {
    const componentId = catalogSeedIds.components.singleCardVersioning as ComponentId;
    const streamId = `catalog.component-${componentId}`;
    const formDimension = dimensions.form;

    await sendSeedCommand(services.components.commandHandler, streamId, {
      type: "CreateComponent",
      componentId,
      key: "single-card-versioning",
      name: "Single Card Versioning",
      description: "Version-forming rules for raw and graded card variants",
    });

    await sendSeedCommand(services.components.commandHandler, streamId, {
      type: "AddDimensionRuleToComponent",
      dimensionId: formDimension.dimensionId,
      required: true,
      allowedChoiceIds: Object.values(formDimension.choiceIds),
    });

    await sendSeedCommand(services.components.commandHandler, streamId, {
      type: "AddDimensionRuleToComponent",
      dimensionId: dimensions.condition.dimensionId,
      required: true,
      allowedChoiceIds: Object.values(dimensions.condition.choiceIds),
      appliesWhen: [
        {
          dimensionId: formDimension.dimensionId,
          choiceIds: [formDimension.choiceIds.raw],
        },
      ],
    });

    for (const dimKey of ["grading-company", "grade"] as const) {
      const dimension = dimensions[dimKey];
      await sendSeedCommand(services.components.commandHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: dimension.dimensionId,
        required: true,
        allowedChoiceIds: Object.values(dimension.choiceIds),
        appliesWhen: [
          {
            dimensionId: formDimension.dimensionId,
            choiceIds: [formDimension.choiceIds.graded],
          },
        ],
      });
    }

    await sendSeedCommand(services.components.commandHandler, streamId, {
      type: "ActivateComponent",
    });

    result["single-card-versioning"] = componentId;
    console.log('  Component "Single Card Versioning" created');
  }

  {
    const componentId = catalogSeedIds.components.sealedProductIdentity as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    await sendSeedCommand(services.components.commandHandler, streamId, {
      type: "CreateComponent",
      componentId,
      key: "sealed-product-identity",
      name: "Sealed Product Identity",
      description: "Descriptive fields for Pokemon sealed products",
    });

    for (const [fieldKey, required] of [
      ["set-name", true],
      ["language", true],
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

    result["sealed-product-identity"] = componentId;
    console.log('  Component "Sealed Product Identity" created');
  }

  return result;
}


