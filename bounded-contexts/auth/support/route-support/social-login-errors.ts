import { t } from "@chase-sets/localization";

export const SOCIAL_LOGIN_ERROR_MESSAGES = {
  unsupported_provider: "auth.support.apiSupport.socialLoginRoutes.unsupported.provider",
  provider_not_configured: "auth.support.apiSupport.socialLoginRoutes.provider.not.configured",
  authentication_required: "auth.support.apiSupport.support.authentication.required",
  invalid_state: "auth.support.apiSupport.socialLoginRoutes.state.invalid",
  provider_failed: "auth.support.apiSupport.socialLoginRoutes.provider.failed",
  workspace_domain_required: "auth.support.apiSupport.socialLoginRoutes.admin.workspace.domain.required",
  provider_already_linked: "auth.support.apiSupport.socialLoginRoutes.provider.already.linked",
  provider_link_repair_required: "auth.support.apiSupport.socialLoginRoutes.provider.link.repair.required",
  verified_email_required: "auth.support.apiSupport.socialLoginRoutes.verified.email.required",
  admin_user_required: "auth.support.apiSupport.socialLoginRoutes.admin.user.required",
  registration_admission_required: "auth.support.apiSupport.registrationGates.registration.requires.an.invitation",
  disposable_email_domain: "auth.support.apiSupport.registrationGates.disposable.email.domains.are.not.allowed",
  registration_consent_unavailable: "auth.support.apiSupport.socialLoginRoutes.registration.consent.unavailable",
  identity_conflict: "identity.api.display.name.already.taken",
  user_unavailable: "auth.support.apiSupport.socialLoginRoutes.user.unavailable",
  admin_permission_required: "auth.support.apiSupport.socialLoginRoutes.admin.permission.required",
} as const;
export type SocialLoginErrorCode = keyof typeof SOCIAL_LOGIN_ERROR_MESSAGES;

export function socialLoginErrorMessage(value: string | null) {
  if (value === null) return null;
  return Object.hasOwn(SOCIAL_LOGIN_ERROR_MESSAGES, value)
    ? t(SOCIAL_LOGIN_ERROR_MESSAGES[value as SocialLoginErrorCode])
    : t("auth.support.apiSupport.socialLoginRoutes.state.invalid");
}
