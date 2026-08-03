// The specifier is written relative to the arbitrary path this module is
// planted at, two directories below the repository root, so that it resolves
// onto the real declaration module rather than onto a same-named neighbour.
import * as consentAuthorization from "../../bounded-contexts/identity/features/consents/domain/consent-recording-authorization";

export function namespaceBindingProbe(key: string) {
  return consentAuthorization[key](context);
}
