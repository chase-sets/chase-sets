import { t } from "@chase-sets/localization";
import { IdentityDomainError } from "../../../support/runtime-support/common";

export const USER_PROFILE_REQUIRED_MESSAGES = {
  displayName: "identity.features.users.errors.displayName.required",
} as const;

export type UserProfileField = keyof typeof USER_PROFILE_REQUIRED_MESSAGES;

export class UserProfileFieldError extends IdentityDomainError {
  readonly code = "required";

  constructor(readonly field: UserProfileField) {
    super(t(USER_PROFILE_REQUIRED_MESSAGES[field]));
    this.name = "UserProfileFieldError";
  }
}
