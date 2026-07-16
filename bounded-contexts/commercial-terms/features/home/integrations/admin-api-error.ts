import { defineApiErrorAdapter } from "@chase-sets/platform-runtime/http";
import {
  commercialTermsApiErrorBody,
  commercialTermsApiErrorCode,
  commercialTermsApiErrorStatus,
  formatCommercialTermsAdminLoadError,
} from "./admin-loader-error";

export const commercialTermsApiErrorAdapter = defineApiErrorAdapter({
  isError: (error): error is Error & { status?: number; body?: unknown } =>
    error instanceof Error || commercialTermsApiErrorStatus(error) !== null,
  getStatus: commercialTermsApiErrorStatus,
  getBody: commercialTermsApiErrorBody,
  getErrorCode: commercialTermsApiErrorCode,
  getMessage: formatCommercialTermsAdminLoadError,
});
