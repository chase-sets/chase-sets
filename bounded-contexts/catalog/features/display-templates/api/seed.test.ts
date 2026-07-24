import { describe, expect, it, vi } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { CatalogDomainError } from "../../../support/runtime-support/common";
import { seedDisplayTemplates } from "./seed";

describe("seedDisplayTemplates", () => {
  it("does not emit commands on a no-op seed rerun", async () => {
    const commandHandler = vi.fn(async () => undefined);
    const db = seedDb(matchingSeedRows());

    await seedDisplayTemplates({ db, displayTemplates: { commandHandler } } as never);

    expect(commandHandler).not.toHaveBeenCalled();
    expect(db.queueTouched).toBe(false);
  });

  it("revises changed seed templates by stable seed identity", async () => {
    const commandHandler = vi.fn(async () => undefined);
    const rows = matchingSeedRows({
      [catalogSeedIds.displayTemplates.pokemonSingleCardDefault]: {
        title_template: "{field.card-name}",
      },
    });
    const db = seedDb(rows);

    await seedDisplayTemplates({ db, displayTemplates: { commandHandler } } as never);

    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `catalog.display-template-${catalogSeedIds.displayTemplates.pokemonSingleCardDefault}`,
        command: expect.objectContaining({
          type: "ReviseDisplayTemplate",
          titleTemplate: "{field.card-name} {field.card-number}[/{reference.expansion.attributes.printed-card-count}]",
        }),
      }),
    );
    expect(db.queueTouched).toBe(true);
  });

  it("creates and publishes missing seed templates even when other template rows exist", async () => {
    const commandHandler = vi.fn(async () => undefined);
    const rows = matchingSeedRows().filter(
      (row) => row.display_template_id !== catalogSeedIds.displayTemplates.pokemonSealedProduct,
    );
    const db = seedDb(rows);

    await seedDisplayTemplates({ db, displayTemplates: { commandHandler } } as never);

    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `catalog.display-template-${catalogSeedIds.displayTemplates.pokemonSealedProduct}`,
        command: expect.objectContaining({
          type: "CreateDisplayTemplate",
          displayTemplateId: catalogSeedIds.displayTemplates.pokemonSealedProduct,
        }),
      }),
    );
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `catalog.display-template-${catalogSeedIds.displayTemplates.pokemonSealedProduct}`,
        command: { type: "PublishDisplayTemplate" },
      }),
    );
    expect(db.queueTouched).toBe(true);
  });

  it("creates One Piece templates with product-line naming and shared set references", async () => {
    const commandHandler = vi.fn(async () => undefined);
    const rows = matchingSeedRows().filter(
      (row) => row.display_template_id !== catalogSeedIds.displayTemplates.onePieceCardPrintDefault,
    );
    const db = seedDb(rows);

    await seedDisplayTemplates({ db, displayTemplates: { commandHandler } } as never);

    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `catalog.display-template-${catalogSeedIds.displayTemplates.onePieceCardPrintDefault}`,
        command: expect.objectContaining({
          type: "CreateDisplayTemplate",
          key: "one-piece-card-print-default",
          name: { defaultLocale: "en", values: { en: "One Piece card print" } },
          target: { kind: "blueprint", id: catalogSeedIds.blueprints.onePieceCardPrint },
          titleTemplate: "{field.card-name} {field.card-number}",
          subtitleTemplate: "{reference.set.name} [{field.card-variant} ]{field.rarity}",
        }),
      }),
    );
    expect(db.queueTouched).toBe(true);
  });

  it("creates Lorcana templates with card variant and sealed form display copy", async () => {
    const commandHandler = vi.fn(async () => undefined);
    const rows = matchingSeedRows().filter(
      (row) => row.display_template_id !== catalogSeedIds.displayTemplates.lorcanaCardPrintDefault,
    );
    const db = seedDb(rows);

    await seedDisplayTemplates({ db, displayTemplates: { commandHandler } } as never);

    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `catalog.display-template-${catalogSeedIds.displayTemplates.lorcanaCardPrintDefault}`,
        command: expect.objectContaining({
          type: "CreateDisplayTemplate",
          key: "lorcana-card-print-default",
          name: { defaultLocale: "en", values: { en: "Lorcana card print" } },
          target: { kind: "blueprint", id: catalogSeedIds.blueprints.lorcanaCardPrint },
          titleTemplate: "{field.card-name} {field.card-number}",
          subtitleTemplate: "{reference.set.name} [{field.card-variant} ]{field.ink-color} {field.rarity}",
        }),
      }),
    );
    expect(db.queueTouched).toBe(true);
  });

  it("publishes existing draft seed templates", async () => {
    const commandHandler = vi.fn(async () => undefined);
    const db = seedDb(
      matchingSeedRows({
        [catalogSeedIds.displayTemplates.pokemonSingleCardDefault]: {
          status: "draft",
        },
      }),
    );

    await seedDisplayTemplates({ db, displayTemplates: { commandHandler } } as never);

    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `catalog.display-template-${catalogSeedIds.displayTemplates.pokemonSingleCardDefault}`,
        command: { type: "PublishDisplayTemplate" },
      }),
    );
    expect(db.queueTouched).toBe(true);
  });

  it("treats stale draft read model publish attempts as idempotent", async () => {
    const commandHandler = vi.fn(async (input: { command: { type: string } }) => {
      if (input.command.type === "PublishDisplayTemplate") {
        throw new CatalogDomainError("Only draft Display Templates can be published.");
      }
    });
    const db = seedDb(
      matchingSeedRows({
        [catalogSeedIds.displayTemplates.pokemonSingleCardDefault]: {
          status: "draft",
        },
      }),
    );

    await seedDisplayTemplates({ db, displayTemplates: { commandHandler } } as never);

    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `catalog.display-template-${catalogSeedIds.displayTemplates.pokemonSingleCardDefault}`,
        command: { type: "PublishDisplayTemplate" },
      }),
    );
    expect(db.queueTouched).toBe(false);
  });
});

