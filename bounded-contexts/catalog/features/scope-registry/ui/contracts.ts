// Client-facing Scope Record contract. The API returns this camelCase shape
// (see `../api/route.ts#scopeRecordDetailFromRow`); this file is the browser
// side of that same contract so route loaders and UI components share one
// type without importing server-only modules.
export interface CatalogScopeRecordDetail {
  scopeRecordId: string;
  productDomain: string;
  scopeKind: string;
  referenceTypeKey: string;
  referenceRecordId: string;
  referenceRecordKey: string;
  name: string;
  parentScopeRecordId: string | null;
  productLineScopeRecordId: string | null;
  seriesScopeRecordId: string | null;
  releaseDate: string | null;
  officialSetCode: string | null;
  languageEditions: readonly string[];
  lifecycleStatus: string;
  updatedAt: string;
}
