const censusDynamicImportSpecifier =
  "../../bounded-contexts/identity/features/consents/domain/consent-recording-authorization";

export async function censusConstantDynamicImportProbe() {
  return import(censusDynamicImportSpecifier);
}
