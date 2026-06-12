import type { ProductMeasureSnapshot } from "@chase-sets/product-measures";

export type CatalogRepresentativeProductSchema = Readonly<{
  canonicalDimensionOrder: readonly Readonly<{ dimensionId: string; dimensionName: string }>[];
  dimensions: readonly Readonly<{
    dimensionId: string;
    dimensionName: string;
    required: boolean;
    appliesWhen: readonly Readonly<{ dimensionId: string; optionIds: readonly string[] }>[];
    allowedOptions: readonly Readonly<{
      optionId: string;
      code: string;
      label_i18n?: unknown;
      label: string;
    }>[];
  }>[];
}>;

export type CatalogRepresentativeCatalogUsageCandidate = Readonly<{
  catalogItemId: string;
  languageCode: string;
  title: string;
  subtitle: string | null;
  blueprintId: string | null;
  status: "active";
  productSchema: CatalogRepresentativeProductSchema | null;
  productMeasureSnapshots: readonly ProductMeasureSnapshot[];
  updatedAt: string;
}>;
