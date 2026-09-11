import type { OutboundSyncServices } from "../domain/contracts";

export function createUnavailableOutboundSyncServices(): OutboundSyncServices {
  const unavailable = async (): Promise<never> => {
    throw new Error("not reached");
  };
  return {
    enqueueDesiredState: unavailable,
    reserveClaimedOutboundOperations: unavailable,
    reportClaimedOperationOutcomes: unavailable,
    clearOutboundOperationLane: unavailable,
    readOutboundOperationLog: unavailable,
    readOutboundOperationSummary: unavailable,
    processNextInlineOperation: unavailable,
    recoverExpiredClaimedOperations: unavailable,
  };
}
