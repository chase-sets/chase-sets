import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { seedContext } from "../../../support/seed-support/context";
import { loadSeedAggregateState } from "../../../support/seed-support/aggregate-state";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { enqueueAllCatalogItemDisplayIdentityRecomputeWork } from "../../catalog-items/read-model/display-identity-recompute";
import {
  deriveRequiredFieldKeys,
  evolveDisplayTemplate,
  initialDisplayTemplateState,
  type DisplayTemplateEvent,
  type DisplayTemplateState,
} from "../domain/domain";

const displayTemplateSeedDefinitions = [
  {
    displayTemplateId: catalogSeedIds.displayTemplates.pokemonSingleCardDefault,
    key: "pokemon-single-card-default",
    name: "Pokemon single card",
    target: { kind: "blueprint" as const, id: catalogSeedIds.blueprints.pokemonCardSingle },
    priority: 10,
    titleTemplate: "{field.card-name} {field.card-number}[/{reference.expansion.attributes.printed-card-count}]",
    subtitleTemplate: "{reference.expansion.name} [{field.card-variant} ]{field.rarity}",
  },
  {
    displayTemplateId: catalogSeedIds.displayTemplates.pokemonPromoCard,
    key: "pokemon-promo-card",
    name: "Pokemon promo card",
    target: {
      kind: "reference-record" as const,
      id: catalogSeedIds.referenceRecords.expansions.wizardsBlackStarPromos,
    },
    priority: 100,
    titleTemplate: "{field.card-name} {field.card-number}",
    subtitleTemplate: "{reference.expansion.name} [{field.card-variant} ]{field.rarity}",
  },
  {
    displayTemplateId: catalogSeedIds.displayTemplates.pokemonSealedProduct,
    key: "pokemon-sealed-product",
    name: "Pokemon sealed product",
    target: { kind: "blueprint" as const, id: catalogSeedIds.blueprints.pokemonSealedProduct },
    priority: 10,
    titleTemplate: "{item.title}",
    subtitleTemplate: "{reference.expansion.name} sealed product",
  },
  {
    displayTemplateId: catalogSeedIds.displayTemplates.magicCardPrintDefault,
    key: "magic-card-print-default",
    name: "Magic card print",
    target: { kind: "blueprint" as const, id: catalogSeedIds.blueprints.magicCardPrint },
    priority: 10,
    titleTemplate: "{field.card-name} {field.card-number}",
    subtitleTemplate: "{reference.set.name} [{field.card-variant} ]{field.rarity}",
  },
  {
    displayTemplateId: catalogSeedIds.displayTemplates.magicSealedProduct,
    key: "magic-sealed-product",
    name: "Magic sealed product",
    target: { kind: "blueprint" as const, id: catalogSeedIds.blueprints.magicSealedProduct },
    priority: 10,
    titleTemplate: "{item.title}",
    subtitleTemplate: "{reference.set.name} sealed product",
  },
  {
    displayTemplateId: catalogSeedIds.displayTemplates.onePieceCardPrintDefault,
    key: "one-piece-card-print-default",
    name: "One Piece card print",
    target: { kind: "blueprint" as const, id: catalogSeedIds.blueprints.onePieceCardPrint },
    priority: 10,
    titleTemplate: "{field.card-name} {field.card-number}",
    subtitleTemplate: "{reference.set.name} [{field.card-variant} ]{field.rarity}",
  },
  {
    displayTemplateId: catalogSeedIds.displayTemplates.onePieceSealedProduct,
    key: "one-piece-sealed-product",
    name: "One Piece sealed product",
    target: { kind: "blueprint" as const, id: catalogSeedIds.blueprints.onePieceSealedProduct },
    priority: 10,
    titleTemplate: "{item.title}",
    subtitleTemplate: "{reference.set.name} sealed product",
  },
  {
    displayTemplateId: catalogSeedIds.displayTemplates.lorcanaCardPrintDefault,
    key: "lorcana-card-print-default",
    name: "Lorcana card print",
    target: { kind: "blueprint" as const, id: catalogSeedIds.blueprints.lorcanaCardPrint },
    priority: 10,
    titleTemplate: "{field.card-name} {field.card-number}",
    subtitleTemplate: "{reference.set.name} [{field.card-variant} ]{field.ink-color} {field.rarity}",
  },
  {
    displayTemplateId: catalogSeedIds.displayTemplates.lorcanaSealedProduct,
    key: "lorcana-sealed-product",
    name: "Lorcana sealed product",
    target: { kind: "blueprint" as const, id: catalogSeedIds.blueprints.lorcanaSealedProduct },
    priority: 10,
    titleTemplate: "{item.title}",
    subtitleTemplate: "{reference.set.name} {field.sealed-product-form}",
  },
] as const;

