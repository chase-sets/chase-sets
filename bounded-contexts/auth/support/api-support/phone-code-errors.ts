import { t } from "@chase-sets/localization";
import { validationFailedResponse, type ApiErrorDetail } from "@chase-sets/http/responses";

export function missingPhoneDetail(): ApiErrorDetail {
  return {
    field: "phone",
    code: "phone_required",
    message: t("auth.support.apiSupport.phoneCodeRoutes.phone.is.required"),
  };
}

export function missingPhoneResponse() {
  const detail = missingPhoneDetail();
  return validationFailedResponse(detail.message, [detail]);
}
