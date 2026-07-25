import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { ComponentId } from "../../../ids";
import { sendSeedCommand as sendRawSeedCommand } from "../../../support/seed-support/context";
import { loadSeedAggregateState } from "../../../support/seed-support/aggregate-state";
import type { DimensionIds } from "../../dimensions/api/seed";
import type { FieldIds } from "../../fields/api/seed";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import {
  decideComponent,
  evolveComponent,
  initialComponentState,
  type ComponentCommand,
  type ComponentEvent,
  type ComponentState,
} from "../domain/domain";

export type ComponentIds = Record<string, ComponentId>;

const componentSeedIdentities = [
  [catalogSeedIds.components.singleCardIdentity, "single-card-identity"],
  [catalogSeedIds.components.singleCardProductResolution, "single-card-product-resolution"],
  [catalogSeedIds.components.sealedProductIdentity, "sealed-product-identity"],
  [catalogSeedIds.components.magicCardPrintIdentity, "magic-card-print-identity"],
  [catalogSeedIds.components.magicCardProductResolution, "magic-card-product-resolution"],
  [catalogSeedIds.components.magicSealedProductIdentity, "magic-sealed-product-identity"],
  [catalogSeedIds.components.onePieceCardPrintIdentity, "one-piece-card-print-identity"],
  [catalogSeedIds.components.onePieceCardProductResolution, "one-piece-card-product-resolution"],
  [catalogSeedIds.components.onePieceSealedProductIdentity, "one-piece-sealed-product-identity"],
  [catalogSeedIds.components.lorcanaCardPrintIdentity, "lorcana-card-print-identity"],
  [catalogSeedIds.components.lorcanaCardProductResolution, "lorcana-card-product-resolution"],
  [catalogSeedIds.components.lorcanaSealedProductIdentity, "lorcana-sealed-product-identity"],
] as const;

export const componentSeedRequirements = componentSeedIdentities.map(([id, key]) => ({
  aggregateName: "Component",
  id: id as ComponentId,
  key,
  streamId: `catalog.component-${id}`,
})) as readonly Readonly<{ aggregateName: "Component"; id: ComponentId; key: string; streamId: string }>[];

type ComponentSeedRuntime = Readonly<{
  services: CatalogServices;
  states: Map<string, ComponentState>;
}>;

const componentSeedRuntimeByHandler = new WeakMap<
  CatalogServices["components"]["commandHandler"],
  ComponentSeedRuntime
>();

export async function seedComponents(
  services: CatalogServices,
  dimensions: DimensionIds,
  fields: FieldIds,
): Promise<ComponentIds> {
  registerComponentSeedServices(services);
  console.log("Seeding components...");
  const result: ComponentIds = {};

  {
    const componentId = catalogSeedIds.components.singleCardIdentity as ComponentId;
    const streamId = `catalog.component-${componentId}`;

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

    result["single-card-identity"] = componentId;
    console.log('  Component "Single Card Identity" created');
  }

  {
    const componentId = catalogSeedIds.components.singleCardProductResolution as ComponentId;
    const streamId = `catalog.component-${componentId}`;
    const formDimension = dimensions.form;

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

    result["single-card-product-resolution"] = componentId;
    console.log('  Component "Single Card Product Resolution" created');
  }

  {
    const componentId = catalogSeedIds.components.sealedProductIdentity as ComponentId;
    const streamId = `catalog.component-${componentId}`;

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

    result["sealed-product-identity"] = componentId;
    console.log('  Component "Sealed Product Identity" created');
  }

  Object.assign(result, await seedMagicComponents(services, dimensions, fields, { reconcileExisting: false }));
  Object.assign(result, await seedOnePieceComponents(services, dimensions, fields, { reconcileExisting: false }));
  Object.assign(result, await seedLorcanaComponents(services, dimensions, fields, { reconcileExisting: false }));

  return result;
}

