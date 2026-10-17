/** Catalog-owned Product Line identity projected for downstream read models. */
export type CatalogProductLineReference = Readonly<{
  referenceId: string;
  name: string;
  /** Per-item resolved (referenceId, name) revision, starting at 1 on first resolution.
   * Increases on tuple changes, including to/from null; unchanged by duplicate delivery
   * or replay. It is not a Catalog aggregate's stream version. */
  version: number;
}>;
