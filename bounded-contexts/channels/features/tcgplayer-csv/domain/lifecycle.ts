import type { ClaimedOperationOutcome } from "../../outbound-sync/domain/contracts";
import {
  ChannelSyncRunError,
  channelSyncRunTerminalStates,
  type ChannelSyncRun,
  type ChannelSyncRunState,
  type ChannelSyncRunTrigger,
  type TcgplayerImportSummary,
} from "./contracts";
import { tcgplayerExternalListingId } from "./composition";

export type ChannelSyncRunTransition = Readonly<{
  from: ChannelSyncRunState;
  trigger: ChannelSyncRunTrigger;
  to: ChannelSyncRunState;
}>;

export const channelSyncRunTransitions: readonly ChannelSyncRunTransition[] = Object.freeze([
  { from: "composed", trigger: "claim", to: "claimed" },
  { from: "composed", trigger: "supersede", to: "superseded" },
  { from: "composed", trigger: "observe-newer-basis", to: "stale-basis" },
  { from: "composed", trigger: "reservation-lease-expired", to: "abandoned" },
  { from: "claimed", trigger: "report-upload-attempted", to: "awaiting-verification" },
  { from: "claimed", trigger: "report-validation-cancelled", to: "validation-rejected" },
  { from: "claimed", trigger: "release", to: "abandoned" },
  { from: "claimed", trigger: "observe-newer-basis", to: "stale-basis" },
  { from: "claimed", trigger: "reservation-lease-expired", to: "abandoned" },
  { from: "awaiting-verification", trigger: "verify", to: "applied" },
  { from: "awaiting-verification", trigger: "reservation-lease-expired", to: "application-unknown" },
]);

export function decideChannelSyncRunTransition(
  state: ChannelSyncRunState,
  trigger: ChannelSyncRunTrigger,
  options: Readonly<{ verificationMatched?: boolean }> = {},
): ChannelSyncRunState {
  if (channelSyncRunTerminalStates.includes(state as never)) throw new ChannelSyncRunError("terminal");
  if (trigger === "compose") throw new ChannelSyncRunError("illegal-transition");
  if (trigger === "report-upload-attempted" && state === "composed") {
    throw new ChannelSyncRunError("no-attempt-outstanding");
  }
  const transition = channelSyncRunTransitions.find(
    (candidate) => candidate.from === state && candidate.trigger === trigger,
  );
  if (!transition) throw new ChannelSyncRunError("illegal-transition");
  if (state === "awaiting-verification" && trigger === "verify" && options.verificationMatched !== true) {
    return "application-unknown";
  }
  return transition.to;
}

export function deriveClaimedOperationOutcomes(run: ChannelSyncRun): readonly ClaimedOperationOutcome[] {
  if (run.membershipCompleteness.kind !== "complete") {
    throw new ChannelSyncRunError("stale-fence", "Incomplete run membership cannot be acknowledged.");
  }
  if (!channelSyncRunTerminalStates.includes(run.state as never)) {
    throw new ChannelSyncRunError("illegal-transition", "A non-terminal run cannot settle its reservation.");
  }
  return run.members.map((member) => {
    const fence = {
      operationId: member.operationId,
      attemptId: member.attemptId,
      claimGeneration: member.claimGeneration,
      desiredStateSequence: member.desiredStateSequence,
    };
    if (member.memberKind === "refused") {
      return { ...fence, outcome: { kind: "rejected", code: "validation" } };
    }
    if (member.memberKind === "already-satisfied") {
      return {
        ...fence,
        outcome: {
          kind: "applied",
          result: {
            kind: "succeeded",
            externalListingId: tcgplayerExternalListingId(member.externalKey, member.conditionText),
          },
        },
      };
    }
    switch (run.state) {
      case "applied":
        return {
          ...fence,
          outcome: {
            kind: "applied",
            result: {
              kind: "succeeded",
              externalListingId: tcgplayerExternalListingId(member.externalKey, member.conditionText),
            },
          },
        };
      case "validation-rejected":
        return { ...fence, outcome: { kind: "rejected", code: "validation" } };
      case "application-unknown":
        return { ...fence, outcome: { kind: "outcome-unknown" } };
      case "superseded":
      case "stale-basis":
        return { ...fence, outcome: { kind: "abandoned", reason: "superseded-basis" } };
      case "abandoned":
        return { ...fence, outcome: { kind: "abandoned", reason: "released" } };
      case "composed":
      case "claimed":
      case "awaiting-verification":
        throw new ChannelSyncRunError("illegal-transition", "A non-terminal run cannot be acknowledged.");
      default:
        return assertNever(run.state);
    }
  });
}

export function applicationMatchesSnapshot(
  run: ChannelSyncRun,
  verification: Readonly<{
    snapshotGeneration: number;
    rows: readonly Readonly<{
      externalKey: string;
      conditionText: string | null;
      totalQuantity: number;
      priceAmountMinor: number | null;
    }>[];
  }>,
): boolean {
  if (run.membershipCompleteness.kind !== "complete") return false;
  if (verification.snapshotGeneration <= run.basisSnapshotGeneration) return false;
  const rows = new Map(verification.rows.map((row) => [`${row.externalKey}\u0000${row.conditionText ?? ""}`, row]));
  return run.members.every((member) => {
    if (member.memberKind !== "composed") return true;
    const row = rows.get(`${member.externalKey}\u0000${member.conditionText ?? ""}`);
    return (
      row !== undefined &&
      row.totalQuantity === member.targetQuantity &&
      row.priceAmountMinor !== null &&
      row.priceAmountMinor === member.targetPriceAmountMinor
    );
  });
}

export function applicationMatchesImportSummary(run: ChannelSyncRun, summary: TcgplayerImportSummary): boolean {
  if (summary.fileName.length === 0 || summary.fileName.length > 256) return false;
  if (summary.dateImportedText.length === 0 || summary.dateImportedText.length > 256) return false;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(summary.recordedAt) || Number.isNaN(Date.parse(summary.recordedAt))) return false;
  if (
    !Number.isSafeInteger(summary.numberOfProducts) ||
    summary.numberOfProducts < 0 ||
    summary.numberOfProducts > 1_000_000
  ) {
    return false;
  }
  const composedCount = run.members.filter((member) => member.memberKind === "composed").length;
  return summary.fileName === run.uploadFileName && summary.numberOfProducts === composedCount;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Channel Sync Run state '${String(value)}'.`);
}
