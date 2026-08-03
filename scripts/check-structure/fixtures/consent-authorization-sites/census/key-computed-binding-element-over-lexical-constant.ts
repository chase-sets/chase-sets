const censusComputedBindingKey = "authorizeConsentForActor";
const { [censusComputedBindingKey]: censusComputedBindingAlias } = authorization;

export const censusComputedBindingCall = censusComputedBindingAlias(context);
