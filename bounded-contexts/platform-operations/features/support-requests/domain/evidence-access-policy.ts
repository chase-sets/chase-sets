import type { ResolvedActor, ResolvedActorCapabilityAssignment } from "@chase-sets/auth-context";
import type { SupportRequestState } from "./domain";

export type EvidenceAccessAction = "upload" | "download" | "audit-read" | "submit-participant" | "submit-operations";
export type EvidenceParticipation = "buyer" | "seller" | "unrelated" | "missing" | "anonymous";
export type EvidenceAccessReason =
  | "participant"
  | "any-case-grant"
  | "authentication-required"
  | "base-permission-required"
  | "case-not-found"
  | "any-case-grant-required"
  | "authority-unavailable";
export type EvidenceAccessDecision = Readonly<{
  decision: "allowed" | "denied";
  reason: EvidenceAccessReason;
  status: 200 | 401 | 403 | 404 | 503;
  participation: EvidenceParticipation;
  assignment: ResolvedActorCapabilityAssignment | null;
}>;

export function decideEvidenceAccess(
  action: EvidenceAccessAction,
  actor: ResolvedActor | null,
  state: SupportRequestState,
): EvidenceAccessDecision {
  const participation: EvidenceParticipation = !actor
    ? "anonymous"
    : !state.supportRequestId
      ? "missing"
      : actor.accountId === state.buyerAccountId
        ? "buyer"
        : actor.accountId === state.sellerAccountId
          ? "seller"
          : "unrelated";
  const assignment =
    actor?.capabilityAssignments?.find(
      (entry) =>
        entry.key === "support.evidence.any-case" &&
        /^acap_[A-Za-z0-9_-]{1,80}$/.test(entry.assignmentId) &&
        Number.isSafeInteger(entry.version) &&
        entry.version > 0,
    ) ?? null;
  const deny = (reason: EvidenceAccessReason, status: EvidenceAccessDecision["status"]): EvidenceAccessDecision => ({
    decision: "denied",
    reason,
    status,
    participation,
    assignment,
  });
  if (!actor) return deny("authentication-required", 401);
  const permission = action === "download" || action === "audit-read" ? "support.view" : "support.manage";
  if (!actor.permissions.includes(permission)) return deny("base-permission-required", 403);
  if (!state.supportRequestId) return deny("case-not-found", 404);
  const participant = participation === "buyer" || participation === "seller";
  if (action === "submit-participant") {
    return participant
      ? { decision: "allowed", reason: "participant", status: 200, participation, assignment }
      : deny("case-not-found", 404);
  }
  if (assignment) return { decision: "allowed", reason: "any-case-grant", status: 200, participation, assignment };
  if (participant && action !== "audit-read" && action !== "submit-operations") {
    return { decision: "allowed", reason: "participant", status: 200, participation, assignment };
  }
  return deny(participant ? "any-case-grant-required" : "case-not-found", participant ? 403 : 404);
}
