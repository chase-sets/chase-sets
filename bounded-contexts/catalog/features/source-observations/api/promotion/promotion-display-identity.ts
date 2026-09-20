import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogItemCommand } from "../../../catalog-items/domain/domain";
import {
  resolveCatalogItemDisplayIdentity,
  type DisplayIdentityItem,
  type ResolvedDisplayIdentity,
} from "../../../catalog-items/read-model/display-identity";
import { asArray, type FieldValue } from "../../../../support/projection-support/read-model-support";
import { normalizeLocaleCode, resolveLocalizedTextMap } from "../../../../support/runtime-support/common";

/**
 * Promotion-time display identity validation. A promotion plan composes the
 * complete post-plan Catalog Item tuple (proposed metadata, blueprint, fields
 * and categories overlaid on the current item for refreshes) and awaits the
 * unchanged Catalog Item display identity resolver BEFORE any command is
 * exposed. A degraded outcome is a bounded, promotion-blocking diagnostic; the
 * only escape is the operator's explicit promote-as-draft choice, and that
 * choice never applies to a published item.
 */

export const DISPLAY_IDENTITY_UNRESOLVABLE_CODE = "display-identity-unresolvable";
export const DISPLAY_IDENTITY_DIAGNOSTIC_PATH = "displayIdentity";

// Sentinel the resolver records in missing_tokens when no display template
// targeted the item at all.
const NO_TEMPLATE_MATCHED_TOKEN = "template";

export type CatalogPromotionDisplayIdentityTemplateReason =
  | "unresolved-title-tokens"
  | "no-targeted-template"
  | "missing-required-fields";

/** Structured, safe Catalog evidence only: no title, field values, or provider text. */
export type CatalogPromotionDisplayIdentityEvidence = Readonly<{
  missingTokens: readonly string[];
  templateKey: string | null;
  templateTargetKind: string | null;
  templateTargetId: string | null;
  templateReason: CatalogPromotionDisplayIdentityTemplateReason;
}>;

export type CatalogPromotionDisplayIdentityDiagnostic = Readonly<{
  code: typeof DISPLAY_IDENTITY_UNRESOLVABLE_CODE;
  path: typeof DISPLAY_IDENTITY_DIAGNOSTIC_PATH;
  diagnosticText: string;
  displayIdentity: CatalogPromotionDisplayIdentityEvidence;
}>;

/** Resolver outcome bound into every promotion plan fingerprint. */
export type CatalogPromotionDisplayIdentityOutcome = Readonly<{
  hash: string;
  resolverVersion: number;
  resolutionStatus: ResolvedDisplayIdentity["resolutionStatus"];
  missingTokens: readonly string[];
  templateKey: string | null;
}>;

export type CatalogPromotionDisplayIdentityMode = "create" | "refresh" | "link-existing";

export type CatalogPromotionCurrentItem = Readonly<{
  catalog_item_id: string;
  language_code: string;
  status: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  field_values: unknown;
  category_ids: unknown;
}>;

export type CatalogPromotionDisplayIdentityValidation =
  | Readonly<{
      status: "validated";
      outcome: CatalogPromotionDisplayIdentityOutcome;
      /** Null when the proposed identity resolved. Present (and blocking unless
       * an explicit draft choice applies) when degraded. */
      diagnostic: CatalogPromotionDisplayIdentityDiagnostic | null;
      /** Current Catalog Item status for refresh/link-existing; null for create. */
      currentItemStatus: string | null;
    }>
  | Readonly<{ status: "missing-current-item" }>;

export const displayIdentityDiagnosticText: Readonly<Record<CatalogPromotionDisplayIdentityTemplateReason, string>> = {
  "unresolved-title-tokens": "Matched template has unresolved title tokens.",
  "no-targeted-template": "No display template targets this item.",
  "missing-required-fields": "Targeted template is missing required fields.",
};

/**
 * Compose the post-plan item and resolve its display identity. Create builds
 * the item purely from the proposed commands; refresh loads the current item
 * and overlays EVERY identity-affecting mutation; link-existing validates the
 * unchanged current item.
 */
export async function validatePromotionDisplayIdentity(input: {
  db: PgQueryable;
  mode: CatalogPromotionDisplayIdentityMode;
  catalogItemId: string;
  commands: readonly CatalogItemCommand[];
}): Promise<CatalogPromotionDisplayIdentityValidation> {
  const currentItem = input.mode === "create" ? null : await loadCurrentCatalogItem(input.db, input.catalogItemId);
  if (input.mode !== "create" && !currentItem) {
    return { status: "missing-current-item" };
  }

  const item = composeProposedDisplayIdentityItem({
    mode: input.mode,
    catalogItemId: input.catalogItemId,
    commands: input.commands,
    currentItem,
  });
  const identity = await resolveCatalogItemDisplayIdentity(input.db, item);

  return {
    status: "validated",
    outcome: {
      hash: identity.hash,
      resolverVersion: identity.resolverVersion,
      resolutionStatus: identity.resolutionStatus,
      missingTokens: sortedUnique(identity.missingTokens),
      templateKey: identity.templateKey,
    },
    diagnostic: identity.resolutionStatus === "resolved" ? null : displayIdentityUnresolvableDiagnostic(identity),
    currentItemStatus: currentItem?.status ?? null,
  };
}

/**
 * Pure composition of the post-plan Catalog Item tuple the resolver reads.
 * Exported for the planners' internal construction and tests; never a
 * substitute for the resolver call itself.
 */
