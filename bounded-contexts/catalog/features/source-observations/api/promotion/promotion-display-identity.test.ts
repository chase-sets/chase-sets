import { describe, expect, it } from "vitest";
import type { CatalogItemCommand } from "../../../catalog-items/domain/domain";
import type { BlueprintId, CategoryId, FieldId } from "../../../../ids";
import type { CatalogItemId } from "../../../../ids";
import {
  createSyntheticDisplayIdentityQueryable,
  syntheticCurrentCatalogItem,
} from "../seeding/synthetic-display-identity-queryable";
import {
  composeProposedDisplayIdentityItem,
  displayIdentityDiagnosticText,
  displayIdentityUnresolvableDiagnostic,
  promoteAsDraftBypassesDegradedIdentity,
  validatePromotionDisplayIdentity,
} from "./promotion-display-identity";

const localized = (value: string) => ({ defaultLocale: "en" as const, values: { en: value } });

describe("promotion display identity validation", () => {
  it("maps the three resolver degradation shapes to exact diagnostic text and structured evidence only", () => {
    const matchedTemplate = displayIdentityUnresolvableDiagnostic({
      missingTokens: ["reference.expansion.attributes.code", "field.card-number", "field.card-number"],
      templateKey: "pokemon-card-title",
      templateTargetKind: "blueprint",
      templateTargetId: "bp_pokemon_card",
    });
    const noTemplate = displayIdentityUnresolvableDiagnostic({
      missingTokens: ["template"],
      templateKey: null,
      templateTargetKind: null,
      templateTargetId: null,
    });
    const missingRequired = displayIdentityUnresolvableDiagnostic({
      missingTokens: ["rarity", "card-illustrator"],
      templateKey: null,
      templateTargetKind: null,
      templateTargetId: null,
    });

    expect(matchedTemplate).toEqual({
      code: "display-identity-unresolvable",
      path: "displayIdentity",
      diagnosticText: "Matched template has unresolved title tokens.",
      displayIdentity: {
        missingTokens: ["field.card-number", "reference.expansion.attributes.code"],
        templateKey: "pokemon-card-title",
        templateTargetKind: "blueprint",
        templateTargetId: "bp_pokemon_card",
        templateReason: "unresolved-title-tokens",
      },
    });
    expect(noTemplate.diagnosticText).toBe("No display template targets this item.");
    expect(noTemplate.displayIdentity).toMatchObject({ templateReason: "no-targeted-template", templateKey: null });
    expect(missingRequired.diagnosticText).toBe("Targeted template is missing required fields.");
    expect(missingRequired.displayIdentity).toMatchObject({
      templateReason: "missing-required-fields",
      missingTokens: ["card-illustrator", "rarity"],
      templateKey: null,
    });
    expect(Object.keys(matchedTemplate.displayIdentity).sort()).toEqual([
      "missingTokens",
      "templateKey",
      "templateReason",
      "templateTargetId",
      "templateTargetKind",
    ]);
    expect(Object.values(displayIdentityDiagnosticText)).toHaveLength(3);
  });

  it("composes create from the proposal and refresh by overlaying every mutation on the current item", () => {
    const commands: CatalogItemCommand[] = [
      {
        type: "ReviseCatalogItemMetadata",
        languageCode: "en",
        title: localized("Proposed title"),
        subtitle: localized(""),
        description: localized(""),
      },
      { type: "AssignBlueprintToCatalogItem", blueprintId: "bp_new" as BlueprintId },
      { type: "SetCatalogItemFieldValue", fieldId: "field_card_name" as FieldId, value: "Pikachu" },
      { type: "ClearCatalogItemFieldValue", fieldId: "field_stale" as FieldId },
      { type: "AssignCatalogItemToCategory", categoryId: "cat_singles" as CategoryId },
      { type: "RemoveCatalogItemFromCategory", categoryId: "cat_old" as CategoryId },
      { type: "SetCatalogItemTags", tags: ["ignored"] },
    ];
    const currentItem = syntheticCurrentCatalogItem({
      catalog_item_id: "cat_existing",
      title: "Current title",
      subtitle: "Current subtitle",
      blueprint_id: "bp_old",
      field_values: [
        { fieldId: "field_card_name", value: "Old name" },
        { fieldId: "field_stale", value: "stale" },
        { fieldId: "field_retained", value: "kept" },
      ],
      category_ids: ["cat_old", "cat_kept"],
    });

    const refreshed = composeProposedDisplayIdentityItem({
      mode: "refresh",
      catalogItemId: "cat_existing",
      commands,
      currentItem,
    });
    const linked = composeProposedDisplayIdentityItem({
      mode: "link-existing",
      catalogItemId: "cat_existing",
      commands,
      currentItem,
    });
    const created = composeProposedDisplayIdentityItem({
      mode: "create",
      catalogItemId: "cat_new",
      commands: [
        {
          type: "CreateCatalogItem",
          itemId: "cat_new" as CatalogItemId,
          languageCode: "ja",
          title: localized("New"),
          subtitle: null,
        },
        ...commands.slice(1),
      ],
      currentItem: null,
    });

    expect(refreshed).toEqual({
      catalog_item_id: "cat_existing",
      language_code: "en",
      title: "Proposed title",
      subtitle: "",
      blueprint_id: "bp_new",
      field_values: [
        { fieldId: "field_retained", value: "kept" },
        { fieldId: "field_card_name", value: "Pikachu" },
      ],
      category_ids: ["cat_kept", "cat_singles"],
    });
    expect(linked).toMatchObject({
      title: "Current title",
      blueprint_id: "bp_old",
      category_ids: ["cat_old", "cat_kept"],
    });
    expect(created).toMatchObject({
      catalog_item_id: "cat_new",
      language_code: "ja",
      title: "New",
      blueprint_id: "bp_new",
      field_values: [{ fieldId: "field_card_name", value: "Pikachu" }],
      category_ids: ["cat_singles"],
    });
  });

  it("awaits the resolver over the queryable and reports a missing current item instead of a partial tuple", async () => {
    const db = createSyntheticDisplayIdentityQueryable({ templates: [] });
    const missing = await validatePromotionDisplayIdentity({
      db,
      mode: "refresh",
      catalogItemId: "cat_absent",
      commands: [],
    });
    const created = await validatePromotionDisplayIdentity({
      db,
      mode: "create",
      catalogItemId: "cat_new",
      commands: [
        { type: "CreateCatalogItem", itemId: "cat_new" as CatalogItemId, title: localized("New"), subtitle: null },
      ],
    });

    expect(missing).toEqual({ status: "missing-current-item" });
    expect(created).toMatchObject({
      status: "validated",
      outcome: { resolutionStatus: "degraded", missingTokens: ["template"], templateKey: null },
      diagnostic: { code: "display-identity-unresolvable", diagnosticText: "No display template targets this item." },
      currentItemStatus: null,
    });
    expect(db.queries.some((sql) => sql.includes("FROM catalog_display_templates"))).toBe(true);
  });

  it("lets promote-as-draft bypass a degraded identity only for draft-only writes", () => {
    const draftCommands: CatalogItemCommand[] = [{ type: "SetCatalogItemTags", tags: [] }];
    expect(
      promoteAsDraftBypassesDegradedIdentity({
        promoteAsDraft: false,
        currentItemStatus: null,
        commands: draftCommands,
      }),
    ).toBe(false);
    expect(
      promoteAsDraftBypassesDegradedIdentity({
        promoteAsDraft: true,
        currentItemStatus: null,
        commands: draftCommands,
      }),
    ).toBe(true);
    expect(
      promoteAsDraftBypassesDegradedIdentity({
        promoteAsDraft: true,
        currentItemStatus: "draft",
        commands: draftCommands,
      }),
    ).toBe(true);
    expect(
      promoteAsDraftBypassesDegradedIdentity({
        promoteAsDraft: true,
        currentItemStatus: "active",
        commands: draftCommands,
      }),
    ).toBe(false);
    expect(
      promoteAsDraftBypassesDegradedIdentity({
        promoteAsDraft: true,
        currentItemStatus: "draft",
        commands: [{ type: "PublishCatalogItem", blueprintIsActive: true, requiredFieldIds: [] }],
      }),
    ).toBe(false);
  });
});
