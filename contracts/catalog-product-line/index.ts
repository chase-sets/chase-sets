/** Catalog-owned Product Line identity projected for downstream read models. */
export type CatalogProductLineReference = Readonly<{
  referenceId: string;
  name: string;
  version: number;
}>;

export type PricingCatalogItemProductLineInput = Readonly<{
  catalogItemId: string;
  productLine: CatalogProductLineReference | null;
}>;
