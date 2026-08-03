import * as censusNamespaceDynamic from "../../bounded-contexts/identity/features/consents/domain/consent-recording-authorization";

export function censusNamespaceDynamicProbe(key: string) {
  return censusNamespaceDynamic[key](context);
}
