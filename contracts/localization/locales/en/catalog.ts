import { catalogDisplayTemplatesEnglishTranslations } from "./catalog/display-templates";
import { catalogSupportEnglishTranslations } from "./catalog/support";
import { catalogReferenceDataEnglishTranslations } from "./catalog/reference-data";
import { catalogSourceObservationsApiDetailMappingEnglishTranslations } from "./catalog/source-observations-api-detail-mapping";
import { catalogSourceObservationsWorkbenchOperationsEnglishTranslations } from "./catalog/source-observations-workbench-operations";
import { catalogSourceObservationsControlPlaneEnglishTranslations } from "./catalog/source-observations-control-plane";
import { catalogSourceObservationsAliasReviewEnglishTranslations } from "./catalog/source-observations-alias-review";
import { catalogAttentionQueueEnglishTranslations } from "./catalog/attention-queue";
import { catalogSourceObservationsWorkbenchHealthCopyEnglishTranslations } from "./catalog/source-observations-workbench-health-copy";
import { catalogSourceObservationsWorkbenchProfileValidationEnglishTranslations } from "./catalog/source-observations-workbench-profile-validation";
import { catalogRoutesEnglishTranslations } from "./catalog/routes";
import { catalogBlueprintsEnglishTranslations } from "./catalog/blueprints";
import { catalogItemsEnglishTranslations } from "./catalog/catalog-items";
import { catalogCategoriesEnglishTranslations } from "./catalog/categories";
import { catalogComponentsEnglishTranslations } from "./catalog/components";
import { catalogDimensionsEnglishTranslations } from "./catalog/dimensions";
import { catalogFieldsEnglishTranslations } from "./catalog/fields";
import { catalogProviderScopeMappingEnglishTranslations } from "./catalog/provider-scope-mapping";

type CatalogTranslationPart = Readonly<Record<string, string>>;

type CatalogTranslationPartKeys<Part> = Part extends CatalogTranslationPart ? keyof Part & string : never;

type DuplicateCatalogTranslationKeys<
  Parts extends readonly CatalogTranslationPart[],
  Seen extends string = never,
> = Parts extends readonly [
  infer Head extends CatalogTranslationPart,
  ...infer Tail extends readonly CatalogTranslationPart[],
]
  ?
      | Extract<CatalogTranslationPartKeys<Head>, Seen>
      | DuplicateCatalogTranslationKeys<Tail, Seen | CatalogTranslationPartKeys<Head>>
  : never;

type CatalogTranslationKeysFromParts<Parts extends readonly CatalogTranslationPart[]> = CatalogTranslationPartKeys<
  Parts[number]
>;

type ExactCatalogTranslations<Translations extends CatalogTranslationPart, Keys extends string> = [Keys] extends [
  keyof Translations,
]
  ? [Exclude<keyof Translations, Keys>] extends [never]
    ? Translations
    : never
  : never;

function defineCatalogTranslationParts<const Parts extends readonly CatalogTranslationPart[]>(
  ...parts: DuplicateCatalogTranslationKeys<Parts> extends never ? Parts : never
): Parts {
  return parts as Parts;
}

const catalogEnglishTranslationParts = defineCatalogTranslationParts(
  catalogDisplayTemplatesEnglishTranslations,
  catalogSupportEnglishTranslations,
  catalogReferenceDataEnglishTranslations,
  catalogSourceObservationsApiDetailMappingEnglishTranslations,
  catalogSourceObservationsWorkbenchOperationsEnglishTranslations,
  catalogSourceObservationsControlPlaneEnglishTranslations,
  catalogSourceObservationsAliasReviewEnglishTranslations,
  catalogAttentionQueueEnglishTranslations,
  catalogSourceObservationsWorkbenchHealthCopyEnglishTranslations,
  catalogSourceObservationsWorkbenchProfileValidationEnglishTranslations,
  catalogRoutesEnglishTranslations,
  catalogBlueprintsEnglishTranslations,
  catalogItemsEnglishTranslations,
  catalogCategoriesEnglishTranslations,
  catalogComponentsEnglishTranslations,
  catalogDimensionsEnglishTranslations,
  catalogFieldsEnglishTranslations,
  catalogProviderScopeMappingEnglishTranslations,
);

type CatalogEnglishTranslationKey = CatalogTranslationKeysFromParts<typeof catalogEnglishTranslationParts>;

function defineCatalogTranslations<const Translations extends CatalogTranslationPart>(
  translations: ExactCatalogTranslations<Translations, CatalogEnglishTranslationKey>,
): Translations {
  return translations as Translations;
}

export const catalogEnglishTranslations = defineCatalogTranslations({
  ...catalogDisplayTemplatesEnglishTranslations,
  ...catalogSupportEnglishTranslations,
  ...catalogReferenceDataEnglishTranslations,
  ...catalogSourceObservationsApiDetailMappingEnglishTranslations,
  ...catalogSourceObservationsWorkbenchOperationsEnglishTranslations,
  ...catalogSourceObservationsControlPlaneEnglishTranslations,
  ...catalogSourceObservationsAliasReviewEnglishTranslations,
  ...catalogAttentionQueueEnglishTranslations,
  ...catalogSourceObservationsWorkbenchHealthCopyEnglishTranslations,
  ...catalogSourceObservationsWorkbenchProfileValidationEnglishTranslations,
  ...catalogRoutesEnglishTranslations,
  ...catalogBlueprintsEnglishTranslations,
  ...catalogItemsEnglishTranslations,
  ...catalogCategoriesEnglishTranslations,
  ...catalogComponentsEnglishTranslations,
  ...catalogDimensionsEnglishTranslations,
  ...catalogFieldsEnglishTranslations,
  ...catalogProviderScopeMappingEnglishTranslations,
});
