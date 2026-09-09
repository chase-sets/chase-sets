import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  BoundClaimedReservationRun,
  ClaimedOperationClaimant,
  ClaimedReservationRunSettlementPort,
} from "../../outbound-sync/domain/contracts";
import { deriveClaimedOperationOutcomes } from "../domain/lifecycle";
import type { ChannelSyncRun } from "../domain/contracts";
import { readChannelSyncRunByReservation } from "../read-model/queries";

export function createTcgplayerClaimedReservationRunSettlementPort(): ClaimedReservationRunSettlementPort {
  return {
    lockBoundRun: async (transaction, input) => {
      const run = await readChannelSyncRunByReservation(transaction, input.reservationId, true);
      if (!run) return null;
      if (input.runId !== undefined && run.runId !== input.runId) return null;
      if (input.expectedRunRevision !== undefined && run.revision !== input.expectedRunRevision) return null;
      return toBoundRun(run);
    },
    settleBoundRun: async (transaction, input) => {
      const result = await transaction.query(
        `UPDATE channel_sync_runs
         SET state=$4, revision=revision+1, updated_at=clock_timestamp()
         WHERE run_id=$1 AND revision=$2 AND state=$3`,
        [input.runId, input.expectedRunRevision, input.fromState, input.toState],
      );
      if (result.rowCount !== 1) throw new Error("Channel Sync Run settlement fence is stale.");
    },
  };
}

function toBoundRun(run: ChannelSyncRun): BoundClaimedReservationRun {
  return {
    runId: run.runId,
    revision: run.revision,
    reservationId: run.reservationId,
    state: terminalOrCurrent(run.state),
    submitMayHaveOccurred: run.state === "awaiting-verification",
    uploadAttemptedAt: run.uploadAttemptedAt,
    claimant: run.claimant,
    outcomes: deriveClaimedOperationOutcomesForSettlement(run),
  };
}

function deriveClaimedOperationOutcomesForSettlement(run: ChannelSyncRun) {
  if (run.state === "composed" || run.state === "claimed") {
    return deriveClaimedOperationOutcomes({ ...run, state: "abandoned" });
  }
  if (run.state === "awaiting-verification") {
    return deriveClaimedOperationOutcomes({ ...run, state: "application-unknown" });
  }
  return deriveClaimedOperationOutcomes(run);
}

function terminalOrCurrent(state: ChannelSyncRun["state"]): BoundClaimedReservationRun["state"] {
  if (state === "composed" || state === "claimed" || state === "awaiting-verification") return state;
  return "terminal";
}

export type TcgplayerClaimedReservationRunSettlementDependencies = Readonly<{
  db: PgQueryable;
  claimant: ClaimedOperationClaimant;
}>;
