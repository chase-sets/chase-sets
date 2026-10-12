import type { ResolvedActor } from "@chase-sets/auth-context";

export function evidenceActor(
  role: string,
  permissions: readonly string[],
  granted = false,
  accountId = "acc_buyer",
): ResolvedActor {
  return {
    sessionId: "ses_operator",
    tenantId: "tnt_identity",
    userId: "usr_operator",
    accountId,
    membershipId: "mbr_operator",
    roleKey: role,
    permissions,
    ...(granted
      ? { capabilityAssignments: [{ key: "support.evidence.any-case", assignmentId: "acap_current", version: 3 }] }
      : {}),
  };
}
