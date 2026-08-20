import type {
  AccountEnforcementReasonCode,
  AccountEnforcementReference,
  AccountEnforcementReversalReasonCode,
} from "@chase-sets/event-core";

export type { Account } from "../ui/contracts";

export type AccountEnforcementRequest<Reason extends string> = Readonly<{
  reason: Reason;
  reference: AccountEnforcementReference | null;
}>;

export type SuspendAccountRequest = AccountEnforcementRequest<AccountEnforcementReasonCode>;
export type ReactivateAccountRequest = AccountEnforcementRequest<AccountEnforcementReversalReasonCode>;
export type CloseAccountRequest = AccountEnforcementRequest<AccountEnforcementReasonCode>;
