import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChannelSyncRun, ChannelSyncRunState } from "../../tcgplayer-csv/domain/contracts";
import { resolveManualSyncActions, type ManualSyncPanel } from "../domain/contracts";
import { ManualSyncPanelView } from "./manual-sync-panel";

describe("channels-manual-sync-design-system", () => {
  it.each([
    [null, ["Compose Staged batch", "Ingest Live export", "Ingest Staged export"]],
    ["composed", ["Clamp and download CSV"]],
    ["claimed", ["Record upload attempt", "Record validation cancellation", "Release before submission"]],
    ["awaiting-verification", ["Ingest Staged export", "Verify newer Staged snapshot"]],
    ["applied", []],
    ["validation-rejected", []],
    ["application-unknown", []],
    ["superseded", []],
    ["stale-basis", []],
    ["abandoned", []],
  ] as const)("renders the registered %s state without orphan actions", (state, labels) => {
    const markup = renderToStaticMarkup(<ManualSyncPanelView panel={panel(state)} />);
    expect(markup).toContain('data-testid="manual-sync-panel"');
    expect(markup).toContain("Inbound sales visibility is dark");
    for (const label of labels) expect(markup).toContain(label);
    if (state === "claimed") expect(markup).toContain("30m 0s");
    if (state && !["composed", "claimed", "awaiting-verification"].includes(state)) {
      expect(markup).not.toContain('type="submit"');
    }
  });

  it("renders clamp recovery as a distinct safe action and suppresses ordinary readiness", () => {
    const ready = panel("composed");
    const recovery: ManualSyncPanel = {
      ...ready,
      attentionReason: "recovery",
      actions: resolveManualSyncActions(ready.run, "recovery"),
    };

    const readyMarkup = renderToStaticMarkup(<ManualSyncPanelView panel={ready} />);
    const recoveryMarkup = renderToStaticMarkup(<ManualSyncPanelView panel={recovery} />);

    expect(readyMarkup).toContain("Ready to download");
    expect(readyMarkup).toContain("Clamp and download CSV");
    expect(readyMarkup).toContain('action="/account/channels/connection-tcg/manual-sync/download"');
    expect(readyMarkup).not.toContain('data-testid="manual-sync-recovery"');
    expect(recoveryMarkup).toContain('data-testid="manual-sync-recovery"');
    expect(recoveryMarkup).toContain("Inbound clamp recovery needs review");
    expect(recoveryMarkup).toContain("Retry inbound clamp");
    expect(recoveryMarkup).not.toContain("Ready to download");
    expect(recoveryMarkup).not.toContain("Clamp and download CSV");
  });
});

function panel(state: ChannelSyncRunState | null): ManualSyncPanel {
  const value = state ? run(state) : null;
  return {
    connection: {
      connectionId: "connection-tcg",
      providerKey: "tcgplayer",
      environment: "production",
      status: "active",
      createdAt: "2026-09-10T11:00:00.000Z",
    },
    inboundCoverage: { state: "dark", reason: "no-inbound-authority" },
    run: value,
    actions: resolveManualSyncActions(value),
    leaseCountdownMs: value ? 1_800_000 : null,
    requestedListingCount: value ? 1 : 0,
    composedListingCount: value ? 1 : 0,
    attentionReason: state === "application-unknown" ? "unknown" : state === "composed" ? "ready" : null,
  };
}

function run(state: ChannelSyncRunState): ChannelSyncRun {
  return {
    runId: "run-manual",
    revision: 2,
    sequence: 1,
    connectionId: "connection-tcg",
    providerKey: "tcgplayer",
    reservationId: "reservation-manual",
    claimant: { claimantKind: "manual", claimantId: "seller" },
    leaseExpiresAt: "2026-09-10T12:30:00Z",
    manualClaimLeasePolicySnapshot: null,
    state,
    basisSnapshotId: "snapshot-basis",
    basisSnapshotGeneration: 1,
    verificationSnapshotId: null,
    verificationSnapshotGeneration: null,
    uploadAttemptedAt: null,
    uploadFileName: null,
    importSummary: null,
    createdAt: "2026-09-10T12:00:00Z",
    updatedAt: "2026-09-10T12:00:00Z",
    membershipCompleteness: { kind: "complete", total: 1 },
    members: [],
  };
}