export async function seedMagicComponents(
  services: CatalogServices,
  dimensions: DimensionIds,
  fields: FieldIds,
  options: Readonly<{ reconcileExisting?: boolean }> = { reconcileExisting: true },
): Promise<ComponentIds> {
  registerComponentSeedServices(services);
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
  registerComponentSeedServices(services);
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
  registerComponentSeedServices(services);
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
  const aggregate = await loadComponentSeedState(services, componentId, key);
  return aggregate.kind === "active";
}

function registerComponentSeedServices(services: CatalogServices): void {
  componentSeedRuntimeByHandler.set(services.components.commandHandler, {
    services,
    states: new Map(),
  });
}

async function sendSeedCommand(
  handler: CatalogServices["components"]["commandHandler"],
  streamId: string,
  command: ComponentCommand,
): Promise<void> {
  const runtime = componentSeedRuntimeByHandler.get(handler);
  if (!runtime) {
    throw new Error("Catalog Component seed command handler was not registered.");
  }
  const identity = componentSeedIdentities.find(([id]) => streamId === `catalog.component-${id}`);
  if (!identity) {
    throw new Error(`Unknown Catalog integration Component stream '${streamId}'.`);
  }
  const [componentId, key] = identity;
  const persisted = runtime.states.has(streamId)
    ? undefined
    : await loadComponentSeedState(runtime.services, componentId as ComponentId, key);
  const state = runtime.states.get(streamId) ?? persisted?.state ?? initialComponentState;
  const kind = persisted?.kind ?? (state.id === null ? "absent" : state.status === "active" ? "active" : "draft");

  if (kind === "active") {
    return;
  }
  if (command.type === "CreateComponent") {
    if (kind === "draft") {
      return;
    }
  } else if (kind === "absent") {
    throw new Error(`Catalog integration bootstrap Component '${key}' must be created before '${command.type}'.`);
  }

  if (command.type === "AddFieldRuleToComponent") {
    const existing = state.fieldRules.find((rule) => rule.fieldId === command.fieldId);
    if (existing?.required === command.required) {
      return;
    }
    if (existing) {
      throw new Error(
        `Catalog integration bootstrap Component '${key}' expected Field rule '${command.fieldId}' required=${command.required}, but found required=${existing.required}.`,
      );
    }
  }
  if (command.type === "AddDimensionRuleToComponent") {
    const existing = state.dimensionRules.find((rule) => rule.dimensionId === command.dimensionId);
    if (existing) {
      if (
        existing.required === command.required &&
        sameStrings(existing.allowedOptionIds, command.allowedOptionIds ?? []) &&
        sameApplicability(existing.appliesWhen ?? [], command.appliesWhen ?? [])
      ) {
        return;
      }
      throw new Error(
        `Catalog integration bootstrap Component '${key}' found conflicting Dimension rule '${command.dimensionId}'.`,
      );
    }
  }

  await sendRawSeedCommand(handler, streamId, command);
  const nextState = decideComponent(state, command).reduce(evolveComponent, state);
  runtime.states.set(streamId, nextState);
}

function loadComponentSeedState(services: CatalogServices, componentId: ComponentId, key: string) {
  return loadSeedAggregateState<typeof initialComponentState, ComponentEvent>({
    db: services.db,
    aggregateName: "Component",
    streamId: `catalog.component-${componentId}`,
    createdEventType: "catalog.component.created",
    createdIdField: "componentId",
    expectedId: componentId,
    expectedKey: key,
    initialState: initialComponentState,
    evolve: evolveComponent,
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
}

function sameApplicability(
  left: readonly Readonly<{ dimensionId: string; optionIds: readonly string[] }>[],
  right: readonly Readonly<{ dimensionId: string; optionIds: readonly string[] }>[],
): boolean {
  const normalize = (clauses: readonly Readonly<{ dimensionId: string; optionIds: readonly string[] }>[]) =>
    clauses
      .map((clause) => `${clause.dimensionId}:${[...clause.optionIds].sort().join(",")}`)
      .sort()
      .join("\u0000");
  return normalize(left) === normalize(right);
}
