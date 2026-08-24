// The nearest lexical binding of this name spells a canonical constructor while
// the outer binding does not, so only nearest-scope constant resolution reaches
// the real reference. The sibling slice owns that resolution.
const censusShadowedKey = "unrelatedRuntimeKey";

export function censusShadowedConstantProbe() {
  const censusShadowedKey = "authorizeConsentForActor";
  return authorization[censusShadowedKey](context);
}