export async function seedDisplayTemplates(services: CatalogServices): Promise<void> {
  const definitions = displayTemplateSeedDefinitions;

  let reconciled = 0;

  for (const definition of definitions) {
    const streamId = `catalog.display-template-${definition.displayTemplateId}`;
    const aggregate = await loadSeedAggregateState<typeof initialDisplayTemplateState, DisplayTemplateEvent>({
      db: services.db,
      aggregateName: "Display Template",
      streamId,
      createdEventType: "catalog.display-template.created",
      createdIdField: "displayTemplateId",
      expectedId: definition.displayTemplateId,
      expectedKey: definition.key,
      initialState: initialDisplayTemplateState,
      evolve: evolveDisplayTemplate,
    });
    const command = {
      key: definition.key,
      name: localizedTextMapFromEnglish(definition.name),
      description: localizedTextMapFromEnglish(""),
      target: definition.target,
      priority: definition.priority,
      titleTemplate: definition.titleTemplate,
      subtitleTemplate: definition.subtitleTemplate,
    };

    if (aggregate.kind === "absent") {
      await services.displayTemplates.commandHandler({
        streamId,
        command: {
          type: "CreateDisplayTemplate",
          displayTemplateId: definition.displayTemplateId,
          ...command,
        },
        context: seedContext,
      });
      await services.displayTemplates.commandHandler({
        streamId,
        command: { type: "PublishDisplayTemplate" },
        context: seedContext,
      });
      reconciled += 1;
      continue;
    }

    if (!seedDefinitionMatches(aggregate.state, definition)) {
      await services.displayTemplates.commandHandler({
        streamId,
        command: {
          type: "ReviseDisplayTemplate",
          ...command,
        },
        context: seedContext,
      });
      reconciled += 1;
    }

    if (aggregate.kind === "draft") {
      await services.displayTemplates.commandHandler({
        streamId,
        command: { type: "PublishDisplayTemplate" },
        context: seedContext,
      });
      reconciled += 1;
    }
  }

  if (reconciled > 0) {
    await enqueueAllCatalogItemDisplayIdentityRecomputeWork(services.db, "seed-template-reconciled");
  }
}

type ExistingSeedDisplayTemplateRow = Readonly<{
  display_template_id: string;
  key: string;
  target_kind: string;
  target_id: string | null;
  priority: number;
  title_template: string;
  subtitle_template: string | null;
  required_field_keys: unknown;
  status: string;
}>;

export async function areDisplayTemplateSeedProjectionsCurrent(db: CatalogServices["db"]): Promise<boolean> {
  const result = await db.query<ExistingSeedDisplayTemplateRow>(
    `SELECT display_template_id,
       key,
       target_kind,
       target_id,
       priority,
       title_template,
       subtitle_template,
       required_field_keys,
       status
     FROM catalog_display_templates
     WHERE display_template_id = ANY($1::text[])`,
    [displayTemplateSeedDefinitions.map(({ displayTemplateId }) => displayTemplateId)],
  );
  const existing = new Map(result.rows.map((row) => [row.display_template_id, row]));

  return displayTemplateSeedDefinitions.every((definition) => {
    const current = existing.get(definition.displayTemplateId);
    return current !== undefined && current.status === "active" && seedProjectionMatches(current, definition);
  });
}

function seedDefinitionMatches(
  current: DisplayTemplateState,
  definition: Readonly<{
    key: string;
    target: { kind: string; id?: string };
    priority: number;
    titleTemplate: string;
    subtitleTemplate: string | null;
  }>,
): boolean {
  return (
    current.key === definition.key &&
    current.target.kind === definition.target.kind &&
    (current.target.id ?? null) === (definition.target.kind === "global" ? null : (definition.target.id ?? null)) &&
    current.priority === definition.priority &&
    current.titleTemplate === definition.titleTemplate &&
    current.subtitleTemplate === definition.subtitleTemplate &&
    sortedStrings(current.requiredFieldKeys).join("\n") === derivedRequiredFieldKeys(definition).join("\n")
  );
}

function seedProjectionMatches(
  current: ExistingSeedDisplayTemplateRow,
  definition: Readonly<{
    key: string;
    target: { kind: string; id?: string };
    priority: number;
    titleTemplate: string;
    subtitleTemplate: string | null;
  }>,
): boolean {
  return (
    current.key === definition.key &&
    current.target_kind === definition.target.kind &&
    current.target_id === (definition.target.kind === "global" ? null : (definition.target.id ?? null)) &&
    current.priority === definition.priority &&
    current.title_template === definition.titleTemplate &&
    current.subtitle_template === definition.subtitleTemplate &&
    sortedStrings(current.required_field_keys).join("\n") === derivedRequiredFieldKeys(definition).join("\n")
  );
}

function derivedRequiredFieldKeys(
  definition: Readonly<{ titleTemplate: string; subtitleTemplate: string | null }>,
): string[] {
  return [...deriveRequiredFieldKeys(definition.titleTemplate, definition.subtitleTemplate)];
}

function sortedStrings(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter((entry): entry is string => typeof entry === "string").sort();
}
