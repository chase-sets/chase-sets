import type { AppendToStreamInput } from "@chase-sets/event-core/storage";

declare const admissionBrand: unique symbol;
export type AccountCapabilityAssignmentAdmission = Readonly<{
  [admissionBrand]: true;
  tenantId: string;
  administratorUserId: string;
}>;
const participants = new WeakMap<AccountCapabilityAssignmentAdmission, readonly AppendToStreamInput[]>();

/** Internal admission producer; never exported through Identity's host contract. */
export function mintAccountCapabilityAssignmentAdmission(
  tenantId: string,
  administratorUserId: string,
  inputs: readonly AppendToStreamInput[],
): AccountCapabilityAssignmentAdmission {
  const admission = Object.freeze({ tenantId, administratorUserId }) as AccountCapabilityAssignmentAdmission;
  participants.set(admission, inputs);
  return admission;
}

export function consumeAccountCapabilityAssignmentAdmission(admission: AccountCapabilityAssignmentAdmission) {
  const inputs = participants.get(admission);
  participants.delete(admission);
  if (!inputs || inputs.length !== 2)
    throw new Error("Account Capability assignment requires an administration admission.");
  return inputs;
}
