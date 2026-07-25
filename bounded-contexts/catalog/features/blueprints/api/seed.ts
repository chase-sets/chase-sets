import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import type { BlueprintId } from "../../../ids";
import { sendSeedCommand as sendRawSeedCommand } from "../../../support/seed-support/context";
import { loadSeedAggregateState } from "../../../support/seed-support/aggregate-state";
import type { ComponentIds } from "../../components/api/seed";
import type { DimensionIds } from "../../dimensions/api/seed";
import type { FieldIds } from "../../fields/api/seed";
import {
  decideBlueprint,
  evolveBlueprint,
  initialBlueprintState,
  type BlueprintCommand,
  type BlueprintDimensionRule,
  type BlueprintEvent,
  type BlueprintFieldRule,
  type BlueprintState,
} from "../domain/domain";

export type BlueprintIds = Record<string, BlueprintId>;

const blueprintSeedIdentities = [
  [catalogSeedIds.blueprints.pokemonCardSingle, "pokemon-card-single"],
  [catalogSeedIds.blueprints.pokemonSealedProduct, "pokemon-sealed-product"],
  [catalogSeedIds.blueprints.magicCardPrint, "magic-card-print"],
  [catalogSeedIds.blueprints.magicSealedProduct, "magic-sealed-product"],
  [catalogSeedIds.blueprints.onePieceCardPrint, "one-piece-card-print"],
  [catalogSeedIds.blueprints.onePieceSealedProduct, "one-piece-sealed-product"],
  [catalogSeedIds.blueprints.lorcanaCardPrint, "lorcana-card-print"],
  [catalogSeedIds.blueprints.lorcanaSealedProduct, "lorcana-sealed-product"],
] as const;

export const blueprintSeedRequirements = blueprintSeedIdentities.map(([id, key]) => ({
  aggregateName: "Blueprint",
  id: id as BlueprintId,
  key,
  streamId: `catalog.blueprint-${id}`,
})) as readonly Readonly<{ aggregateName: "Blueprint"; id: BlueprintId; key: string; streamId: string }>[];

type BlueprintSeedRuntime = Readonly<{
  services: CatalogServices;
  states: Map<string, BlueprintState>;
}>;

const blueprintSeedRuntimeByHandler = new WeakMap<
  CatalogServices["blueprints"]["commandHandler"],
  BlueprintSeedRuntime
>();

export async function seedBlueprints(
  services: CatalogServices,
  components: ComponentIds,
  dimensions: DimensionIds,
  fields: FieldIds,
): Promise<BlueprintIds> {
  registerBlueprintSeedServices(services);
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
    const blueprintId = catalogSeedIds.blueprints.pokemonSealedProduct as BlueprintId;
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

  Object.assign(
    result,
    await seedMagicBlueprints(services, components, dimensions, fields, { reconcileExisting: false }),
  );
  Object.assign(
    result,
    await seedOnePieceBlueprints(services, components, dimensions, fields, { reconcileExisting: false }),
  );
  Object.assign(
    result,
    await seedLorcanaBlueprints(services, components, dimensions, fields, { reconcileExisting: false }),
  );

  return result;
}

export async function seedMagicBlueprints(
  services: CatalogServices,
  components: ComponentIds,
  dimensions: DimensionIds,
  fields: FieldIds,
  options: Readonly<{ reconcileExisting?: boolean }> = { reconcileExisting: true },
): Promise<BlueprintIds> {
  registerBlueprintSeedServices(services);
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
  registerBlueprintSeedServices(services);
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
  registerBlueprintSeedServices(services);
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
  const aggregate = await loadBlueprintSeedState(services, blueprintId, key);
  return aggregate.kind === "active";
}

function registerBlueprintSeedServices(services: CatalogServices): void {
  blueprintSeedRuntimeByHandler.set(services.blueprints.commandHandler, {
    services,
    states: new Map(),
  });
}

async function sendSeedCommand(
  handler: CatalogServices["blueprints"]["commandHandler"],
  streamId: string,
  command: BlueprintCommand,
): Promise<void> {
  const runtime = blueprintSeedRuntimeByHandler.get(handler);
  if (!runtime) {
    throw new Error("Catalog Blueprint seed command handler was not registered.");
  }
  const identity = blueprintSeedIdentities.find(([id]) => streamId === `catalog.blueprint-${id}`);
  if (!identity) {
    throw new Error(`Unknown Catalog integration Blueprint stream '${streamId}'.`);
  }
  const [blueprintId, key] = identity;
  const persisted = runtime.states.has(streamId)
    ? undefined
    : await loadBlueprintSeedState(runtime.services, blueprintId as BlueprintId, key);
  const state = runtime.states.get(streamId) ?? persisted?.state ?? initialBlueprintState;
  const kind = persisted?.kind ?? (state.id === null ? "absent" : state.status === "active" ? "active" : "draft");

  if (kind === "active") {
    return;
  }
  if (command.type === "CreateBlueprint") {
    if (kind === "draft") {
      return;
    }
  } else if (kind === "absent") {
    throw new Error(`Catalog integration bootstrap Blueprint '${key}' must be created before '${command.type}'.`);
  }

  if (command.type === "AttachComponentToBlueprint" && state.componentIds.includes(command.componentId)) {
    return;
  }
  if (command.type === "SetBlueprintFields" && sameFieldRules(state.fieldRules, command.fieldRules)) {
    return;
  }
  if (command.type === "SetBlueprintDimensions" && sameDimensionRules(state.dimensionRules, command.dimensionRules)) {
    return;
  }
  if (
    command.type === "SetBlueprintProductResolutionRules" &&
    sameOrderedStrings(state.canonicalDimensionOrder, command.canonicalDimensionOrder)
  ) {
    return;
  }

  await sendRawSeedCommand(handler, streamId, command);
  const nextState = decideBlueprint(state, command).reduce(evolveBlueprint, state);
  runtime.states.set(streamId, nextState);
}

function loadBlueprintSeedState(services: CatalogServices, blueprintId: BlueprintId, key: string) {
  return loadSeedAggregateState<typeof initialBlueprintState, BlueprintEvent>({
    db: services.db,
    aggregateName: "Blueprint",
    streamId: `catalog.blueprint-${blueprintId}`,
    createdEventType: "catalog.blueprint.created",
    createdIdField: "blueprintId",
    expectedId: blueprintId,
    expectedKey: key,
    initialState: initialBlueprintState,
    evolve: evolveBlueprint,
  });
}

function sameFieldRules(left: readonly BlueprintFieldRule[], right: readonly BlueprintFieldRule[]): boolean {
  const normalize = (rules: readonly BlueprintFieldRule[]) =>
    rules
      .map((rule) => `${rule.fieldId}:${rule.required}`)
      .sort()
      .join("\u0000");
  return normalize(left) === normalize(right);
}

function sameDimensionRules(
  left: readonly BlueprintDimensionRule[],
  right: readonly BlueprintDimensionRule[],
): boolean {
  const normalize = (rules: readonly BlueprintDimensionRule[]) =>
    rules
      .map((rule) => ({
        dimensionId: rule.dimensionId,
        required: rule.required,
        allowedOptionIds: [...rule.allowedOptionIds].sort(),
        appliesWhen: [...(rule.appliesWhen ?? [])]
          .map((clause) => ({
            dimensionId: clause.dimensionId,
            optionIds: [...clause.optionIds].sort(),
          }))
          .sort((a, b) => a.dimensionId.localeCompare(b.dimensionId)),
      }))
      .sort((a, b) => a.dimensionId.localeCompare(b.dimensionId));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
