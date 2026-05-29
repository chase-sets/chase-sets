import type { TaxQuoteResolver } from "@chase-sets/tax/server";

export const productionTaxQuoteProviderMissingMessage =
  "Production tax quote provider is not configured. Keep PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false until Tax readiness is approved and a provider-backed TaxQuoteResolver is composed.";

export function createProductionTaxQuoteResolverBlocker(): TaxQuoteResolver {
  return {
    async quoteTax() {
      throw new Error(productionTaxQuoteProviderMissingMessage);
    },
  };
}

export function shouldBlockProductionTaxQuotes(deploymentEnvironment: string | null | undefined) {
  return deploymentEnvironment === "production";
}
