import { CommercialTermsDomainError } from "../../../support/runtime-support/common";

export function normalizeAgreementAccountIdText(value: unknown) {
  const accountId = typeof value === "string" ? value.trim() : "";
  if (!accountId.startsWith("acc_")) {
    throw new CommercialTermsDomainError("Account ID must start with acc_.");
  }

  return accountId;
}
