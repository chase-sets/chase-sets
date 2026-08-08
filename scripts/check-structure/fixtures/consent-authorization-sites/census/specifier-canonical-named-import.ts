import { authorizeConsentForActor } from "../../bounded-contexts/identity/features/consents/domain/consent-recording-authorization";

export function censusCanonicalNamedImportProbe() {
  return authorizeConsentForActor(context);
}