export function composeProposedDisplayIdentityItem(input: {
  mode: CatalogPromotionDisplayIdentityMode;
  catalogItemId: string;
  commands: readonly CatalogItemCommand[];
  currentItem: CatalogPromotionCurrentItem | null;
}): DisplayIdentityItem {
  const base: DisplayIdentityItem = input.currentItem
    ? {
        catalog_item_id: input.currentItem.catalog_item_id,
        language_code: input.currentItem.language_code,
        title: input.currentItem.title,
        subtitle: input.currentItem.subtitle,
        blueprint_id: input.currentItem.blueprint_id,
        field_values: asArray<FieldValue>(input.currentItem.field_values),
        category_ids: asArray<string>(input.currentItem.category_ids),
      }
    : {
        catalog_item_id: input.catalogItemId,
        language_code: "en",
        title: "",
        subtitle: null,
        blueprint_id: null,
        field_values: [],
        category_ids: [],
      };

  if (input.mode === "link-existing") {
    return base;
  }

  return input.commands.reduce<DisplayIdentityItem>(overlayCommand, base);
}

function overlayCommand(item: DisplayIdentityItem, command: CatalogItemCommand): DisplayIdentityItem {
  switch (command.type) {
    case "CreateCatalogItem":
    case "ReviseCatalogItemMetadata": {
      const languageCode = normalizeLocaleCode(command.languageCode ?? item.language_code ?? "en");
      // Mirrors the catalog_items projection: a present subtitle map projects
      // to its resolved text (even ""), an absent one to null.
      return {
        ...item,
        language_code: languageCode,
        title: resolveLocalizedTextMap(command.title),
        subtitle: command.subtitle ? resolveLocalizedTextMap(command.subtitle) : null,
      };
    }
    case "AssignBlueprintToCatalogItem":
      return { ...item, blueprint_id: command.blueprintId };
    case "SetCatalogItemFieldValue":
      return {
        ...item,
        field_values: [
          ...asArray<FieldValue>(item.field_values).filter((fieldValue) => fieldValue.fieldId !== command.fieldId),
          { fieldId: command.fieldId, value: command.value },
        ],
      };
    case "ClearCatalogItemFieldValue":
      return {
        ...item,
        field_values: asArray<FieldValue>(item.field_values).filter(
          (fieldValue) => fieldValue.fieldId !== command.fieldId,
        ),
      };
    case "AssignCatalogItemToCategory": {
      const categoryIds = asArray<string>(item.category_ids);
      return categoryIds.includes(command.categoryId)
        ? item
        : { ...item, category_ids: [...categoryIds, command.categoryId] };
    }
    case "RemoveCatalogItemFromCategory":
      return {
        ...item,
        category_ids: asArray<string>(item.category_ids).filter((categoryId) => categoryId !== command.categoryId),
      };
    default:
      return item;
  }
}

/**
 * The bounded diagnostic for a degraded resolver outcome. Only structured
 * resolver evidence enters here; the text is fixed per template reason.
 */
export function displayIdentityUnresolvableDiagnostic(
  identity: Pick<ResolvedDisplayIdentity, "missingTokens" | "templateKey" | "templateTargetKind" | "templateTargetId">,
): CatalogPromotionDisplayIdentityDiagnostic {
  const missingTokens = sortedUnique(identity.missingTokens);
  const templateReason: CatalogPromotionDisplayIdentityTemplateReason =
    identity.templateKey !== null
      ? "unresolved-title-tokens"
      : missingTokens.includes(NO_TEMPLATE_MATCHED_TOKEN)
        ? "no-targeted-template"
        : "missing-required-fields";

  return {
    code: DISPLAY_IDENTITY_UNRESOLVABLE_CODE,
    path: DISPLAY_IDENTITY_DIAGNOSTIC_PATH,
    diagnosticText: displayIdentityDiagnosticText[templateReason],
    displayIdentity: {
      missingTokens,
      templateKey: identity.templateKey,
      templateTargetKind: identity.templateTargetKind,
      templateTargetId: identity.templateTargetId,
      templateReason,
    },
  };
}

/**
 * Whether an explicit promote-as-draft choice may carry a degraded identity.
 * It applies only to draft-only commands: a create, or a refresh of an item
 * that is not published. It never bypasses publishing or updates a published
 * item with a degraded identity.
 */
export function promoteAsDraftBypassesDegradedIdentity(input: {
  promoteAsDraft: boolean;
  currentItemStatus: string | null;
  commands: readonly CatalogItemCommand[];
}): boolean {
  if (!input.promoteAsDraft) {
    return false;
  }
  if (input.commands.some((command) => command.type === "PublishCatalogItem")) {
    return false;
  }
  // A published Catalog Item projects as `active`; a degraded identity must
  // never be written onto it, draft choice or not.
  return input.currentItemStatus !== "active";
}

export async function loadCurrentCatalogItem(
  db: PgQueryable,
  catalogItemId: string,
): Promise<CatalogPromotionCurrentItem | null> {
  const result = await db.query<CatalogPromotionCurrentItem>(
    `SELECT catalog_item_id, language_code, status, title, subtitle, blueprint_id, field_values, category_ids
     FROM catalog_items
     WHERE catalog_item_id = $1
     LIMIT 1`,
    [catalogItemId],
  );
  return result.rows[0] ?? null;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
