export type { CheckoutCartLine } from "../ui/contracts";
export type { CartReadinessDecisionInput, CartReadinessSnapshot } from "../domain/readiness";

export function normalizePresentedAnonymousCartId(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized.startsWith("anon_") ? normalized : null;
}
