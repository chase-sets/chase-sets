import type {
  TcgplayerAutomationAdmissionResult,
  TcgplayerAutomationDomainKey,
} from "../../source-observations/api/providers/tcgplayer-automation-client";

export function operatorSessionRateBudgetContext(
  admission: TcgplayerAutomationAdmissionResult | null,
  domainKey: TcgplayerAutomationDomainKey,
  usedLeases: Set<string>,
  now: number,
): "retained" | "unknown" {
  if (!admission) return "unknown";
  const admittedAt = Date.parse(admission.admittedAt);
  const notBefore = Date.parse(admission.notBefore);
  const expiresAt = Date.parse(admission.leaseExpiresAt ?? "");
  const reused = !!admission.leaseId && usedLeases.has(admission.leaseId);
  if (admission.leaseId) usedLeases.add(admission.leaseId);
  return admission.granted &&
    admission.domainKey === domainKey &&
    !!admission.leaseId?.trim() &&
    !reused &&
    Number.isSafeInteger(admission.epoch) &&
    admission.epoch >= 0 &&
    Number.isFinite(admittedAt) &&
    Number.isFinite(notBefore) &&
    Number.isFinite(expiresAt) &&
    notBefore <= admittedAt &&
    admittedAt < expiresAt &&
    now < expiresAt &&
    Number.isFinite(admission.requestDelayMs) &&
    Number.isFinite(admission.floorRequestDelayMs) &&
    admission.floorRequestDelayMs > 0 &&
    admission.requestDelayMs >= admission.floorRequestDelayMs
    ? "retained"
    : "unknown";
}
