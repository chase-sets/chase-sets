export function siblingActorKeyProbe() {
  const siblingKey = "authorizeConsentForActor";
  return authorization[siblingKey](context);
}

export function siblingProvisioningKeyProbe() {
  const siblingKey = "authorizeConsentForProvisioning";
  return authorization[siblingKey](context);
}