type SeedRow = Readonly<{
  display_template_id: string;
  key: string;
  target_kind: string;
  target_id: string | null;
  priority: number;
  title_template: string;
  subtitle_template: string | null;
  required_field_keys: string[];
  status: string;
}>;

function matchingSeedRows(overrides: Record<string, Partial<SeedRow>> = {}): SeedRow[] {
  const rows: SeedRow[] = [
    {
      display_template_id: catalogSeedIds.displayTemplates.pokemonSingleCardDefault,
      key: "pokemon-single-card-default",
      target_kind: "blueprint",
      target_id: catalogSeedIds.blueprints.pokemonCardSingle,
      priority: 10,
      title_template: "{field.card-name} {field.card-number}[/{reference.expansion.attributes.printed-card-count}]",
      subtitle_template: "{reference.expansion.name} [{field.card-variant} ]{field.rarity}",
      required_field_keys: ["card-name", "card-number", "expansion", "rarity"],
      status: "active",
    },
    {
      display_template_id: catalogSeedIds.displayTemplates.pokemonPromoCard,
      key: "pokemon-promo-card",
      target_kind: "reference-record",
      target_id: catalogSeedIds.referenceRecords.expansions.wizardsBlackStarPromos,
      priority: 100,
      title_template: "{field.card-name} {field.card-number}",
      subtitle_template: "{reference.expansion.name} [{field.card-variant} ]{field.rarity}",
      required_field_keys: ["card-name", "card-number", "expansion", "rarity"],
      status: "active",
    },
    {
      display_template_id: catalogSeedIds.displayTemplates.pokemonSealedProduct,
      key: "pokemon-sealed-product",
      target_kind: "blueprint",
      target_id: catalogSeedIds.blueprints.pokemonSealedProduct,
      priority: 10,
      title_template: "{item.title}",
      subtitle_template: "{reference.expansion.name} sealed product",
      required_field_keys: ["expansion"],
      status: "active",
    },
    {
      display_template_id: catalogSeedIds.displayTemplates.magicCardPrintDefault,
      key: "magic-card-print-default",
      target_kind: "blueprint",
      target_id: catalogSeedIds.blueprints.magicCardPrint,
      priority: 10,
      title_template: "{field.card-name} {field.card-number}",
      subtitle_template: "{reference.set.name} [{field.card-variant} ]{field.rarity}",
      required_field_keys: ["card-name", "card-number", "rarity", "set"],
      status: "active",
    },
    {
      display_template_id: catalogSeedIds.displayTemplates.magicSealedProduct,
      key: "magic-sealed-product",
      target_kind: "blueprint",
      target_id: catalogSeedIds.blueprints.magicSealedProduct,
      priority: 10,
      title_template: "{item.title}",
      subtitle_template: "{reference.set.name} sealed product",
      required_field_keys: ["set"],
      status: "active",
    },
    {
      display_template_id: catalogSeedIds.displayTemplates.onePieceCardPrintDefault,
      key: "one-piece-card-print-default",
      target_kind: "blueprint",
      target_id: catalogSeedIds.blueprints.onePieceCardPrint,
      priority: 10,
      title_template: "{field.card-name} {field.card-number}",
      subtitle_template: "{reference.set.name} [{field.card-variant} ]{field.rarity}",
      required_field_keys: ["card-name", "card-number", "rarity", "set"],
      status: "active",
    },
    {
      display_template_id: catalogSeedIds.displayTemplates.onePieceSealedProduct,
      key: "one-piece-sealed-product",
      target_kind: "blueprint",
      target_id: catalogSeedIds.blueprints.onePieceSealedProduct,
      priority: 10,
      title_template: "{item.title}",
      subtitle_template: "{reference.set.name} sealed product",
      required_field_keys: ["set"],
      status: "active",
    },
    {
      display_template_id: catalogSeedIds.displayTemplates.lorcanaCardPrintDefault,
      key: "lorcana-card-print-default",
      target_kind: "blueprint",
      target_id: catalogSeedIds.blueprints.lorcanaCardPrint,
      priority: 10,
      title_template: "{field.card-name} {field.card-number}",
      subtitle_template: "{reference.set.name} [{field.card-variant} ]{field.ink-color} {field.rarity}",
      required_field_keys: ["card-name", "card-number", "ink-color", "rarity", "set"],
      status: "active",
    },
    {
      display_template_id: catalogSeedIds.displayTemplates.lorcanaSealedProduct,
      key: "lorcana-sealed-product",
      target_kind: "blueprint",
      target_id: catalogSeedIds.blueprints.lorcanaSealedProduct,
      priority: 10,
      title_template: "{item.title}",
      subtitle_template: "{reference.set.name} {field.sealed-product-form}",
      required_field_keys: ["set", "sealed-product-form"],
      status: "active",
    },
  ];

  return rows.map((row) => ({ ...row, ...(overrides[row.display_template_id] ?? {}) }));
}

function seedDb(rows: SeedRow[]) {
  return {
    queueTouched: false,
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes("FROM catalog_display_templates")) {
        return { rows: rows as T[] };
      }

      if (sql.includes("FROM catalog_items")) {
        this.queueTouched = true;
        return { rows: [] };
      }

      if (sql.includes("catalog_item_display_identity_recompute_work")) {
        this.queueTouched = true;
      }

      return { rows: [] };
    },
  };
}
