export function sellListAttemptResult(
  ownerStatus: "committed" | "not-observed" = "committed",
  kind: "sell-list-line" | "sell-list-batch" = "sell-list-line",
  target = "sell-list",
) {
  return {
    schemaVersion: 1,
    kind,
    fingerprint: "a".repeat(64),
    actorBinding: { kind: "account", digest: "b".repeat(64) },
    target,
    requestHash: "c".repeat(64),
    ownerStatus,
    ...(ownerStatus === "committed"
      ? {
          vector: [
            {
              index: 0,
              command: "remove",
              outcome: "succeeded",
              lineId: "sll_1",
              status: "removed",
              version: 1,
              message: null,
            },
          ],
          commitReceipt: { eventId: "evt_attempt", globalPosition: "42" },
        }
      : {}),
  };
}
