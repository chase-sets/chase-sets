import { normalizeCommercialAccountId } from "../../../support/runtime-support/common";

export function normalizeAgreementAccountIdText(value: unknown) {
  return normalizeCommercialAccountId(value);
}
