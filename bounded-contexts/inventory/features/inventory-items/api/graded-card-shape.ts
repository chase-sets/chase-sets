import { parseGradedCardSnapshot } from "@chase-sets/primitives/graded-card-snapshot";
import type { GradedCardDetails } from "../domain/domain";

export function parseGradedCardShape(value: unknown): GradedCardDetails | null {
  return parseGradedCardSnapshot(value);
}
