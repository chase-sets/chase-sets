const censusDynamicImportRoot = "../../bounded-contexts/identity/features/consents/domain/";

export async function censusConcatenatedDynamicImportProbe() {
  return import(censusDynamicImportRoot + "consent-recording-authorization");
}
