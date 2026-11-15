import { describe, expect, it } from "vitest";
import {
  applicationMatchesSnapshot,
  applicationMatchesImportSummary,
  decideChannelSyncRunTransition,
  deriveClaimedOperationOutcomes,
} from "../domain/lifecycle";
import { readbackLaw } from "./readback-mutants";
import { channelSyncRunTriggers } from "../domain/contracts";
import { readbackRun, readbackSettlement, readbackSummary } from "./readback-test-support";
const assertChannelSyncRunSettlement = readbackLaw();

describe("tcgplayer-run-law-readback-verdict", () => {
  it("accepts only a matching applied verdict; a summary is optional corroboration", () => {
    for (const importSummary of [null, readbackSummary]) {
      expect(() =>
        assertChannelSyncRunSettlement(readbackRun(), { ...readbackSettlement(), importSummary }),
      ).not.toThrow();
    }
  });
  it.each([
    ["summary-only", { stagedReadback: null, importSummary: readbackSummary }],
    ["missing-verdict", { stagedReadback: null }],
    ["wrong-count", { stagedReadback: { kind: "applied", counts: { preRows: 1, postRows: 1, members: 0 } } }],
    ["basis-diverged", { stagedReadback: { kind: "basis-diverged", counts: { preRows: 1, postRows: 1, members: 1 } } }],
    ["snapshot-id", { verificationSnapshotId: "snapshot-other", verificationSnapshotGeneration: 2 }],
    ["snapshot-generation", { verificationSnapshotGeneration: 2 }],
    ["summary-mismatch", { importSummary: { ...readbackSummary, numberOfProducts: 2 } }],
    [
      "unknown-as-applied",
      {
        stagedReadback: {
          kind: "outcome-unknown",
          reason: "non-member-drift",
          counts: { preRows: 1, postRows: 1, members: 1 },
        },
      },
    ],
  ] as const)("refuses %s", (_name, patch) => {
    expect(() => assertChannelSyncRunSettlement(readbackRun(), { ...readbackSettlement(), ...patch })).toThrow();
  });
  it("requires an upload attempt, and never accepts basis divergence as unknown", () => {
    expect(() =>
      assertChannelSyncRunSettlement({ ...readbackRun(), uploadAttemptedAt: null }, readbackSettlement()),
    ).toThrow();
    expect(() =>
      assertChannelSyncRunSettlement(readbackRun(), {
        ...readbackSettlement(),
        toState: "application-unknown",
        stagedReadback: { kind: "basis-diverged", counts: { preRows: 1, postRows: 1, members: 1 } },
      }),
    ).toThrow();
  });
  it("settles unknown and pre-upload refusal, without conflating them", () => {
    expect(() =>
      assertChannelSyncRunSettlement(readbackRun(), {
        ...readbackSettlement(),
        toState: "application-unknown",
        stagedReadback: {
          kind: "outcome-unknown",
          reason: "non-member-drift",
          counts: { preRows: 1, postRows: 1, members: 1 },
        },
      }),
    ).not.toThrow();
    const run = { ...readbackRun(), state: "claimed" as const, uploadAttemptedAt: null, uploadFileName: null };
    const input = {
      ...readbackSettlement(),
      fromState: "claimed" as const,
      toState: "validation-rejected" as const,
      stagedReadback: null,
    };
    expect(() => assertChannelSyncRunSettlement(run, input)).not.toThrow();
    expect(() =>
      assertChannelSyncRunSettlement(run, { ...input, stagedReadback: readbackSettlement().stagedReadback }),
    ).toThrow();
  });
  it("counts the composed partition, not all members, and leaves paused claims to lease expiry", () => {
    const run = readbackRun();
    const member = run.members[0]!;
    if (member.memberKind !== "composed") throw new Error("missing-synthetic-composed-member");
    const mixed = {
      ...run,
      membershipCompleteness: { kind: "complete" as const, total: 2 },
      members: [
        member,
        {
          ...member,
          operationId: "operation-noop",
          memberKind: "already-satisfied" as const,
          csvRow: null,
          providerAction: "not-attempted-already-satisfied" as const,
        },
      ],
    };
    expect(() => assertChannelSyncRunSettlement(mixed, readbackSettlement())).not.toThrow();
    expect(() =>
      assertChannelSyncRunSettlement(mixed, {
        ...readbackSettlement(),
        stagedReadback: { kind: "applied", counts: { preRows: 2, postRows: 2, members: 2 } },
      }),
    ).toThrow();
    const paused = { ...run, state: "claimed" as const, uploadAttemptedAt: null, uploadFileName: null };
    const expiry = {
      ...readbackSettlement(),
      fromState: "claimed" as const,
      toState: "abandoned" as const,
      stagedReadback: null,
    };
    expect(() => assertChannelSyncRunSettlement(paused, expiry, { leaseExpired: true })).not.toThrow();
    expect(() => assertChannelSyncRunSettlement(paused, { ...readbackSettlement(), fromState: "claimed" })).toThrow();
  });
});

describe("tcgplayer-run-law-route-isolation", () => {
  const verification = {
    snapshotGeneration: 2,
    rows: [{ externalKey: "product:90000001", conditionText: null, totalQuantity: 2, priceAmountMinor: 100 }],
  };
  const manual = { ...readbackRun(), claimant: { claimantKind: "manual" as const, claimantId: "manual-synthetic" } };
  const settlement = {
    ...readbackSettlement(),
    stagedReadback: null,
    verificationSnapshotId: "snapshot-verification",
    verificationSnapshotGeneration: 2,
    importSummary: readbackSummary,
  };
  it("keeps manual snapshot plus summary as its only applied path", () => {
    expect(() => assertChannelSyncRunSettlement(manual, settlement)).not.toThrow();
    const verify = (snapshot: typeof verification, summary: typeof readbackSummary) =>
      decideChannelSyncRunTransition(manual.state, "verify", {
        verificationMatched:
          applicationMatchesSnapshot(manual, snapshot) && applicationMatchesImportSummary(manual, summary),
      });
    expect(verify(verification, readbackSummary)).toBe("applied");
    expect(verify({ ...verification, snapshotGeneration: 1 }, readbackSummary)).toBe("application-unknown");
    expect(verify(verification, { ...readbackSummary, numberOfProducts: 2 })).toBe("application-unknown");
  });
  it("refuses both cross-route proofs", () => {
    expect(() => assertChannelSyncRunSettlement(manual, readbackSettlement())).toThrow();
    expect(() => assertChannelSyncRunSettlement(readbackRun(), settlement)).toThrow();
  });
});

describe("tcgplayer-run-law-readback-day-after", () => {
  it.each(["applied", "application-unknown", "validation-rejected"] as const)("never leaves %s", (state) => {
    const run = { ...readbackRun(), state };
    for (const trigger of channelSyncRunTriggers)
      expect(() => decideChannelSyncRunTransition(state, trigger)).toThrow("terminal");
    expect(() => assertChannelSyncRunSettlement(run, readbackSettlement())).toThrow("terminal");
    expect(deriveClaimedOperationOutcomes(run)[0]?.outcome.kind).toBe(
      state === "applied" ? "applied" : state === "application-unknown" ? "outcome-unknown" : "rejected",
    );
  });
});
