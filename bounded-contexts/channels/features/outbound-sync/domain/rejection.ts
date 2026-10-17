import { channelPublicationRejectionCodes } from "../../publication-port/domain/contracts";
import type { OutboundOperationBudget } from "./policy";

export type InlineRejectionDisposition =
  | Readonly<{ kind: "retry"; delayMs: number; throttleProvider: boolean }>
  | Readonly<{ kind: "terminal"; reason: string }>
  | Readonly<{ kind: "indeterminate"; reason: "outcome-unknown" }>;

export function resolveInlineRejectionDisposition(
  code: unknown,
  attemptCount: number,
  budget: OutboundOperationBudget,
): InlineRejectionDisposition {
  if (!channelPublicationRejectionCodes.includes(code as never)) {
    return { kind: "indeterminate", reason: "outcome-unknown" };
  }
  if (code === "rate-limited" || code === "provider-unavailable") {
    if (attemptCount >= budget.maxAttempts) return { kind: "terminal", reason: "attempts-exhausted" };
    return {
      kind: "retry",
      delayMs: Math.min(budget.maxBackoffMs, budget.baseBackoffMs * 2 ** Math.min(attemptCount, 10)),
      throttleProvider: code === "rate-limited",
    };
  }
  switch (code) {
    case "validation":
    case "authorization":
    case "conflict":
    case "not-found":
      return { kind: "terminal", reason: code };
    default:
      return { kind: "indeterminate", reason: "outcome-unknown" };
  }
}
