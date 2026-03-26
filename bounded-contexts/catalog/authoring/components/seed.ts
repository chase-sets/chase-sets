import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogServices } from "../services";
import type { ComponentId } from "../../ids";
import { sendSeedCommand } from "../seed-support";
import type { DimensionIds } from "../dimensions/seed";
import type { FieldIds } from "../fields/seed";

export type ComponentIds = Record<string, ComponentId>;

export async function seedComponents(
  services: CatalogServices,
  dimensions: DimensionIds,
  fields: FieldIds,
): Promise<ComponentIds> {
  console.log("Seeding components...");
  const result: ComponentIds = {};

  {
    const componentId = createId("cmp") as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    await sendSeedCommand(services.componentHandler, streamId, {
      type: "CreateComponent",
      componentId,
      key: "base-card-info",
      name: "Base Card Info",
      description: "Core card identification fields and dimensions",
    });

    for (const [fieldKey, required] of [
      ["card-number", true],
      ["card-name", true],
      ["artist", false],
      ["year-printed", false],
    ] as const) {
      await sendSeedCommand(services.componentHandler, streamId, {
        type: "AddFieldRuleToComponent",
        fieldId: fields[fieldKey],
        required,
      });
    }

    for (const dimKey of ["pokemon-set", "rarity", "language"] as const) {
      const dim = dimensions[dimKey];
      await sendSeedCommand(services.componentHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: dim.dimensionId,
        required: true,
        allowedChoiceIds: Object.values(dim.choiceIds),
      });
    }

    await sendSeedCommand(services.componentHandler, streamId, {
      type: "ActivateComponent",
    });

    result["base-card-info"] = componentId;
    console.log('  Component "Base Card Info" created');
  }

  {
    const componentId = createId("cmp") as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    await sendSeedCommand(services.componentHandler, streamId, {
      type: "CreateComponent",
      componentId,
      key: "card-condition",
      name: "Card Condition",
      description: "Physical condition assessment for raw cards",
    });

    const dim = dimensions.condition;
    await sendSeedCommand(services.componentHandler, streamId, {
      type: "AddDimensionRuleToComponent",
      dimensionId: dim.dimensionId,
      required: true,
      allowedChoiceIds: Object.values(dim.choiceIds),
    });

    await sendSeedCommand(services.componentHandler, streamId, {
      type: "ActivateComponent",
    });

    result["card-condition"] = componentId;
    console.log('  Component "Card Condition" created');
  }

  {
    const componentId = createId("cmp") as ComponentId;
    const streamId = `catalog.component-${componentId}`;

    await sendSeedCommand(services.componentHandler, streamId, {
      type: "CreateComponent",
      componentId,
      key: "card-grading",
      name: "Card Grading",
      description: "Professional grading information for graded cards",
    });

    for (const [fieldKey, required] of [
      ["cert-number", false],
      ["pop-count", false],
    ] as const) {
      await sendSeedCommand(services.componentHandler, streamId, {
        type: "AddFieldRuleToComponent",
        fieldId: fields[fieldKey],
        required,
      });
    }

    for (const dimKey of ["grading-company", "grade"] as const) {
      const dim = dimensions[dimKey];
      await sendSeedCommand(services.componentHandler, streamId, {
        type: "AddDimensionRuleToComponent",
        dimensionId: dim.dimensionId,
        required: true,
        allowedChoiceIds: Object.values(dim.choiceIds),
      });
    }

    await sendSeedCommand(services.componentHandler, streamId, {
      type: "ActivateComponent",
    });

    result["card-grading"] = componentId;
    console.log('  Component "Card Grading" created');
  }

  return result;
}



