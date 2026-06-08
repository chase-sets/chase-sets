import { t } from "@chase-sets/localization";

export function formatCommercialTermsAdminLoadError(error: unknown): string {
  if (error instanceof Response) {
    throw error;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return t("commercialTerms.support.requestSupport.adminLoaderError.commercial.terms.unavailable");
}
