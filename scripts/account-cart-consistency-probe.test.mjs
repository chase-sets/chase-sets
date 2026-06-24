import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_CART_PROBE_AUTOMATION_CONTRACT,
  ACCOUNT_CART_PROBE_OUTCOMES,
  ACCOUNT_CART_CONSISTENCY_PROBE_VERSION,
  assertRedactedAccountCartConsistencyEvidence,
  buildAccountCartConsistencyProbeEvidence,
  classifyAccountCartConsistencyOutcomes,
  parseAccountCartConsistencyProbeArgs,
  runAccountCartConsistencyProbe,
} from "./account-cart-consistency-probe.mjs";

const checkedAt = "2026-06-15T18:10:00.000Z";
const releaseCommit = "0123456789abcdef0123456789abcdef01234567";
const passingObservation = {
  strategy: "optimistic-with-correction",
  strategyConfigured: true,
  optimisticApplied: true,
  reconciliationObserved: true,
  staleResponseDiscarded: true,
  rollbackObserved: true,
  rollbackReasonCategory: "validation_conflict_probe",
  latencyMs: 150,
  reconciliationLatencyMs: 420,
  staleResponseAgeMs: 75,
};

describe("account cart consistency probe", () => {
  it("classifies the canonical post-write consistency outcomes", () => {
    expect(
      classifyAccountCartConsistencyOutcomes({
        strategy: "",
        strategyConfigured: false,
        optimisticApplied: true,
        freshnessTimedOut: true,
        rollbackObserved: true,
        reconciliationObserved: true,
        staleResponseDiscarded: true,
      }),
    ).toEqual(ACCOUNT_CART_PROBE_OUTCOMES);
  });

  it("builds redacted promotion evidence for account-cart optimistic reconciliation", () => {
    const evidence = buildAccountCartConsistencyProbeEvidence({
      checkedAt,
      releaseCommit,
      environment: "staging",
      routeTemplate: "/account/cart/account_01KTMF9TCCPKGA3J3TYMGGXQ2R",
      evidenceReference: "STAGING-ACCOUNT-CART-CONSISTENCY-2026-06-15",
      observation: passingObservation,
    });

    expect(evidence).toMatchObject({
      schemaVersion: ACCOUNT_CART_CONSISTENCY_PROBE_VERSION,
      checkedAt,
      releaseCommit,
      environment: "staging",
      routeTemplate: "/account/cart/:id",
      surface: "account-cart",
      strategy: "optimistic-with-correction",
      observedOutcomes: ["optimistic_applied", "rollback", "reconciliation", "stale_response_discard"],
      promotionDecision: "promote",
      blockers: [],
      latencyMs: 150,
      reconciliationLatencyMs: 420,
      staleResponseAgeMs: 75,
      rollbackReasonCategory: "validation_conflict_probe",
      telemetry: {
        metric: "chase_sets_post_write_consistency_events_total",
        requiredLabels: {
          context: "checkout",
          surface: "account-cart",
          route_id: "account-cart",
          route_template: "/account/cart/:id",
          correction_source: "fresh-read:loader-revalidation",
        },
        outcomes: ACCOUNT_CART_PROBE_OUTCOMES,
      },
      automation: ACCOUNT_CART_PROBE_AUTOMATION_CONTRACT,
      redaction: {
        accountId: "never-recorded",
        cartId: "never-recorded",
        email: "never-recorded",
        afterWrite: "never-recorded",
        fullUrls: "never-recorded",
      },
    });
    expect(assertRedactedAccountCartConsistencyEvidence(evidence)).toEqual([]);
  });

  it("aborts when required optimistic, reconciliation, and stale-discard observations are absent", () => {
    const evidence = buildAccountCartConsistencyProbeEvidence({
      checkedAt,
      releaseCommit,
      observation: {
        strategy: "optimistic-with-correction",
        optimisticApplied: false,
        reconciliationObserved: false,
        staleResponseDiscarded: false,
      },
    });

    expect(evidence.promotionDecision).toBe("abort");
    expect(evidence.blockers).toEqual([
      "Account cart probe did not observe the optimistic cart update.",
      "Account cart probe did not observe server reconciliation after the write.",
      "Account cart probe did not observe stale response discard protection.",
    ]);
  });

  it("aborts on missing strategy, freshness timeout, and unexpected rollback", () => {
    const evidence = buildAccountCartConsistencyProbeEvidence({
      checkedAt,
      releaseCommit,
      observation: {
        strategyConfigured: false,
        optimisticApplied: true,
        reconciliationObserved: true,
        staleResponseDiscarded: true,
        freshnessTimedOut: true,
        unexpectedRollback: true,
      },
    });

    expect(evidence.observedOutcomes).toEqual([
      "missing_strategy",
      "optimistic_applied",
      "freshness_timeout",
      "rollback",
      "reconciliation",
      "stale_response_discard",
    ]);
    expect(evidence.promotionDecision).toBe("abort");
    expect(evidence.blockers).toEqual([
      "Account cart mutation did not declare a post-write consistency strategy.",
      "Account cart probe observed a post-write freshness timeout.",
      "Account cart probe observed an unexpected rollback.",
    ]);
  });

  it("detects sensitive values without returning them in the evidence blocker", () => {
    const evidence = buildAccountCartConsistencyProbeEvidence({
      checkedAt,
      releaseCommit,
      observation: {
        ...passingObservation,
        note: "buyer@example.com account_123 cart_123 chk_123 afterWrite=raw-token https://marketplace.test/account/cart authorization Bearer-secret",
      },
    });

    expect(evidence.promotionDecision).toBe("abort");
    expect(evidence.blockers).toContain(
      "Observation input contains sensitive account-cart data and must be replaced with redacted evidence.",
    );
    expect(JSON.stringify(evidence.blockers)).not.toContain("buyer@example.com");
    expect(assertRedactedAccountCartConsistencyEvidence({ observation: evidence.blockers })).toEqual([]);
    expect(assertRedactedAccountCartConsistencyEvidence({ observation: { note: "buyer@example.com" } })).toEqual([
      "buyer@example.com",
    ]);
  });

  it("writes redacted evidence from an observation file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-account-cart-consistency-probe-"));
    const observationFile = join(directory, "observation.json");
    const outFile = join(directory, "evidence.json");
    await writeFile(observationFile, `${JSON.stringify(passingObservation, null, 2)}\n`);

    const evidence = await runAccountCartConsistencyProbe({
      outPath: outFile,
      observationPath: observationFile,
      checkedAt,
      releaseCommit,
      environment: "staging",
      evidenceReference: "STAGING-ACCOUNT-CART-CONSISTENCY-2026-06-15",
    });

    expect(evidence.promotionDecision).toBe("promote");
    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(evidence);
  });

  it("refuses to write evidence that still contains sensitive values", async () => {
    await expect(
      runAccountCartConsistencyProbe({
        checkedAt,
        releaseCommit,
        observe: async () => ({
          ...passingObservation,
          note: "cart_123 buyer@example.com afterWrite=raw-token",
        }),
      }),
    ).rejects.toThrow("Account-cart consistency probe evidence leaked sensitive values");
  });

  it("parses CLI and environment defaults", () => {
    const parsed = parseAccountCartConsistencyProbeArgs(["--route-template", "/account/cart"], {
      ACCOUNT_CART_CONSISTENCY_PROBE_OUT: "artifacts/account-cart-consistency.json",
      ACCOUNT_CART_CONSISTENCY_PROBE_OBSERVATION_FILE: "artifacts/account-cart-observation.json",
      ACCOUNT_CART_CONSISTENCY_PROBE_ENVIRONMENT: "staging",
      ACCOUNT_CART_CONSISTENCY_PROBE_EVIDENCE_REFERENCE: "STAGING-ACCOUNT-CART-CONSISTENCY-2026-06-15",
      RELEASE_COMMIT: releaseCommit,
    });

    expect(parsed).toMatchObject({
      outPath: "artifacts/account-cart-consistency.json",
      observationPath: "artifacts/account-cart-observation.json",
      environment: "staging",
      releaseCommit,
      evidenceReference: "STAGING-ACCOUNT-CART-CONSISTENCY-2026-06-15",
      routeTemplate: "/account/cart",
    });
  });
});
