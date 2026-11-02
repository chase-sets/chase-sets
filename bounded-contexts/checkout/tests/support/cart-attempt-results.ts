import type {
  CheckoutCartAttemptKind,
  CheckoutCartLineOutcome,
  CheckoutCommandAttemptResult,
} from "../../features/command-attempts/api/contracts";

type LineFixture = Readonly<{
  command: CheckoutCartLineOutcome["command"];
  lineId: string | null;
  outcome?: CheckoutCartLineOutcome["outcome"];
  status?: CheckoutCartLineOutcome["status"];
  message?: string | null;
}>;

const STATUS_FOR_COMMAND: Record<CheckoutCartLineOutcome["command"], NonNullable<CheckoutCartLineOutcome["status"]>> = {
  add: "added",
  quantity: "quantity-updated",
  fulfillment: "fulfillment-updated",
  remove: "removed",
  checkout: "checked-out",
};

/** A closed owner result the client resolver accepts; digests are synthetic fixed hex. */
export function cartAttemptResult(
  ownerStatus: CheckoutCommandAttemptResult["ownerStatus"],
  options: Readonly<{
    kind?: CheckoutCartAttemptKind;
    lines?: readonly LineFixture[];
    receipt?: Readonly<{ eventId: string; globalPosition: string }>;
    reason?: CheckoutCommandAttemptResult["reason"];
  }> = {},
): CheckoutCommandAttemptResult {
  return {
    schemaVersion: 1,
    kind: options.kind ?? "cart.commands",
    fingerprint: "a".repeat(64),
    actorBinding: { kind: "account", digest: "b".repeat(64) },
    target: "cart",
    requestHash: "c".repeat(64),
    ownerStatus,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.lines
      ? {
          vector: options.lines.map((line, index) => {
            const outcome = line.outcome ?? "succeeded";
            return {
              index,
              command: line.command,
              outcome,
              lineId: line.lineId,
              status: outcome === "succeeded" ? (line.status ?? STATUS_FOR_COMMAND[line.command]) : null,
              version: 1,
              message: line.message ?? null,
            };
          }),
        }
      : {}),
    ...(options.receipt ? { commitReceipt: options.receipt } : {}),
  };
}

/** A committed owner result where every line applied. */
export function committedCartAttempt(
  lines: readonly LineFixture[],
  receipt?: Readonly<{ eventId: string; globalPosition: string }>,
  kind?: CheckoutCartAttemptKind,
) {
  return cartAttemptResult("committed", { lines, receipt, kind });
}
