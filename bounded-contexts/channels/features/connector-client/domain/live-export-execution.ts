import type { ClaimedLiveExportOutcome } from "../../outbound-sync/domain/live-export-codec";
import {
  assertLiveExportHandoffTransition,
  parseLiveExportHandoff,
  type LiveExportHandoff,
} from "./live-export-handoff";
import { OperationProtocolError, refuse, type LiveExportAttempt } from "./operation-protocol";

export type LiveExportExecution = ReturnType<typeof createLiveExportExecution>;
type Ports = Readonly<{
  current(): LiveExportAttempt;
  save(handoff: LiveExportHandoff): Promise<void>;
  fence(): Promise<boolean>;
  post(body: string, signal: AbortSignal): Promise<Response>;
  now(): number;
  signal: AbortSignal;
}>;

/** Coordinator-owned custody for one claimed export: every side effect re-checks the journal fence and lease. */
export function createLiveExportExecution(ports: Ports) {
  const guard = async () => {
    const member = ports.current();
    if (
      ports.signal.aborted ||
      !(await ports.fence()) ||
      !["dispatched", "outcome-unknown"].includes(member.state) ||
      ports.now() >= Date.parse(member.leaseExpiresAt)
    )
      throw new OperationProtocolError("stale-fence");
    return member;
  };
  return {
    guard: async (): Promise<void> => {
      await guard();
    },
    save: async (handoff: LiveExportHandoff): Promise<void> => {
      const member = await guard();
      const next = parseLiveExportHandoff(handoff, member.payload);
      if (member.handoff) assertLiveExportHandoffTransition(member.handoff, next);
      else if (next.post.state !== "planned") refuse();
      await ports.save(next);
    },
    post: async (body: string, signal: AbortSignal): Promise<Response> => {
      const member = await guard();
      if (member.handoff?.post.state !== "dispatched") refuse();
      return ports.post(body, AbortSignal.any([ports.signal, signal]));
    },
  };
}

export function liveExportOutcome(
  member: LiveExportAttempt,
  outcome: ClaimedLiveExportOutcome["outcome"],
): ClaimedLiveExportOutcome {
  return {
    operationKind: member.operationKind,
    operationId: member.operationId,
    attemptId: member.attemptId,
    claimGeneration: member.claimGeneration,
    exportId: member.payload.exportId,
    payloadDigest: member.payloadDigest,
    outcome,
  };
}
