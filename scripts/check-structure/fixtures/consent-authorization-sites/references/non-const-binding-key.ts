const mutableShadowKey = "authorizeConsentForActor";

export function nonConstantBindingProbe() {
  let mutableShadowKey = "authorizeConsentForProvisioning";
  return authorization[mutableShadowKey](context);
}
