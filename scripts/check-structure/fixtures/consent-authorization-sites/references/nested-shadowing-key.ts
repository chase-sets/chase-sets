const directShadowKey = "authorizeConsentForProvisioning";

export function directShadowProbe() {
  const directShadowKey = "authorizeConsentForActor";
  return authorization[directShadowKey](context);
}

const transitiveTarget = "authorizeConsentForProvisioning";
const transitiveAlias = transitiveTarget;

export function transitiveDeclarationScopeProbe() {
  const transitiveTarget = "authorizeConsentForActor";
  return authorization[transitiveAlias](context);
}

const reentrantKey = "authorizeConsentForProvisioning";
const reentrantAlias = reentrantKey;

export function reentrantBindingIdentityProbe() {
  const reentrantKey = reentrantAlias;
  return authorization[reentrantKey](context);
}

const genuineCycleKey = genuineCycleKey;
export const genuineCycleProbe = authorization[genuineCycleKey](context);
