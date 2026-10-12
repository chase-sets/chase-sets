import {
  closedObject,
  parseParticipantAttempt,
  participantAction,
  type SupportParticipantDescriptor,
} from "../../features/support-requests/domain/participant-attempt";

export type ParticipantRouteRecovery = Readonly<{
  phase: "failed-safe" | "ambiguous";
  descriptor: SupportParticipantDescriptor | null;
  accountId: string;
  tenantId: string;
}>;

export function participantActorMatches(form: FormData, actor: Readonly<{ accountId: string; tenantId: string }>) {
  return (
    (!form.get("participantAccountId") || form.get("participantAccountId") === actor.accountId) &&
    (!form.get("participantTenantId") || form.get("participantTenantId") === actor.tenantId)
  );
}
export function readParticipantRecovery(
  form: FormData,
  actor: Readonly<{ accountId: string; tenantId: string }>,
): ParticipantRouteRecovery | null {
  const encoded = form.get("participantRecovery");
  if (!encoded) return null;
  if (typeof encoded !== "string" || encoded.length > 1024) throw new Error("Invalid support recovery");
  const b = closedObject(JSON.parse(encoded), ["phase", "descriptor", "accountId", "tenantId"]);
  if (
    Object.keys(b).length !== 4 ||
    b.phase !== "ambiguous" ||
    b.accountId !== actor.accountId ||
    b.tenantId !== actor.tenantId
  )
    throw new Error("Support recovery owner changed");
  const d = closedObject(b.descriptor, ["actionKind", "targetId", "attemptId", "requestHash"]);
  const actionKind = participantAction(String(d.actionKind));
  const attempt = parseParticipantAttempt({ attemptId: d.attemptId, requestHash: d.requestHash });
  if (
    Object.keys(d).length !== 4 ||
    (actionKind === "open-support-request"
      ? d.targetId !== null
      : typeof d.targetId !== "string" || !/^sup_[A-Za-z0-9_-]{1,80}$/.test(d.targetId))
  )
    throw new Error("Invalid support recovery target");
  const descriptor: SupportParticipantDescriptor = { ...attempt, actionKind, targetId: d.targetId as string | null };
  return { phase: "ambiguous", descriptor, accountId: actor.accountId, tenantId: actor.tenantId };
}
