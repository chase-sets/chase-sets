import { parseCartReadinessDecisionInput } from "../domain/readiness";

export function parseCheckoutStartCartReadinessDecisions(value: unknown) {
  return parseCartReadinessDecisionInput(value);
}
