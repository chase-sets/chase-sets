import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";
import { catalogSeedIds } from "../../../support/seed-support/ids";
import { seedContext } from "../../../support/seed-support/context";
import type { CatalogServices } from "../../../support/authoring-support";
import { enqueueAllCatalogItemDisplayIdentityRecomputeWork } from "../../catalog-items/read-model/display-identity-recompute";

export async function seedDisplayTemplates(services: CatalogServices): Promise<void> {
  const definitions = [
    {
      displayTemplateId: catalogSeedIds.displayTemplates.pokemonSingleCardDefault,
      key: "pokemon-single-card-default",
      name: "Pokemon single card",
      target: { kind: "blueprint" as const, id: catalogSeedIds.blueprints.pokemonCardSingle },
      priority: 10,
      titleTemplate: "{field.card-name} {field.card-number}/{reference.expansion.attributes.printed-card-count}",
      subtitleTemplate: "{reference.expansion.name} [{field.card-variant} ]{field.rarity}",
      requiredFieldKeys: ["card-name", "card-number", "expansion"],
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
      requiredFieldKeys: ["card-name", "card-number", "expansion"],
    },
    {
      displayTemplateId: catalogSeedIds.displayTemplates.pokemonSealedProduct,
      key: "pokemon-sealed-product",
      name: "Pokemon sealed product",
      target: { kind: "blueprint" as const, id: catalogSeedIds.blueprints.pokemonSealedProduct },
      priority: 10,
      titleTemplate: "{item.title}",
      subtitleTemplate: "{reference.expansion.name} sealed product",
      requiredFieldKeys: [],
    },
  ];

  const existing = await loadExistingSeedDisplayTemplates(
    services,
    definitions.map((definition) => definition.displayTemplateId),
  );
  let reconciled = 0;

  for (const definition of definitions) {
    const current = existing.get(definition.displayTemplateId);
    const streamId = `catalog.display-template-${definition.displayTemplateId}`;
    const command = {
      key: definition.key,
      name: localizedTextMapFromEnglish(definition.name),
      description: localizedTextMapFromEnglish(""),
      target: definition.target,
      priority: definition.priority,
      titleTemplate: definition.titleTemplate,
      subtitleTemplate: definition.subtitleTemplate,
      requiredFieldKeys: definition.requiredFieldKeys,
    };

    if (!current) {
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

    if (!seedDefinitionMatches(current, definition)) {
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

    if (current.status === "draft") {
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

async function loadExistingSeedDisplayTemplates(
  services: CatalogServices,
  ids: readonly string[],
): Promise<Map<string, ExistingSeedDisplayTemplateRow>> {
  const result = await services.db.query<ExistingSeedDisplayTemplateRow>(
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
    [ids],
  );

  return new Map(result.rows.map((row) => [row.display_template_id, row]));
}

function seedDefinitionMatches(
  current: ExistingSeedDisplayTemplateRow,
  definition: Readonly<{
    key: string;
    target: { kind: string; id?: string };
    priority: number;
    titleTemplate: string;
    subtitleTemplate: string | null;
    requiredFieldKeys: readonly string[];
  }>,
): boolean {
  return (
    current.key === definition.key &&
    current.target_kind === definition.target.kind &&
    current.target_id === (definition.target.kind === "global" ? null : (definition.target.id ?? null)) &&
    current.priority === definition.priority &&
    current.title_template === definition.titleTemplate &&
    current.subtitle_template === definition.subtitleTemplate &&
    sortedStrings(current.required_field_keys).join("\n") === [...definition.requiredFieldKeys].sort().join("\n")
  );
}

function sortedStrings(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter((entry): entry is string => typeof entry === "string").sort();
}
