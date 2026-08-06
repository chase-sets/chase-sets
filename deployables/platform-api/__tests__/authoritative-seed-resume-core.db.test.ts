import { countEventsWithPrefix, loadSubscriptionCheckpoint } from "@chase-sets/bounded-context-runtime";
import { seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import { describe, expect, it } from "vitest";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import { createPlatformApiBootstrapTestHarness, RETAINED_STATE_HANDOFF_ERROR } from "./bootstrap-db-test-support";
import {
  activeContextRelationCounts,
  assignAuthoritativeSeedResumeState,
  capturePublicPresenceSeedOutput,
  createHost,
  deriveProfileUniverse,
  describePromoSchemaParity,
  eligiblePrefixCounts,
  eligibleScenarioSeedContexts,
  executableProfileUniverse,
  expectZeroRelationCaseEntry,
  formatUniverse,
  frozenEligibleScenarioSeedContexts,
  frozenInspectingSeedContexts,
  frozenNonInspectingSeedContexts,
  frozenProfileDiagnostics,
  HOST_NAME,
  ordinaryBoot,
  payoutsMissingFromStreams,
  policyDocumentStreamPrefix,
  pools,
  PREDECESSOR_REAUTHOR_ERROR,
  predecessorEmptyProjectionSeedDecision,
  type ProfileUniverse,
  promoFrozenMismatches,
  promoIdAndOrderMismatches,
  promoSchemaParityViolations,
  publicPresenceActivePolicyCount,
  publicPresenceBetaWavePolicyKey,
  publicPresenceBetaWavePolicyRow,
  publicPresencePolicyDocumentStreams,
  publicPresencePromoRows,
  publicPresencePromoTableColumns,
  publicPresenceSeedPromoIds,
  registryContextNames,
  repeatSameBootSeedLifecyclePoint,
  RETAINED_STATE_PHASE_TWO_CASE,
  retainedStatePhaseHandoff,
  seededPayoutIds,
  seedOptions,
  SETTLEMENT_PAYOUT_PROJECTION_NAME,
  settlementPaymentSourceRows,
  settlementPayoutCheckpointKey,
  settlementPayoutPageIds,
  settlementSeedCompletedPayoutId,
  settlementSeedPrerequisitePaymentId,
  withLaggingSettlementPayoutProjection,
} from "./authoritative-seed-resume-test-support";

/**
 * Core scenario-seed boot truth for the authoritative seed-resume partition:
 * the derived seed universe, the retained-state two-phase boot, and the
 * Settlement projection-lag refusal. Split out of the single
 * `authoritative-seed-resume.db.test.ts` file by #6520 with every case body
 * byte-identical; only file and execution-unit ownership changed.
 */
createPlatformApiBootstrapTestHarness(
  "platform_api_authoritative_seed_resume_core",
  assignAuthoritativeSeedResumeState,
  {
    retainedStateHandoff: retainedStatePhaseHandoff,
  },
);

describe("authoritative seed resume", () => {
  it("derives the exact active and source-only seed universe for every host profile", async () => {
    await expectZeroRelationCaseEntry("executable seed-universe derivation");

    const derived: Record<string, ProfileUniverse> = {};
    for (const runtimeProfile of [undefined, "landing", "proof", "public"] as const) {
      const label = runtimeProfile ?? "undefined";
      const universe = deriveProfileUniverse(runtimeProfile);
      derived[label] = universe;
      console.log(formatUniverse(label, universe));

      // Every derived context is accounted for exactly once across the three roles.
      expect([...universe.active, ...universe.sourceOnly, ...universe.omitted].sort()).toEqual(
        [...registryContextNames].sort(),
      );
      expect(universe).toEqual(frozenProfileDiagnostics[label]);
    }

    // Executable cross-check: for every profile a host can be constructed for,
    // the derivation must equal the mount roles the runtime itself resolves.
    // This is what keeps the `undefined` derivation from being a reimplementation
    // that has silently diverged from production selection.
    for (const runtimeProfile of ["landing", "proof", "public"] as const) {
      expect(executableProfileUniverse(runtimeProfile), `executable mount roles for '${runtimeProfile}'`).toEqual(
        derived[runtimeProfile],
      );
    }

    // `undefined` matches every declared profile, so it must equal the profiles
    // whose declared membership is total. This is why a `public` host is the
    // executable stand-in for the `undefined` universe in the boot cases below.
    expect(derived.undefined).toEqual(derived.proof);
    expect(derived.undefined).toEqual(derived.public);
    expect(derived.undefined!.active).toHaveLength(19);
    expect(derived.undefined!.sourceOnly).toEqual([]);

    // Omitted-context negative control: a context omitted under `landing` is
    // absent from the mounted set, absent from both roles, and absent from the
    // host the runtime actually builds — presence in the registry is not
    // presence in the universe.
    const landing = derived.landing!;
    expect(landing.omitted).toContain("payments");
    expect(landing.active).not.toContain("payments");
    expect(landing.sourceOnly).not.toContain("payments");
    const landingRuntime = createHost("landing");
    expect(landingRuntime.mountedContexts.map((entry) => entry.contextName)).not.toContain("payments");
    expect(landingRuntime.mountedContexts).toHaveLength(landing.active.length + landing.sourceOnly.length);

    // Scenario-seed eligibility is decided by `seedProfilesOverlap`, not by
    // mount membership: 19 mounted contexts, 14 eligible, 11 of them inspecting.
    const runtime = createHost();
    const eligible = eligibleScenarioSeedContexts(runtime);
    expect(eligible.map((context) => context.contextName).sort()).toEqual([...frozenEligibleScenarioSeedContexts]);
    expect(
      eligible
        .filter((context) => context.inspects)
        .map((context) => context.contextName)
        .sort(),
    ).toEqual([...frozenInspectingSeedContexts]);
    expect(
      eligible
        .filter((context) => !context.inspects)
        .map((context) => context.contextName)
        .sort(),
    ).toEqual([...frozenNonInspectingSeedContexts]);
    console.log(
      `[#6396 eligibility] mounted=${runtime.mountedContexts.length} eligible=${eligible.length} ` +
        `inspecting=${eligible.filter((context) => context.inspects).length} ` +
        `non-inspecting=${frozenNonInspectingSeedContexts.join(",")}`,
    );
  });

  it("retained-state phase one: completes the first scenario-seed boot and proves all three same-boot repeats append nothing", async () => {
    await expectZeroRelationCaseEntry("retained-state phase one");

    const runtime = createHost();
    const eligible = eligibleScenarioSeedContexts(runtime);

    const bootOneStartedAt = Date.now();
    await ordinaryBoot(runtime);
    const bootOneSeconds = (Date.now() - bootOneStartedAt) / 1000;
    const afterBootOne = await eligiblePrefixCounts(runtime);
    const publicPresenceAfterBootOne = await capturePublicPresenceSeedOutput();

    // The freeze is only as good as its column coverage, so that coverage is
    // established against the canonical table before anything is frozen against
    // it. This is the executable form of the schema-to-freeze probe: the
    // reported `missingSemanticColumns` must be empty.
    const promoSchemaColumns = await publicPresencePromoTableColumns();
    console.log(describePromoSchemaParity(publicPresenceAfterBootOne.promoSemantic, promoSchemaColumns));
    expect(
      promoSchemaParityViolations(publicPresenceAfterBootOne.promoSemantic, promoSchemaColumns),
      "every canonical promo column must be frozen or intentionally excluded",
    ).toEqual([]);

    console.log(`[#6396 phase] boot-one=${bootOneSeconds.toFixed(1)}s`);
    for (const context of eligible) {
      console.log(
        `[#6396 boot-one] ${context.contextName} prefix=${context.streamPrefix} ` +
          `events=${afterBootOne[context.contextName]} inspects=${context.inspects}`,
      );
    }

    // Same-boot repetition, proven separately from process boot two: re-invoke
    // the eligible seeds at each of the three full-drain lifecycle points
    // `platform-runtime/api.ts` uses within one boot and assert the settled
    // prefix count is unchanged after each. Public Presence's seed-owned output
    // is frozen across every one of them, not just across boot two.
    const repeatSeconds: Record<string, number> = {};
    let publicPresenceLatest = publicPresenceAfterBootOne;
    for (const lifecyclePoint of ["seed", "projection-drain", "seed-reconcile"] as const) {
      const repeatStartedAt = Date.now();
      await repeatSameBootSeedLifecyclePoint(runtime);
      repeatSeconds[lifecyclePoint] = (Date.now() - repeatStartedAt) / 1000;
      const afterRepeat = await eligiblePrefixCounts(runtime);
      expect(afterRepeat, `same-boot repeat at ${lifecyclePoint}`).toEqual(afterBootOne);

      publicPresenceLatest = await capturePublicPresenceSeedOutput();
      expect(
        promoFrozenMismatches(publicPresenceAfterBootOne.promoSemantic, publicPresenceLatest.promoRows),
        `Public Presence promo semantics must be frozen across the ${lifecyclePoint} repeat`,
      ).toEqual([]);
      expect(publicPresenceLatest.policyRow, `Public Presence policy row frozen across ${lifecyclePoint}`).toEqual(
        publicPresenceAfterBootOne.policyRow,
      );
      expect(
        publicPresenceLatest.policyStreams,
        `the '${policyDocumentStreamPrefix}' stream must not grow across ${lifecyclePoint}`,
      ).toEqual(publicPresenceAfterBootOne.policyStreams);

      console.log(
        `[#6396 same-boot] ${lifecyclePoint} repeat: appended=0 across ${eligible.length} contexts ` +
          `in ${repeatSeconds[lifecyclePoint]!.toFixed(1)}s`,
      );
    }

    // The only excluded promo column is the one the seed deliberately rewrites.
    // Measuring that it really moved is what makes the exclusion authorized
    // rather than convenient.
    const movedUpdatedAt = publicPresenceLatest.promoRows.filter((row) => {
      const before = publicPresenceAfterBootOne.promoRows.find((candidate) => candidate.id === row.id);
      return before !== undefined && row.updated_at !== before.updated_at;
    });
    expect(
      movedUpdatedAt.map((row) => row.id).sort(),
      "every seed-owned promo row must have its updated_at rewritten by the repeats",
    ).toEqual([...publicPresenceSeedPromoIds].sort());

    console.log(
      `[#6490 handoff] arming '${RETAINED_STATE_PHASE_TWO_CASE}' with ${eligible.length} eligible prefix counts; ` +
        `boot-one=${bootOneSeconds.toFixed(1)}s repeats=${Object.entries(repeatSeconds)
          .map(([point, seconds]) => `${point}:${seconds.toFixed(1)}s`)
          .join(" ")}`,
    );
    retainedStatePhaseHandoff.arm({
      eligiblePrefixCounts: afterBootOne,
      eligibleContexts: eligible,
      publicPresence: publicPresenceLatest,
      bootOneSeconds,
      repeatSeconds,
    });
  }, 300_000);

  it("retained-state phase two: proves ordinary boot two appends nothing on the retained phase-one database", async (testContext) => {
    expect(testContext.task.name, "the retained handoff is bound to this exact case name").toBe(
      RETAINED_STATE_PHASE_TWO_CASE,
    );

    // Fails closed with the named handoff error when phase one did not run, or
    // when the harness reset this case's schemas instead of retaining them.
    const receipt = retainedStatePhaseHandoff.requireRetained();

    const relationsAtCaseEntry = await activeContextRelationCounts();
    const resetContexts = Object.entries(relationsAtCaseEntry)
      .filter(([, count]) => count === 0)
      .map(([contextName]) => contextName);
    expect(
      resetContexts,
      `${RETAINED_STATE_HANDOFF_ERROR}: phase two must run on the retained phase-one database, not an empty one`,
    ).toEqual([]);
    console.log(
      `[#6490 handoff] consumed; retained relations ${JSON.stringify(relationsAtCaseEntry)}; ` +
        `phase-one boot=${receipt.bootOneSeconds.toFixed(1)}s`,
    );

    const runtime = createHost();
    const eligible = eligibleScenarioSeedContexts(runtime);
    expect(
      eligible.map((context) => context.contextName).sort(),
      "the eligible universe must not move between phases",
    ).toEqual(receipt.eligibleContexts.map((context) => context.contextName).sort());

    const bootTwoStartedAt = Date.now();
    await ordinaryBoot(runtime);
    const bootTwoSeconds = (Date.now() - bootTwoStartedAt) / 1000;
    const afterBootTwo = await eligiblePrefixCounts(runtime);
    const afterBootOne = receipt.eligiblePrefixCounts;

    for (const context of eligible) {
      const before = afterBootOne[context.contextName]!;
      const after = afterBootTwo[context.contextName]!;
      console.log(
        `[#6396 delta] ${context.contextName} prefix=${context.streamPrefix} ` +
          `before=${before} after=${after} delta=${after - before} inspects=${context.inspects}`,
      );
    }
    expect(afterBootTwo, "ordinary boot two must append nothing for any eligible context").toEqual(afterBootOne);

    // Honest non-inspector arms: each is reported as what it is, and none is
    // claimed to have inspected aggregate state.
    expect(afterBootTwo["commercial-terms"], "Commercial Terms is stream-prefix-only").toBeGreaterThan(0);
    expect(afterBootTwo["commercial-terms"]! - afterBootOne["commercial-terms"]!).toBe(0);
    expect(afterBootOne.pricing, "Pricing is a declared no-op").toBe(0);
    expect(afterBootTwo.pricing).toBe(0);
    expect(afterBootOne["public-presence"], "Public Presence authors no public-presence.* stream").toBe(0);
    expect(afterBootTwo["public-presence"]).toBe(0);
    for (const contextName of frozenNonInspectingSeedContexts) {
      const context = runtime.mountedContexts.find((entry) => entry.contextName === contextName);
      expect(
        context?.module.inspectSeedState,
        `${contextName} must not claim inspected aggregate state`,
      ).toBeUndefined();
    }

    // Public Presence's real output, frozen semantically. The `public-presence.`
    // prefix staying at 0 -> 0 says nothing about the policy document the seed
    // actually commits, so that stream is counted directly.
    const publicPresenceAfterBootTwo = await capturePublicPresenceSeedOutput();
    expect(
      promoFrozenMismatches(receipt.publicPresence.promoSemantic, publicPresenceAfterBootTwo.promoRows),
      "Public Presence promo semantics must be frozen across ordinary boot two",
    ).toEqual([]);
    expect(publicPresenceAfterBootTwo.policyRow, "the exact beta-wave policy row must be frozen").toEqual(
      receipt.publicPresence.policyRow,
    );
    expect(publicPresenceAfterBootTwo.policyStreams, "exactly one seed-owned policy document stream").toHaveLength(1);
    expect(
      publicPresenceAfterBootTwo.policyStreams,
      `the '${policyDocumentStreamPrefix}' stream must be unchanged across boot two`,
    ).toEqual(receipt.publicPresence.policyStreams);
    for (const row of publicPresenceAfterBootTwo.promoRows) {
      console.log(
        `[#6490 public-presence promo] ${row.id} tone=${row.tone} active=${row.is_active} order=${row.display_order} ` +
          `starts=${JSON.stringify(row.starts_at)} ends=${JSON.stringify(row.ends_at)} ` +
          `created=${row.created_at} title=${JSON.stringify(row.title)}`,
      );
    }
    console.log(
      `[#6490 public-presence policy] key=${publicPresenceBetaWavePolicyKey} ` +
        `document=${publicPresenceAfterBootTwo.policyRow.document_id} status=${publicPresenceAfterBootTwo.policyRow.status} ` +
        `streams=${JSON.stringify(publicPresenceAfterBootTwo.policyStreams)} ` +
        `global-active-rows=${publicPresenceAfterBootTwo.activePolicyCount}`,
    );

    const publicPresenceMount = runtime.mountedContexts.find((entry) => entry.contextName === "public-presence");
    if (!publicPresenceMount?.module.seed) {
      throw new Error("Public Presence is not mounted with a seed.");
    }

    // Mutant one: a single promo semantic column the seed owns. The frozen
    // comparison must see it while the predecessor `id` + `display_order`
    // comparison cannot, and the seed must reconcile it back.
    const mutatedPromoId = publicPresenceSeedPromoIds[0];
    await pools["public-presence"].query("UPDATE public_presence_promo_bar_messages SET tone = $2 WHERE id = $1", [
      mutatedPromoId,
      "warning",
    ]);
    const mutatedPromoRows = await publicPresencePromoRows();
    const frozenPromoViolations = promoFrozenMismatches(receipt.publicPresence.promoSemantic, mutatedPromoRows);
    expect(frozenPromoViolations.length, "the frozen promo comparison must report the mutated column").toBeGreaterThan(
      0,
    );
    expect(
      promoIdAndOrderMismatches(receipt.publicPresence.promoSemantic, mutatedPromoRows),
      "the id + display_order comparison must be blind to the same mutation",
    ).toEqual([]);
    console.log(
      `[#6490 promo mutant] frozen violations=${JSON.stringify(frozenPromoViolations)}; ` +
        "id+display_order-only violations=0",
    );

    await publicPresenceMount.module.seed(publicPresenceMount.pool, publicPresenceMount.services, seedOptions);
    expect(
      promoFrozenMismatches(receipt.publicPresence.promoSemantic, await publicPresencePromoRows()),
      "re-invoking only the Public Presence seed must reconcile the mutated column back",
    ).toEqual([]);

    // Mutant two: the promo scheduling window, one column at a time. These are
    // the columns the live visibility query and `promoBarStatus` read to decide
    // whether a promo is showing at all, so a freeze blind to them would report
    // green while the seeded promo bar changed what it displays. Only the named
    // window column varies in each pass — every other column is left exactly as
    // the seed authored it, and the predecessor `id` + `display_order`
    // comparison is executed against the same rows, so the freeze is proven
    // discriminating rather than reaching the same verdict through some other
    // clause.
    const scheduleMutantPromoId = publicPresenceSeedPromoIds[1];
    const frozenSchedulePromo = receipt.publicPresence.promoSemantic.find((row) => row.id === scheduleMutantPromoId);
    if (!frozenSchedulePromo) {
      throw new Error(`The freeze does not carry promo row '${scheduleMutantPromoId}'.`);
    }
    console.log(
      `[#6490 promo schedule] seeded window for ${scheduleMutantPromoId}: ` +
        `starts_at=${JSON.stringify(frozenSchedulePromo.starts_at)} ends_at=${JSON.stringify(frozenSchedulePromo.ends_at)}`,
    );

    // Each statement sets exactly one window column and clears the other, so a
    // single column differs from the freeze on every pass.
    const scheduleWindowMutants = [
      {
        column: "starts_at",
        sql: `UPDATE public_presence_promo_bar_messages
                 SET starts_at = $2::timestamptz, ends_at = NULL
               WHERE id = $1`,
        value: "2026-01-02T03:04:05+00:00",
      },
      {
        column: "ends_at",
        sql: `UPDATE public_presence_promo_bar_messages
                 SET starts_at = NULL, ends_at = $2::timestamptz
               WHERE id = $1`,
        value: "2026-01-03T03:04:05+00:00",
      },
    ] as const;

    for (const mutant of scheduleWindowMutants) {
      await pools["public-presence"].query(mutant.sql, [scheduleMutantPromoId, mutant.value]);
      const scheduleMutatedRows = await publicPresencePromoRows();
      const scheduleViolations = promoFrozenMismatches(receipt.publicPresence.promoSemantic, scheduleMutatedRows);
      const scheduleViolationColumns = scheduleViolations
        .map((violation) => /^promo '[^']+'\.([a-z_]+):/.exec(violation)?.[1])
        .filter((column): column is string => column !== undefined)
        .sort();
      expect(
        scheduleViolationColumns,
        `the freeze must report exactly '${mutant.column}' when only that window column moves`,
      ).toEqual([mutant.column]);
      expect(
        promoIdAndOrderMismatches(receipt.publicPresence.promoSemantic, scheduleMutatedRows),
        `the id + display_order comparison must be blind to the '${mutant.column}' mutation`,
      ).toEqual([]);
      console.log(
        `[#6490 promo schedule mutant] ${mutant.column}: frozen violations=${JSON.stringify(scheduleViolations)}; ` +
          "id+display_order-only violations=0",
      );
    }

    // The seed's `ON CONFLICT DO UPDATE` never writes the scheduling window, so
    // unlike the tone mutant a re-invocation cannot reconcile it. That is
    // executed rather than asserted in a comment, and it is why the window is
    // then restored directly to the values the freeze captured.
    await publicPresenceMount.module.seed(publicPresenceMount.pool, publicPresenceMount.services, seedOptions);
    expect(
      promoFrozenMismatches(receipt.publicPresence.promoSemantic, await publicPresencePromoRows()).length,
      "the seed does not own the promo scheduling window, so re-invoking it cannot reconcile the mutation",
    ).toBeGreaterThan(0);
    await pools["public-presence"].query(
      `UPDATE public_presence_promo_bar_messages
          SET starts_at = $2::timestamptz, ends_at = $3::timestamptz
        WHERE id = $1`,
      [scheduleMutantPromoId, frozenSchedulePromo.starts_at, frozenSchedulePromo.ends_at],
    );
    expect(
      promoFrozenMismatches(receipt.publicPresence.promoSemantic, await publicPresencePromoRows()),
      "restoring the scheduling window must return the promo freeze to green",
    ).toEqual([]);

    // Mutant three: delete the exact policy row and insert an unrelated active
    // one. A global active-row count cannot see this; the exact-row assertion
    // must, and the re-invoked seed then authors a duplicate policy document on
    // a stream the `public-presence.` prefix invariant never counts.
    const activePolicyCountBefore = await publicPresenceActivePolicyCount();
    const policyStreamsBefore = await publicPresencePolicyDocumentStreams();
    await pools["public-presence"].query("DELETE FROM platform_policy_documents WHERE policy_key = $1", [
      publicPresenceBetaWavePolicyKey,
    ]);
    await pools["public-presence"].query(
      `INSERT INTO platform_policy_documents (
         document_id, policy_key, context_name, schema_summary, status, value,
         effective_from, effective_until, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5::jsonb, now(), NULL, now(), now())`,
      [
        "pol_seed_unrelated_negative_control",
        "public-presence.unrelated-negative-control",
        "public-presence",
        "{ unrelatedNegativeControl }",
        JSON.stringify({ unrelatedNegativeControl: true }),
      ],
    );
    expect(
      await publicPresenceActivePolicyCount(),
      "a global active-row count cannot see the exact policy row disappear",
    ).toBe(activePolicyCountBefore);
    expect(await publicPresenceBetaWavePolicyRow(), "the exact-row assertion must go red").toBeUndefined();

    await publicPresenceMount.module.seed(publicPresenceMount.pool, publicPresenceMount.services, seedOptions);
    const policyStreamsAfter = await publicPresencePolicyDocumentStreams();
    const recreatedPolicyRow = await publicPresenceBetaWavePolicyRow();
    const addedPolicyStreams = policyStreamsAfter.filter(
      (stream) => !policyStreamsBefore.some((before) => before.stream_id === stream.stream_id),
    );
    console.log(
      `[#6490 policy mutant] global-active-rows ${activePolicyCountBefore} -> ${await publicPresenceActivePolicyCount()} ` +
        `(unchanged by the exact-row deletion); projection row recreated=${recreatedPolicyRow?.document_id ?? "absent"}; ` +
        `'${policyDocumentStreamPrefix}' streams ${policyStreamsBefore.length} -> ${policyStreamsAfter.length}; ` +
        `appended=${JSON.stringify(addedPolicyStreams)}`,
    );
    expect(
      addedPolicyStreams.length,
      "the re-invoked seed re-authors a policy document the public-presence. prefix invariant cannot see",
    ).toBeGreaterThan(0);

    console.log(
      `[#6490 timing] phase-one boot=${receipt.bootOneSeconds.toFixed(1)}s ` +
        `repeats=${Object.values(receipt.repeatSeconds)
          .reduce((total, seconds) => total + seconds, 0)
          .toFixed(1)}s phase-two boot=${bootTwoSeconds.toFixed(1)}s eligible=${eligible.length}`,
    );
  }, 300_000);

  it("does not re-author Settlement while its payout projection lags the stream", async () => {
    await expectZeroRelationCaseEntry("Settlement projection lag");

    const runtime = createHost();
    await ordinaryBoot(runtime);

    // Fixture capture, before anything lags. The exact cross-context
    // prerequisite Settlement's seed reads, the retained stream-prefix count,
    // the payout projection checkpoint, and the projected payout rows.
    const prerequisiteRows = await settlementPaymentSourceRows();
    const prerequisite = prerequisiteRows.find((row) => row.payment_id === settlementSeedPrerequisitePaymentId);
    expect(prerequisite, "the exact Settlement seed prerequisite payment source is absent").toBeDefined();
    expect(prerequisite!.status).toBe("captured");
    const retainedSettlementEvents = await countEventsWithPrefix(pools.settlement, "settlement.");
    expect(retainedSettlementEvents).toBeGreaterThan(0);
    const checkpointBefore = await loadSubscriptionCheckpoint(pools.settlement, settlementPayoutCheckpointKey);
    expect(checkpointBefore, "the payout projection checkpoint must exist after a completed boot").not.toBeNull();
    expect(await settlementPayoutPageIds()).toEqual([...seededPayoutIds].sort());

    // Establish the lag: only `settlement_payout_pages` and its checkpoint fall
    // behind. The `settlement.*` streams stay exactly as boot one left them.
    await pools.settlement.query("DELETE FROM settlement_payout_pages");
    await pools.settlement.query("DELETE FROM event_subscription_checkpoints WHERE checkpoint_key = $1", [
      settlementPayoutCheckpointKey,
    ]);
    expect(await settlementPayoutPageIds()).toEqual([]);
    expect(await loadSubscriptionCheckpoint(pools.settlement, settlementPayoutCheckpointKey)).toBeNull();
    expect(await countEventsWithPrefix(pools.settlement, "settlement."), "the stream must stay current").toBe(
      retainedSettlementEvents,
    );
    // Retained lag state exists only where this fixture established it: the
    // other Settlement projection checkpoints are untouched.
    const otherSettlementCheckpoints = await pools.settlement.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM event_subscription_checkpoints WHERE checkpoint_key <> $1",
      [settlementPayoutCheckpointKey],
    );
    expect(Number(otherSettlementCheckpoints.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    // Clone the executable `landing` runtime, withholding only the named
    // projection handler set. Settlement is source-only under `landing`, so the
    // 445-455 seed/drain/seed/drain path is the one that runs.
    const landingRuntime = createHost("landing");
    const settlementMount = landingRuntime.mountedContexts.find((entry) => entry.contextName === "settlement");
    expect(settlementMount?.mountRole, "Settlement must be source-only under landing").toBe("source-only");
    const laggingRuntime = withLaggingSettlementPayoutProjection(landingRuntime);
    const laggingSettlement = laggingRuntime.mountedContexts.find((entry) => entry.contextName === "settlement");
    expect(settlementMount!.projectionHandlerSets.map((set) => set.projectionName)).toContain(
      SETTLEMENT_PAYOUT_PROJECTION_NAME,
    );
    expect(laggingSettlement!.projectionHandlerSets.map((set) => set.projectionName)).not.toContain(
      SETTLEMENT_PAYOUT_PROJECTION_NAME,
    );
    expect(laggingSettlement!.projectionHandlerSets).toHaveLength(settlementMount!.projectionHandlerSets.length - 1);
    // Everything except the withheld handler set is the identical object.
    for (const entry of laggingRuntime.mountedContexts) {
      const original = landingRuntime.mountedContexts.find((candidate) => candidate.contextName === entry.contextName)!;
      expect(entry.pool).toBe(original.pool);
      expect(entry.services).toBe(original.services);
      expect(entry.mountRole).toBe(original.mountRole);
      if (entry.contextName !== "settlement") {
        expect(entry).toBe(original);
      }
    }

    await seedApiHostIfEmpty(apiContextRegistry, HOST_NAME, laggingRuntime, {
      ...seedOptions,
      runtimeProfile: "landing",
    });

    // Current code decides from the stream: nothing is re-authored, and the
    // withheld projection is still visibly behind afterwards.
    const settlementEventsAfterRepeat = await countEventsWithPrefix(pools.settlement, "settlement.");
    expect(settlementEventsAfterRepeat - retainedSettlementEvents).toBe(0);
    expect(await settlementPayoutPageIds(), "the withheld projection must stay behind").toEqual([]);
    expect(await loadSubscriptionCheckpoint(pools.settlement, settlementPayoutCheckpointKey)).toBeNull();
    expect(await payoutsMissingFromStreams(), "the streams still carry both seeded payouts").toEqual([]);
    console.log(
      `[#6396 lag] settlement prefix ${retainedSettlementEvents} -> ${settlementEventsAfterRepeat} (delta 0); ` +
        `settlement_payout_pages=0 rows; checkpoint '${settlementPayoutCheckpointKey}'=absent; ` +
        `prerequisite ${prerequisite!.payment_id} status=${prerequisite!.status}`,
    );

    // Predecessor mutant on that same fixture: identical question, sourced from
    // the empty projection instead of the stream.
    await expect(predecessorEmptyProjectionSeedDecision()).rejects.toThrow(PREDECESSOR_REAUTHOR_ERROR);
    console.log(`[#6396 predecessor] empty-projection decision raised ${PREDECESSOR_REAUTHOR_ERROR}`);

    // Paired prerequisite negative: give the seed real work to do, then prove an
    // unrelated captured row cannot stand in for the exact missing target.
    const completedPayoutStreamId = `settlement.payout-${settlementSeedCompletedPayoutId}`;
    await pools.settlement.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = $1", [
      completedPayoutStreamId,
    ]);
    await pools.settlement.query("DELETE FROM event_store_events WHERE stream_id = $1", [completedPayoutStreamId]);
    await pools.settlement.query(
      "UPDATE event_store_streams SET current_version = 0, updated_at = now() WHERE stream_id = $1",
      [completedPayoutStreamId],
    );
    expect(await payoutsMissingFromStreams()).toEqual([settlementSeedCompletedPayoutId]);
    const withWorkPending = await countEventsWithPrefix(pools.settlement, "settlement.");

    const unrelatedPaymentId = "pay_seed_unrelated_negative_control";
    await pools.settlement.query("DELETE FROM settlement_payment_sources WHERE payment_id = $1", [
      settlementSeedPrerequisitePaymentId,
    ]);
    await pools.settlement.query(
      `INSERT INTO settlement_payment_sources (
         payment_id, buyer_account_id, amount, currency_code, processor_name,
         processor_payment_reference, processor_status, status, created_at, updated_at, captured_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), now())`,
      [
        unrelatedPaymentId,
        "acc_seed_unrelated_buyer",
        prerequisite!.amount,
        prerequisite!.currency_code,
        "fake",
        "ref_unrelated_negative_control",
        "captured",
        "captured",
      ],
    );
    const negativeRows = await settlementPaymentSourceRows();
    expect(negativeRows.map((row) => row.payment_id)).toContain(unrelatedPaymentId);
    expect(negativeRows.map((row) => row.payment_id)).not.toContain(settlementSeedPrerequisitePaymentId);

    const settlementContext = runtime.mountedContexts.find((entry) => entry.contextName === "settlement")!;
    await settlementContext.module.seed!(settlementContext.pool, settlementContext.services, seedOptions);
    expect(
      await countEventsWithPrefix(pools.settlement, "settlement."),
      "an unrelated captured row must not stand in for the exact missing prerequisite",
    ).toBe(withWorkPending);
    expect(await payoutsMissingFromStreams()).toEqual([settlementSeedCompletedPayoutId]);

    // Restore the exact target and the same seed does the pending work.
    await pools.settlement.query(
      `INSERT INTO settlement_payment_sources (
         payment_id, buyer_account_id, amount, currency_code, processor_name,
         processor_payment_reference, processor_status, status, created_at, updated_at, captured_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), $9)`,
      [
        settlementSeedPrerequisitePaymentId,
        "acc_seed_demo_buyer",
        prerequisite!.amount,
        prerequisite!.currency_code,
        "fake",
        "ref_restored_exact_target",
        "captured",
        "captured",
        prerequisite!.captured_at,
      ],
    );
    await settlementContext.module.seed!(settlementContext.pool, settlementContext.services, seedOptions);
    const afterExactTarget = await countEventsWithPrefix(pools.settlement, "settlement.");
    expect(afterExactTarget, "the exact prerequisite unblocks the pending payout").toBeGreaterThan(withWorkPending);
    expect(await payoutsMissingFromStreams()).toEqual([]);
    console.log(
      `[#6396 prerequisite] unrelated-row-only appends=0 (prefix ${withWorkPending}); ` +
        `exact-target-restored appends=${afterExactTarget - withWorkPending}`,
    );
  }, 300_000);
});
