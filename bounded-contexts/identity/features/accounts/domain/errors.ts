import { t } from "@chase-sets/localization";
import { IdentityDomainError } from "../../../support/runtime-support/common";

export const ACCOUNT_PROFILE_REQUIRED_MESSAGES = {
  name: "identity.features.accounts.errors.name.required",
  displayName: "identity.features.accounts.errors.displayName.required",
} as const;

export type AccountProfileField = keyof typeof ACCOUNT_PROFILE_REQUIRED_MESSAGES;

export class AccountProfileFieldError extends IdentityDomainError {
  readonly code = "required";

  constructor(readonly field: AccountProfileField) {
    super(t(ACCOUNT_PROFILE_REQUIRED_MESSAGES[field]));
    this.name = "AccountProfileFieldError";
  }
}
