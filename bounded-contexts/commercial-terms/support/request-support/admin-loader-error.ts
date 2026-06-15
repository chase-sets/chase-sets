import { t } from "@chase-sets/localization";
import { readApiErrorCode } from "@chase-sets/http/responses";

export function commercialTermsApiErrorStatus(error: unknown): number | null {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
  return typeof status === "number" ? status : null;
}

export function commercialTermsApiErrorBody(error: unknown): unknown {
  return typeof error === "object" && error !== null && "body" in error ? error.body : null;
}

export function commercialTermsApiErrorCode(error: unknown): string | null {
  return readApiErrorCode(commercialTermsApiErrorBody(error));
}

export function formatCommercialTermsAdminLoadError(error: unknown): string {
  if (error instanceof Response) {
    throw error;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return t("commercialTerms.support.requestSupport.adminLoaderError.commercial.terms.unavailable");
}
