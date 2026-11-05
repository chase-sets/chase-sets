import { renderToStaticMarkup } from "react-dom/server";
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type ActionFunctionArgs } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ChannelSyncRun, ChannelSyncRunState } from "../../tcgplayer-csv/domain/contracts";
import { resolveManualSyncActions, type ManualSyncPanel } from "../domain/contracts";
import { ManualSyncPanelView } from "./manual-sync-panel";

describe("channels-manual-sync-design-system", () => {
  it("manual sync busies only the submitted form and suppresses a second submit", async () => {
    let release!: () => void;
    const pending = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    const action = vi.fn(async (_args: ActionFunctionArgs) => pending);
    const router = createMemoryRouter(
      [
        {
          path: "/",
          action,
          Component: () => <ManualSyncPanelView panel={{ ...panel(null), actions: ["compose"] }} />,
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    const button = screen.getByRole("button", { name: "Compose Staged batch" });
    fireEvent.submit(button.closest("form")!);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(button.closest("form")?.getAttribute("aria-busy")).toBe("true");
    expect(button.matches(":disabled")).toBe(false);
    fireEvent.submit(button.closest("form")!);
    expect(action).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    router.dispose();
  });

  it("replaces the dark banner with live coverage without clearing clamp recovery", () => {
    const current = panel("composed");
    const markup = markupOf({
      ...current,
      inboundCoverage: { state: "live", reason: null },
      attentionReason: "recovery",
      actions: ["retry-clamp"],
    });
    expect(markup).toContain("Inbound sales visibility is live");
    expect(markup).not.toContain("Inbound sales visibility is dark");
    expect(markup).toContain("Inbound clamp recovery needs review");
    expect(markup).toContain("Retry inbound clamp");
    expect(markup).not.toContain("Clamp and download CSV");
  });

  it.each([
    ["no-inbound-authority", "No paired connector currently authorizes inbound data."],
    ["inbound-authority-revoked", "inbound authorization has ended"],
    ["provider-has-no-inbound", "This provider does not support inbound coverage."],
    ["inbound-authority-failing", "Inbound authorization is failing."],
  ] as const)("renders the closed dark reason %s", (reason, description) => {
    const markup = markupOf({ ...panel(null), inboundCoverage: { state: "dark", reason } });
    expect(markup).toContain(description);
    expect(markup).not.toContain("Inbound sales visibility is live");
  });

  const noRunLabels = ["Compose Staged batch", "Ingest Live export", "Ingest Staged export"];
  const runLabels = [
    "Clamp and download CSV",
    "Retry inbound clamp",
    "Record upload attempt",
    "Record validation cancellation",
    "Release before submission",
    "Verify newer Staged snapshot",
  ];

  it.each([
    [null, noRunLabels],
    ["composed", ["Clamp and download CSV"]],
    ["claimed", ["Record upload attempt", "Record validation cancellation", "Release before submission"]],
    ["awaiting-verification", ["Ingest Staged export", "Verify newer Staged snapshot"]],
    ["applied", noRunLabels],
    ["validation-rejected", noRunLabels],
    ["application-unknown", noRunLabels],
    ["superseded", noRunLabels],
    ["stale-basis", noRunLabels],
    ["abandoned", noRunLabels],
  ] as const)("renders the registered %s state without orphan actions", (state, labels) => {
    const current = panel(state);
    const markup = markupOf(
      state === "awaiting-verification" ? { ...current, verificationCandidate: candidate() } : current,
    );
    expect(markup).toContain('data-testid="manual-sync-panel"');
    expect(markup).toContain("Inbound sales visibility is dark");
    for (const label of labels) expect(markup).toContain(label);
    for (const label of runLabels.filter((label) => !(labels as readonly string[]).includes(label))) {
      expect(markup).not.toContain(label);
    }
    if (state === "claimed") expect(markup).toContain("30m 0s");
  });

  it.each(["composed", "claimed", "awaiting-verification"] as const)(
    "manual-sync-lease-facts: the active %s run shows the verbatim lease expiry beside its countdown",
    (state) => {
      const current = panel(state);
      const uploaded = state === "awaiting-verification";
      const markup = markupOf({
        ...current,
        run: { ...current.run!, uploadAttemptedAt: uploaded ? "2026-09-10T12:05:07.123Z" : null },
      });
      expect(leaseFacts(markup)).toEqual(
        uploaded
          ? [
              ["Lease expires", "2026-09-10T12:30:00Z"],
              ["Upload attempted", "2026-09-10T12:05:07.123Z"],
            ]
          : [["Lease expires", "2026-09-10T12:30:00Z"]],
      );
      expect(markup).toContain("Lease remaining");
      expect(markup).toContain("30m 0s");
    },
  );

  it.each(["applied", "validation-rejected", "application-unknown", "superseded", "stale-basis", "abandoned"] as const)(
    "manual-sync-lease-facts: the terminal %s run shows its lease facts and no countdown",
    (state) => {
      const current = panel(state);
      const uploaded = state === "applied" || state === "application-unknown";
      const markup = markupOf({
        ...current,
        run: { ...current.run!, uploadAttemptedAt: uploaded ? "2026-09-10T12:05:07.123Z" : null },
      });
      expect(leaseFacts(markup)).toEqual(
        uploaded
          ? [
              ["Lease expires", "2026-09-10T12:30:00Z"],
              ["Upload attempted", "2026-09-10T12:05:07.123Z"],
            ]
          : [["Lease expires", "2026-09-10T12:30:00Z"]],
      );
      expect(markup).not.toContain("Lease remaining");
      expect(markup).not.toContain("30m 0s");
    },
  );

  it("manual-sync-lease-facts: no run shows Not claimed and no lease facts", () => {
    const markup = markupOf(panel(null));
    expect(markup).toContain("Not claimed");
    expect(leaseFacts(markup)).toEqual([]);
  });

  it("manual-sync-verify-bound-snapshot: binds the read-model snapshot in a hidden field with no typed ID", () => {
    const markup = markupOf({ ...panel("awaiting-verification"), verificationCandidate: candidate() });
    const fields = [...markup.matchAll(/<input[^>]*name="verificationSnapshotId"[^>]*>/g)].map((match) => match[0]);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toContain('type="hidden"');
    expect(fields[0]).toContain('value="cis_candidate_7"');
    expect(markup).not.toContain("Verification snapshot ID");
    expect(verifyFacts(markup)).toEqual([
      ["Staged snapshot", "cis_candidate_7"],
      ["Captured", "2026-09-10T12:06:00.000Z"],
      ["Rows", "42"],
    ]);
    expect(markup).toContain("Verify newer Staged snapshot");
  });

  it("manual-sync-verify-bound-snapshot: without a candidate shows guidance and no Verify submit", () => {
    const markup = markupOf(panel("awaiting-verification"));
    expect(markup).toContain("Ingest a Staged export to verify");
    expect(markup).not.toContain('name="verificationSnapshotId"');
    expect(markup).not.toContain("Verify newer Staged snapshot");
    expect(markup).not.toContain('value="verify"');
    expect(markup).toContain("Ingest Staged export");
  });

  it("renders clamp recovery as a distinct safe action and suppresses ordinary readiness", () => {
    const ready = panel("composed");
    const recovery: ManualSyncPanel = {
      ...ready,
      attentionReason: "recovery",
      actions: resolveManualSyncActions(ready.run, "recovery"),
    };

    const readyMarkup = markupOf(ready);
    const recoveryMarkup = markupOf(recovery);

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

function markupOf(value: ManualSyncPanel) {
  const router = createMemoryRouter([{ path: "/", Component: () => <ManualSyncPanelView panel={value} /> }]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

function panel(state: ChannelSyncRunState | null): ManualSyncPanel {
  const value = state ? run(state) : null;
  return {
    connection: {
      connectionId: "connection-tcg",
      providerKey: "tcgplayer",
      environment: "production",
      status: "active",
      createdAt: "2026-09-10T11:00:00.000Z",
      allowedActions: ["pause", "disconnect"],
    },
    inboundCoverage: { state: "dark", reason: "no-inbound-authority" },
    run: value,
    actions: resolveManualSyncActions(value),
    leaseCountdownMs: value ? 1_800_000 : null,
    requestedListingCount: value ? 1 : 0,
    composedListingCount: value ? 1 : 0,
    attentionReason: state === "application-unknown" ? "unknown" : state === "composed" ? "ready" : null,
    verificationCandidate: null,
  };
}

function candidate() {
  return {
    snapshotId: "cis_candidate_7",
    snapshotGeneration: 7,
    parsedRowCount: 42,
    capturedAt: "2026-09-10T12:06:00.000Z",
    ingestedAt: "2026-09-10T12:06:30.000Z",
  };
}

function leaseFacts(markup: string) {
  return definitionPairs(markup, "manual-sync-lease-facts");
}

function verifyFacts(markup: string) {
  return definitionPairs(markup, "manual-sync-verify-snapshot");
}

function definitionPairs(markup: string, testId: string): string[][] {
  const list = new RegExp(`<dl[^>]*data-testid="${testId}"[^>]*>(.*?)</dl>`).exec(markup)?.[1];
  if (!list) return [];
  return [...list.matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map((match) => [match[1]!, match[2]!]);
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
