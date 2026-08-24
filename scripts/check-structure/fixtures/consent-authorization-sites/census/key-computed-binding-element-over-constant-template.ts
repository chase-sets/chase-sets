const censusComputedBindingVerb = "authorizeConsent";
const { [`${censusComputedBindingVerb}ForActor`]: censusComputedBindingTemplateAlias } = authorization;

export const censusComputedBindingTemplateCall = censusComputedBindingTemplateAlias(context);
