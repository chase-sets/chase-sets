import { t } from "@chase-sets/localization";
import type { NormalizedFormErrors } from "@chase-sets/design-system";
import type { RegistrationConsentRejectionCode } from "@chase-sets/identity/server";
import { AuthApiError } from "../../client";
import { missingPhoneDetail } from "../api-support/phone-code-errors";

export const AUTH_ACTION_INTENTS = [
  "password",
  "phone-code-request",
  "phone-code-consume",
  "magic-link-request",
  "magic-link-consume",
  "passkey-sign-in",
  "passkey-register",
  "invitation-accept",
  "account-selection",
] as const;
export type AuthActionIntent = (typeof AUTH_ACTION_INTENTS)[number];
const consentRejectionCodes = {
  registration_consent_not_server_minted: true,
  registration_consent_expired: true,
  registration_consent_affirmation_required: true,
} satisfies Record<RegistrationConsentRejectionCode, true>;

function isConsentRejectionCode(value: unknown) {
  return typeof value === "string" && Object.hasOwn(consentRejectionCodes, value);
}
export type AuthActionError = Readonly<{
  error: string;
  errors: NormalizedFormErrors<{ phone: string }>;
  classification: "FIELD" | "FORM" | "INDETERMINATE";
  intent: AuthActionIntent;
  method?: "password" | "phone-code" | "magic-link" | "passkey";
}>;

export function authActionIntent(value: unknown): AuthActionIntent {
  return AUTH_ACTION_INTENTS.find((intent) => intent === value) ?? "password";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function authFormFailure(
  message: string,
  intent: AuthActionIntent,
  classification: "FORM" | "INDETERMINATE" = "FORM",
): AuthActionError {
  return { error: message, intent, classification, errors: { fieldErrors: {}, formErrors: [message] } };
}

export function authApiActionError(error: AuthApiError, intent: AuthActionIntent): AuthActionError {
  const fallback = () =>
    authFormFailure(t("auth.support.routeSupport.authHost.request.failed"), intent, "INDETERMINATE");
  const body = error.body;
  const rejection = record(body) && record(body.error) ? body.error : null;
  const details = rejection?.details;
  const phone = missingPhoneDetail();
  const legacy = record(body) && typeof body.error === "string";
  if (legacy && Object.keys(body).some((key) => key !== "error")) return fallback();
  if (details !== undefined) {
    if (
      !record(body) ||
      Object.keys(body).some((key) => key !== "error") ||
      !rejection ||
      Object.keys(rejection).some((key) => !["code", "message", "details"].includes(key)) ||
      typeof rejection.message !== "string" ||
      rejection.message.length > 1024 ||
      error.status !== 400 ||
      rejection.code !== "validation_failed" ||
      (intent !== "phone-code-request" && intent !== "phone-code-consume") ||
      !Array.isArray(details) ||
      details.length !== 1
    )
      return fallback();
    const detail: unknown = details[0];
    if (
      !record(detail) ||
      Object.keys(detail).some((key) => !["field", "code", "message"].includes(key)) ||
      detail.field !== phone.field ||
      detail.code !== phone.code ||
      typeof detail.message !== "string" ||
      detail.message.length > 1024
    )
      return fallback();
    return {
      error: phone.message,
      intent,
      classification: "FIELD",
      errors: { fieldErrors: { phone: [phone.message] }, formErrors: [] },
    };
  }
  if (!legacy && !rejection) return fallback();
  if (rejection && details === undefined) {
    const permitted =
      rejection.code === "registration_admission_required"
        ? ["code", "message", "waitlistPath"]
        : rejection.code === "disposable_email_domain"
          ? ["code", "message", "waitlistPath", "domain", "mode"]
          : rejection.code === "rate_limited"
            ? ["code", "message", "surface", "retryAfterSeconds"]
            : isConsentRejectionCode(rejection.code)
              ? ["code", "message", "reason"]
              : ["code", "message"];
    if (
      !record(body) ||
      Object.keys(body).some((key) => key !== "error") ||
      Object.keys(rejection).some((key) => !permitted.includes(key)) ||
      typeof rejection.message !== "string" ||
      Object.values(rejection).some((value) =>
        typeof value === "string"
          ? value.length > 1024
          : typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 86400,
      )
    )
      return fallback();
  }
  if (error.status === 401) {
    if (rejection && rejection.code !== "authentication_required") return fallback();
    switch (intent) {
      case "password":
        return authFormFailure(t("auth.support.apiSupport.passwordRoutes.invalid.email.or.password"), intent);
      case "phone-code-consume":
        return authFormFailure(t("auth.support.apiSupport.phoneCodeRoutes.phone.code.is.invalid.or.has"), intent);
      case "magic-link-consume":
        return authFormFailure(t("auth.support.apiSupport.magicLinkRoutes.magic.link.is.invalid.or.has"), intent);
      case "account-selection":
        return authFormFailure(
          t("auth.support.apiSupport.accountSelectionRoutes.account.selection.is.invalid.or.has"),
          intent,
        );
      default:
        return authFormFailure(t("auth.support.routeSupport.authHost.request.failed"), intent);
    }
  }
  if (
    error.status === 403 &&
    (intent === "password" ||
      intent === "phone-code-request" ||
      intent === "phone-code-consume" ||
      intent === "magic-link-request" ||
      intent === "magic-link-consume" ||
      intent === "passkey-register")
  ) {
    if (rejection?.code === "registration_admission_required")
      return authFormFailure(
        t("auth.support.apiSupport.registrationGates.registration.requires.an.invitation"),
        intent,
      );
    if (rejection?.code === "disposable_email_domain")
      return authFormFailure(
        t("auth.support.apiSupport.registrationGates.disposable.email.domains.are.not.allowed"),
        intent,
      );
  }
  if (
    error.status === 400 &&
    isConsentRejectionCode(rejection?.code) &&
    ["password", "phone-code-consume", "magic-link-consume", "passkey-register", "invitation-accept"].includes(intent)
  ) {
    return authFormFailure(t("auth.support.apiSupport.socialLoginRoutes.registration.consent.unavailable"), intent);
  }
  if (error.status === 429 && (!rejection || rejection.code === "rate_limited"))
    return authFormFailure(t("auth.support.routeSupport.authHost.rate.limited"), intent);
  if (error.status === 409 && (!rejection || rejection.code === "conflict"))
    return authFormFailure(t("auth.support.routeSupport.authHost.request.failed"), intent);
  return fallback();
}
