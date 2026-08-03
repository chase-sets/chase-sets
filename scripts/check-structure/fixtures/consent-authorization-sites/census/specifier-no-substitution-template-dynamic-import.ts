export async function censusTemplateDynamicImportProbe() {
  return import(`../../bounded-contexts/identity/features/consents/domain/consent-recording-authorization`);
}
