import type { TaxQuoteResolver } from "@chase-sets/ordering/server";

export const productionTaxQuoteProviderMissingMessage =
  "TAX_PROVIDER_BACKED_QUOTES_REQUIRED=true but no production tax quote provider is configured. Compose a provider-backed TaxQuoteResolver before collecting sales tax, or set the flag false only if Tax readiness confirms no jurisdiction requires collection.";

export function createProductionTaxQuoteResolverBlocker(): TaxQuoteResolver {
  return {
    async quoteTax() {
      throw new Error(productionTaxQuoteProviderMissingMessage);
    },
  };
}

export function shouldBlockProductionTaxQuotes(
  deploymentEnvironment: string | null | undefined,
  providerBackedQuotesRequired: boolean,
) {
  return deploymentEnvironment === "production" && providerBackedQuotesRequired;
}
