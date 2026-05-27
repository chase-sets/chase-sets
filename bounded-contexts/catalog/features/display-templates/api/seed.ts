import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";
import { catalogSeedIds } from "../../../support/seed-support/ids";
import { seedContext } from "../../../support/seed-support/context";
import type { CatalogServices } from "../../../support/authoring-support";

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

  for (const definition of definitions) {
    await services.displayTemplates.commandHandler({
      streamId: `catalog.display-template-${definition.displayTemplateId}`,
      command: {
        type: "CreateDisplayTemplate",
        displayTemplateId: definition.displayTemplateId,
        key: definition.key,
        name: localizedTextMapFromEnglish(definition.name),
        description: localizedTextMapFromEnglish(""),
        target: definition.target,
        priority: definition.priority,
        titleTemplate: definition.titleTemplate,
        subtitleTemplate: definition.subtitleTemplate,
        requiredFieldKeys: definition.requiredFieldKeys,
      },
      context: seedContext,
    });
    await services.displayTemplates.commandHandler({
      streamId: `catalog.display-template-${definition.displayTemplateId}`,
      command: { type: "PublishDisplayTemplate" },
      context: seedContext,
    });
  }
}
