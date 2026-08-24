import { describe, expect, it } from "vitest";
import { createPlatformApiBootstrapTestHarness } from "./bootstrap-db-test-support";
import {
  allContextEventCounts,
  allowedReportStreamPrefix,
  assignAuthoritativeSeedResumeState,
  type CollectedSeedReport,
  contextEventCount,
  corpusViolations,
  createHost,
  deriveOrderingOfferAcceptanceReportReconciliation,
  eligibleScenarioSeedContexts,
  eventCountBindingViolations,
  expectZeroRelationCaseEntry,
  frozenInspectingSeedContexts,
  frozenSeedIdentityCorpus,
  invokeConvertedSeeds,
  mountBindingViolations,
  orderingOfferAcceptanceSourceToFallbackOrderId,
  orderStreamEventTypes,
  orderStreamsForOfferSource,
  ordinaryBoot,
  poolFor,
  pools,
  reportStreamPrefixKey,
  requiredDraftListingId,
  requirePlatformOperationsContext,
  resolvedSeedSupportRequestId,
  rollWalletReleaseEventOffTheStream,
  seedActorContext,
  seedIdentityKey,
  seedingModules,
  seedInspectorDerivationSources,
  seedOptions,
  seedReportStreamPrefixExceptions,
  seedStateExemptions,
  settlementSeedPendingSaleCreditId,
  settlementSeedSellerAccountId,
  summarizeStates,
  supportRequestServices,
  supportRequestStreamEventTypes,
  unloggedGuardProjectionFixture,
} from "./authoritative-seed-resume-test-support";

/**
 * Reconciliation truth for the authoritative seed-resume partition: frozen
 * identity-corpus reconciliation across every inspecting scenario-seed context,
 * stream-sourced seed-state coverage, UNLOGGED guard-projection resume, and the
 * real deadline sweep. Split out of the single
 * `authoritative-seed-resume.db.test.ts` file by #6520 with every case body
 * byte-identical; only file and execution-unit ownership changed.
 */
createPlatformApiBootstrapTestHarness(
  "platform_api_authoritative_seed_resume_reconciliation",
  assignAuthoritativeSeedResumeState,
);

describe("authoritative seed resume", () => {
  it("reconciles every inspecting scenario-seed context to its frozen identity corpus and active state", async () => {
    await expectZeroRelationCaseEntry("frozen identity corpus");

    // The literal's shape, asserted instead of claimed by its comment. The
    // canonical order is the one `corpusViolations` compares with — the default
    // `Array.prototype.sort` code-unit order — not a culture-aware collation,
    // which orders `identity|API Key|…` and `identity|Account|…` the other way
    // around and would call this same literal unsorted.
    expect(new Set(frozenSeedIdentityCorpus).size, "the pinned corpus literal must have no duplicate identity").toBe(
      frozenSeedIdentityCorpus.length,
    );
    expect(frozenSeedIdentityCorpus, "the pinned corpus literal must be in canonical sorted order").toEqual(
      [...frozenSeedIdentityCorpus].sort(),
    );
    expect(frozenSeedIdentityCorpus, "the frozen corpus cardinality must remain exact").toHaveLength(285);

    const runtime = createHost();
    await ordinaryBoot(runtime);

    const inspecting = eligibleScenarioSeedContexts(runtime).filter((context) => context.inspects);
    expect(inspecting.map((context) => context.contextName).sort()).toEqual([...frozenInspectingSeedContexts]);

    // The whole table is emitted before anything is asserted, so a single
    // non-active aggregate cannot truncate the omission-revealing evidence.
    const collected: CollectedSeedReport[] = [];
    for (const context of inspecting) {
      const mount = runtime.mountedContexts.find((entry) => entry.contextName === context.contextName)!;
      const reports = await mount.module.inspectSeedState!(mount.pool, seedOptions);
      expect(reports.length, `${context.contextName} reports no seed aggregates`).toBeGreaterThan(0);
      console.log(
        `[#6396 aggregate-state] ${context.contextName}: ${reports.length} aggregates ${summarizeStates(reports)}`,
      );
      for (const report of reports) {
        console.log(
          `[#6396 aggregate-state]   ${context.contextName} ${report.aggregateName} '${report.key}' id=${report.id} ` +
            `kind=${report.kind} status=${report.status ?? "-"} events=${report.eventCount} stream=${report.streamId}`,
        );
        collected.push({ contextName: context.contextName, streamPrefix: context.streamPrefix, report });
      }
    }

    // Real per-stream row counts, read from each context's own database. This is
    // what makes `report.eventCount` checkable instead of merely non-empty.
    const actualStreamEventCounts = new Map<string, number>();
    for (const { contextName, report } of collected) {
      const cacheKey = `${contextName}|${report.streamId}`;
      if (actualStreamEventCounts.has(cacheKey)) continue;
      const result = await poolFor(contextName).query<Readonly<{ count: string }>>(
        "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id = $1",
        [report.streamId],
      );
      actualStreamEventCounts.set(cacheKey, Number(result.rows[0]?.count ?? 0));
    }

    // Derivation artifact: the corpus itself, and the inspector implementation
    // every row of it was read from.
    const derivedCorpus = collected.map((entry) => seedIdentityKey(entry.report)).sort();
    console.log(`[#6490 corpus artifact] cardinality=${derivedCorpus.length} contexts=${inspecting.length}`);
    for (const contextName of frozenInspectingSeedContexts) {
      const rows = derivedCorpus.filter((identity) => identity.startsWith(`${contextName}|`));
      console.log(
        `[#6490 corpus artifact] ${contextName} <- ${seedInspectorDerivationSources[contextName]} : ${rows.length} identities`,
      );
    }
    console.log(`[#6490 corpus artifact json] ${JSON.stringify(derivedCorpus)}`);

    // Every declared out-of-prefix family must be exercised by a real report, so
    // the exception list can never silently outlive the behaviour it describes.
    const exercisedPrefixExceptions = new Map<string, number>();
    for (const entry of collected) {
      const key = reportStreamPrefixKey(entry);
      if (!seedReportStreamPrefixExceptions.has(key)) continue;
      exercisedPrefixExceptions.set(key, (exercisedPrefixExceptions.get(key) ?? 0) + 1);
    }
    for (const [key, count] of exercisedPrefixExceptions) {
      console.log(
        `[#6490 corpus artifact] out-of-manifest-prefix family ${key} -> ` +
          `'${seedReportStreamPrefixExceptions.get(key)}' (${count} reports)`,
      );
    }
    expect(
      [...seedReportStreamPrefixExceptions.keys()].filter((key) => !exercisedPrefixExceptions.has(key)),
      "a declared out-of-manifest-prefix exception is stale",
    ).toEqual([]);

    const duplicateIdentities = derivedCorpus.filter((identity, index) => derivedCorpus.indexOf(identity) !== index);
    expect(duplicateIdentities, "an aggregate identity was reported more than once").toEqual([]);
    expect(mountBindingViolations(collected), "reports are not bound to their own mount and stream prefix").toEqual([]);
    expect(
      eventCountBindingViolations(collected, actualStreamEventCounts),
      "reported event counts do not equal the real event_store_events rows",
    ).toEqual([]);
    expect(corpusViolations(collected), "the reported identity corpus does not equal the pinned corpus").toEqual([]);

    // Executed mutants. Each varies exactly one governing input of the frozen
    // bindings above; a control that reached the same verdict through another
    // clause would not count, so each mutant asserts the *other* bindings stay
    // green.
    const droppedReport = collected.slice(1);
    expect(corpusViolations(droppedReport).length, "dropping one report must turn the corpus red").toBeGreaterThan(0);

    const relabelledContext = collected.map((entry, index) =>
      index === 0 ? { ...entry, report: { ...entry.report, contextName: "not-the-mounted-context" } } : entry,
    );
    expect(
      mountBindingViolations(relabelledContext).length,
      "relabelling one report's contextName must turn the mount binding red",
    ).toBeGreaterThan(0);
    expect(
      eventCountBindingViolations(relabelledContext, actualStreamEventCounts),
      "the relabel mutant must be caught by the mount binding, not by the event-count binding",
    ).toEqual([]);

    let repointed: CollectedSeedReport[] | undefined;
    let repointDescription = "";
    for (const entry of collected) {
      const candidate = await poolFor(entry.contextName).query<Readonly<{ stream_id: string; count: string }>>(
        `SELECT stream_id, COUNT(*)::text AS count
           FROM event_store_events
          WHERE stream_id LIKE $1
            AND stream_id <> $2
          GROUP BY stream_id
         HAVING COUNT(*) <> $3::bigint
          ORDER BY stream_id ASC
          LIMIT 1`,
        [`${allowedReportStreamPrefix(entry)}%`, entry.report.streamId, String(entry.report.eventCount)],
      );
      const target = candidate.rows[0];
      if (!target) continue;
      actualStreamEventCounts.set(`${entry.contextName}|${target.stream_id}`, Number(target.count));
      repointed = collected.map((candidateEntry) =>
        candidateEntry === entry
          ? { ...candidateEntry, report: { ...candidateEntry.report, streamId: target.stream_id } }
          : candidateEntry,
      );
      repointDescription =
        `${entry.contextName} '${entry.report.key}' ${entry.report.streamId} (${entry.report.eventCount} events) ` +
        `-> ${target.stream_id} (${target.count} events)`;
      break;
    }
    expect(repointed, "no non-empty same-prefix stream with a different event count was available").toBeDefined();
    expect(
      eventCountBindingViolations(repointed!, actualStreamEventCounts).length,
      "repointing one report's streamId must turn the event-count binding red",
    ).toBeGreaterThan(0);
    expect(
      mountBindingViolations(repointed!),
      "the repoint mutant must be caught by the event-count binding, not by the prefix binding",
    ).toEqual([]);
    console.log(
      `[#6490 corpus mutants] drop=red relabel=red repoint=red (${repointDescription}); ` +
        `pinned cardinality=${frozenSeedIdentityCorpus.length}`,
    );

    // Ordering finishes with one report per offer source identity and no
    // duplicate reserved stream. The report takes the source-resolved active arm
    // when its stream has events, or the reserved absent arm when it is empty.
    const orderingReports = collected.filter((entry) => entry.contextName === "ordering").map((entry) => entry.report);
    const orderingReportKeys = orderingReports.map((report) => report.key);
    const orderingOfferAcceptanceSourceReferenceIds = [...orderingOfferAcceptanceSourceToFallbackOrderId.keys()];
    for (const sourceReferenceId of orderingOfferAcceptanceSourceReferenceIds) {
      expect(orderingReportKeys, `offer source '${sourceReferenceId}' left Ordering's seed inventory`).toContain(
        sourceReferenceId,
      );
    }

    const sourceResolvedOrderIds = new Map<string, string>();
    const sourceResolvedOrderEventCounts = new Map<string, number>();
    for (const sourceReferenceId of orderingOfferAcceptanceSourceReferenceIds) {
      const orderIds = await orderStreamsForOfferSource(sourceReferenceId);
      expect(
        orderIds,
        `offer source '${sourceReferenceId}' must resolve to exactly one ordering.order.created stream`,
      ).toHaveLength(1);
      const orderId = orderIds[0]!;
      const eventTypes = await orderStreamEventTypes(orderId);
      // `loadSeedOrderState` rehydrates `kind: active` exactly when the stream's
      // created event set the order id, so a single `ordering.order.created`
      // first event with no cancellation is that aggregate rehydrating active.
      expect(eventTypes[0], `order '${orderId}' does not open with ordering.order.created`).toBe(
        "ordering.order.created",
      );
      expect(
        eventTypes.filter((eventType) => eventType === "ordering.order.created"),
        `order '${orderId}' carries more than one creation event`,
      ).toHaveLength(1);
      expect(eventTypes, `order '${orderId}' is cancelled, not active`).not.toContain("ordering.order.cancelled");
      sourceResolvedOrderIds.set(sourceReferenceId, orderId);
      sourceResolvedOrderEventCounts.set(sourceReferenceId, eventTypes.length);
      console.log(
        `[#6490 ordering source-identity] source=${sourceReferenceId} order=${orderId} ` +
          `events=${eventTypes.length} types=${eventTypes.join(">")}`,
      );
    }
    expect(new Set(sourceResolvedOrderIds.values()).size, "two offer sources resolved to the same order").toBe(
      sourceResolvedOrderIds.size,
    );

    const duplicateReservedStreams: string[] = [];
    for (const reservedOrderId of orderingOfferAcceptanceSourceToFallbackOrderId.values()) {
      const eventTypes = await orderStreamEventTypes(reservedOrderId);
      const isSourceResolved = [...sourceResolvedOrderIds.values()].includes(reservedOrderId);
      if (eventTypes.length > 0 && !isSourceResolved) {
        duplicateReservedStreams.push(`${reservedOrderId} (${eventTypes.length} events)`);
      }
      console.log(
        `[#6490 ordering reserved] ${reservedOrderId}: ${eventTypes.length} events; source-resolved=${isSourceResolved}`,
      );
    }
    expect(
      duplicateReservedStreams,
      "a reserved offer-acceptance order stream duplicates a source-identified order",
    ).toEqual([]);

    const liveOfferAcceptance = deriveOrderingOfferAcceptanceReportReconciliation(
      collected,
      actualStreamEventCounts,
      sourceResolvedOrderIds,
    );
    expect(
      liveOfferAcceptance.violations,
      "Ordering's offer-acceptance reports do not match the derived source-identity/empty-stream rule",
    ).toEqual([]);
    for (const derivation of liveOfferAcceptance.derivations) {
      console.log(
        `[#6656 ordering source-identity derivation] source=${derivation.sourceReferenceId} arm=${derivation.arm} ` +
          `reported=${derivation.reportedId} resolved=${derivation.resolvedSourceOrderId} ` +
          `events=${derivation.actualEventCount} query=${JSON.stringify(derivation.query)}`,
      );
    }

    // The corpus ignores only the reported id for the two declared offer
    // sources. It remains sensitive to their context, aggregate name, and key.
    const sourceIdentityCorpusReports = collected.map<CollectedSeedReport>((entry) => {
      const resolvedOrderId =
        entry.contextName === "ordering" && entry.report.aggregateName === "Order"
          ? sourceResolvedOrderIds.get(entry.report.key)
          : undefined;
      return resolvedOrderId === undefined ? entry : { ...entry, report: { ...entry.report, id: resolvedOrderId } };
    });
    expect(
      corpusViolations(sourceIdentityCorpusReports),
      "source-resolved offer-order ids must remain in the frozen corpus",
    ).toEqual([]);

    const idScopeSource = orderingOfferAcceptanceSourceToFallbackOrderId.keys().next().value;
    expect(idScopeSource, "the offer-acceptance source map is empty").toBeDefined();
    const idScopeMutant = sourceIdentityCorpusReports.map<CollectedSeedReport>((entry) =>
      entry.contextName === "ordering" && entry.report.aggregateName === "Order" && entry.report.key === idScopeSource
        ? { ...entry, report: { ...entry.report, aggregateName: "Wrong Order" } }
        : entry,
    );
    const idScopeViolations = corpusViolations(idScopeMutant);
    expect(idScopeViolations.length, "changing a blinded row outside its id must turn the corpus red").toBeGreaterThan(
      0,
    );
    expect(mountBindingViolations(idScopeMutant), "the id-scope mutant must stay green on mount binding").toEqual([]);
    expect(
      eventCountBindingViolations(idScopeMutant, actualStreamEventCounts),
      "the id-scope mutant must stay green on event-count binding",
    ).toEqual([]);
    expect(idScopeViolations.join("\n"), "the id-scope mutant must name the changed offer source").toContain(
      idScopeSource,
    );

    const offerAcceptanceTemplate = collected.find(
      (entry) =>
        entry.contextName === "ordering" &&
        entry.report.aggregateName === "Order" &&
        entry.report.key === idScopeSource,
    );
    expect(offerAcceptanceTemplate, "the offer-acceptance corpus has no template report").toBeDefined();
    const indeterminateReport: CollectedSeedReport = {
      ...offerAcceptanceTemplate!,
      report: {
        ...offerAcceptanceTemplate!.report,
        id: "ord_seed_indeterminate_offer_acceptance",
        key: "off_seed_indeterminate_offer_acceptance",
        streamId: "ordering.order-ord_seed_indeterminate_offer_acceptance",
      },
    };
    const defaultArmMutant = [...collected, indeterminateReport];
    const defaultArmEventCounts = new Map(actualStreamEventCounts).set(
      `ordering|${indeterminateReport.report.streamId}`,
      indeterminateReport.report.eventCount,
    );
    const defaultArmViolations = corpusViolations(defaultArmMutant);
    expect(defaultArmViolations).toContain("corpus cardinality 286 does not equal the pinned 285");
    expect(mountBindingViolations(defaultArmMutant), "the default-arm mutant must stay green on mount binding").toEqual(
      [],
    );
    expect(
      eventCountBindingViolations(defaultArmMutant, defaultArmEventCounts),
      "the default-arm mutant must stay green on event-count binding",
    ).toEqual([]);

    // Both derived-rule arms run synthetically at every head, so neither the
    // current empty-fallback shape nor the source-resolved successor can make an
    // arm or its mutant vacuous.
    const sourceResolvedEventCounts = new Map(actualStreamEventCounts);
    const sourceResolvedReports = collected.map<CollectedSeedReport>((entry) => {
      const resolvedOrderId =
        entry.contextName === "ordering" && entry.report.aggregateName === "Order"
          ? sourceResolvedOrderIds.get(entry.report.key)
          : undefined;
      if (resolvedOrderId === undefined) return entry;
      const eventCount = sourceResolvedOrderEventCounts.get(entry.report.key)!;
      const streamId = `ordering.order-${resolvedOrderId}`;
      sourceResolvedEventCounts.set(`ordering|${streamId}`, eventCount);
      return {
        ...entry,
        report: { ...entry.report, id: resolvedOrderId, streamId, kind: "active", eventCount },
      };
    });
    expect(mountBindingViolations(sourceResolvedReports), "source-resolved synthetic reports left Ordering").toEqual(
      [],
    );
    expect(
      eventCountBindingViolations(sourceResolvedReports, sourceResolvedEventCounts),
      "source-resolved synthetic reports are not bound to their streams",
    ).toEqual([]);
    expect(corpusViolations(sourceResolvedReports), "source-resolved synthetic reports left the corpus").toEqual([]);
    expect(
      deriveOrderingOfferAcceptanceReportReconciliation(
        sourceResolvedReports,
        sourceResolvedEventCounts,
        sourceResolvedOrderIds,
      ).violations,
      "the source-resolved active arm rejected its valid candidate",
    ).toEqual([]);

    let foreignOrderMutant: CollectedSeedReport[] | undefined;
    for (const sourceReferenceId of orderingOfferAcceptanceSourceReferenceIds) {
      const foreign = [...sourceResolvedOrderIds].find(([candidateSource]) => candidateSource !== sourceReferenceId);
      if (!foreign) continue;
      const [foreignSourceReferenceId, foreignOrderId] = foreign;
      const foreignEventCount = sourceResolvedOrderEventCounts.get(foreignSourceReferenceId)!;
      foreignOrderMutant = sourceResolvedReports.map<CollectedSeedReport>((entry) =>
        entry.contextName === "ordering" &&
        entry.report.aggregateName === "Order" &&
        entry.report.key === sourceReferenceId
          ? {
              ...entry,
              report: {
                ...entry.report,
                id: foreignOrderId,
                streamId: `ordering.order-${foreignOrderId}`,
                eventCount: foreignEventCount,
              },
            }
          : entry,
      );
      break;
    }
    expect(foreignOrderMutant, "no foreign source-resolved order was available").toBeDefined();
    expect(mountBindingViolations(foreignOrderMutant!), "the foreign-order mutant left Ordering").toEqual([]);
    expect(
      eventCountBindingViolations(foreignOrderMutant!, sourceResolvedEventCounts),
      "the foreign-order mutant must stay green on event-count binding",
    ).toEqual([]);
    expect(corpusViolations(foreignOrderMutant!), "the foreign-order mutant must stay green on corpus binding").toEqual(
      [],
    );
    const foreignOrderViolations = deriveOrderingOfferAcceptanceReportReconciliation(
      foreignOrderMutant!,
      sourceResolvedEventCounts,
      sourceResolvedOrderIds,
    ).violations;
    expect(foreignOrderViolations.length, "a foreign source's order must turn the derived rule red").toBeGreaterThan(0);

    const fallbackEventCounts = new Map(actualStreamEventCounts);
    const fallbackReports = collected.map<CollectedSeedReport>((entry) => {
      const fallbackOrderId =
        entry.contextName === "ordering" && entry.report.aggregateName === "Order"
          ? orderingOfferAcceptanceSourceToFallbackOrderId.get(entry.report.key)
          : undefined;
      if (fallbackOrderId === undefined) return entry;
      const streamId = `ordering.order-${fallbackOrderId}`;
      fallbackEventCounts.set(`ordering|${streamId}`, 0);
      return {
        ...entry,
        report: { ...entry.report, id: fallbackOrderId, streamId, kind: "absent", status: null, eventCount: 0 },
      };
    });
    expect(mountBindingViolations(fallbackReports), "empty-fallback synthetic reports left Ordering").toEqual([]);
    expect(
      eventCountBindingViolations(fallbackReports, fallbackEventCounts),
      "empty-fallback synthetic reports are not bound to their streams",
    ).toEqual([]);
    expect(corpusViolations(fallbackReports), "empty-fallback synthetic reports left the corpus").toEqual([]);
    expect(
      deriveOrderingOfferAcceptanceReportReconciliation(fallbackReports, fallbackEventCounts, sourceResolvedOrderIds)
        .violations,
      "the reserved empty-stream fallback arm rejected its valid candidate",
    ).toEqual([]);

    const phantomActiveMutant = fallbackReports.map<CollectedSeedReport>((entry) =>
      entry.contextName === "ordering" && entry.report.aggregateName === "Order" && entry.report.key === idScopeSource
        ? { ...entry, report: { ...entry.report, kind: "active" } }
        : entry,
    );
    expect(mountBindingViolations(phantomActiveMutant), "the phantom-active mutant left Ordering").toEqual([]);
    expect(
      eventCountBindingViolations(phantomActiveMutant, fallbackEventCounts),
      "the phantom-active mutant must stay green on event-count binding",
    ).toEqual([]);
    expect(
      corpusViolations(phantomActiveMutant),
      "the phantom-active mutant must stay green on corpus binding",
    ).toEqual([]);
    const phantomActiveViolations = deriveOrderingOfferAcceptanceReportReconciliation(
      phantomActiveMutant,
      fallbackEventCounts,
      sourceResolvedOrderIds,
    ).violations;
    expect(
      phantomActiveViolations.length,
      "an active report with an empty stream must turn the rule red",
    ).toBeGreaterThan(0);

    const unmappedFallbackId = "ord_seed_unmapped_offer_acceptance";
    const unmappedFallbackStreamId = `ordering.order-${unmappedFallbackId}`;
    const unmappedFallbackEventCounts = new Map(fallbackEventCounts).set(`ordering|${unmappedFallbackStreamId}`, 0);
    const unmappedFallbackMutant = fallbackReports.map<CollectedSeedReport>((entry) =>
      entry.contextName === "ordering" && entry.report.aggregateName === "Order" && entry.report.key === idScopeSource
        ? { ...entry, report: { ...entry.report, id: unmappedFallbackId, streamId: unmappedFallbackStreamId } }
        : entry,
    );
    expect(mountBindingViolations(unmappedFallbackMutant), "the unmapped-fallback mutant left Ordering").toEqual([]);
    expect(
      eventCountBindingViolations(unmappedFallbackMutant, unmappedFallbackEventCounts),
      "the unmapped-fallback mutant must stay green on event-count binding",
    ).toEqual([]);
    expect(
      corpusViolations(unmappedFallbackMutant),
      "the unmapped-fallback mutant must stay green on corpus binding",
    ).toEqual([]);
    const unmappedFallbackViolations = deriveOrderingOfferAcceptanceReportReconciliation(
      unmappedFallbackMutant,
      unmappedFallbackEventCounts,
      sourceResolvedOrderIds,
    ).violations;
    expect(unmappedFallbackViolations.length, "an undeclared fallback id must turn the rule red").toBeGreaterThan(0);
    console.log(
      `[#6656 ordering mutants] id-scope=red(corpus:${idScopeViolations.length}) ` +
        `default-arm=red(corpus:${defaultArmViolations.length}) ` +
        `foreign-order=red(source-rule:${foreignOrderViolations.length};mount=green;event-count=green) ` +
        `phantom-active=red(source-rule:${phantomActiveViolations.length};mount=green;event-count=green) ` +
        `unmapped-fallback=red(source-rule:${unmappedFallbackViolations.length};mount=green;event-count=green)`,
    );

    // Every report is active unless it is one of the declared Ordering
    // offer-acceptance reports and its own reported stream is empty.
    const requiredActive = collected.filter(
      (entry) =>
        !(
          entry.contextName === "ordering" &&
          entry.report.contextName === "ordering" &&
          entry.report.aggregateName === "Order" &&
          orderingOfferAcceptanceSourceToFallbackOrderId.has(entry.report.key) &&
          entry.report.eventCount === 0
        ),
    );
    const notActive = requiredActive
      .filter((entry) => entry.report.kind !== "active")
      .map(
        (entry) =>
          `${entry.contextName} ${entry.report.aggregateName} '${entry.report.key}' id=${entry.report.id} ` +
          `kind=${entry.report.kind} status=${entry.report.status ?? "-"} events=${entry.report.eventCount} ` +
          `stream=${entry.report.streamId}`,
      );
    for (const entry of notActive) {
      console.log(`[#6396 aggregate-state NOT-ACTIVE] ${entry}`);
    }
    expect(notActive, `inspecting contexts finished with non-active seed aggregates:\n${notActive.join("\n")}`).toEqual(
      [],
    );
    const rehydratedNothing = requiredActive
      .filter((entry) => entry.report.eventCount <= 0)
      .map((entry) => `${entry.contextName} '${entry.report.key}' id=${entry.report.id}`);
    expect(
      rehydratedNothing,
      `seed aggregates reported without rehydrating any events:\n${rehydratedNothing.join("\n")}`,
    ).toEqual([]);

    // Marketplace business status `draft` is not aggregate kind `draft`: the
    // seeded draft listing is a complete aggregate whose business status is
    // deliberately draft.
    const marketplaceMount = runtime.mountedContexts.find((entry) => entry.contextName === "marketplace")!;
    const marketplaceReports = await marketplaceMount.module.inspectSeedState!(marketplaceMount.pool, seedOptions);
    expect(marketplaceReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: requiredDraftListingId, kind: "active", status: "draft" }),
      ]),
    );

    // A pre-existing non-active aggregate reconciles rather than failing the
    // boot. Rolling the seeded wallet's release event off the stream leaves the
    // pending sale credit posted-but-not-available, which `inspectSeedState`
    // reports as `draft`.
    const settlementMount = runtime.mountedContexts.find((entry) => entry.contextName === "settlement")!;
    const walletStreamId = `settlement.wallet-${settlementSeedSellerAccountId}`;
    const released = await pools.settlement.query<Readonly<{ stream_version: string }>>(
      `SELECT stream_version
         FROM event_store_events
        WHERE stream_id = $1
          AND event_type = 'settlement.wallet.ledger-entry-available-recorded'
          AND payload->>'ledgerEntryId' = $2`,
      [walletStreamId, settlementSeedPendingSaleCreditId],
    );
    expect(released.rows, "the seeded pending sale credit was never released").toHaveLength(1);
    const releasedVersion = Number(released.rows[0]!.stream_version);
    await rollWalletReleaseEventOffTheStream(walletStreamId, settlementSeedPendingSaleCreditId, releasedVersion);

    const draftReports = await settlementMount.module.inspectSeedState!(settlementMount.pool, seedOptions);
    expect(draftReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: settlementSeedPendingSaleCreditId,
          kind: "draft",
        }),
      ]),
    );

    await expect(
      settlementMount.module.seed!(settlementMount.pool, settlementMount.services, seedOptions),
    ).resolves.toBeUndefined();

    const reconciledReports = await settlementMount.module.inspectSeedState!(settlementMount.pool, seedOptions);
    expect(reconciledReports.filter((report) => report.kind !== "active")).toEqual([]);
    expect(reconciledReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: settlementSeedPendingSaleCreditId,
          kind: "active",
        }),
      ]),
    );
    console.log(
      `[#6396 reconcile] inspecting=${inspecting.length} all kind=active; ` +
        "settlement pending-sale-credit draft -> active without boot failure",
    );
  }, 300_000);

  it("enumerates stream-sourced seed-state coverage from the runtime mount list", async () => {
    await expectZeroRelationCaseEntry("stream-sourced coverage enumeration");

    const runtime = createHost();
    const modules = seedingModules(runtime);
    expect(modules.length).toBeGreaterThan(0);

    const missing = modules
      .filter((module) => !module.inspectSeedState && !seedStateExemptions.has(module.contextName))
      .map((module) => module.contextName);
    expect(missing, `seeding contexts without stream-sourced seed state: ${missing.join(", ")}`).toEqual([]);

    // No stale exemptions: every exempt name must still be a mounted seeding context.
    const mountedNames = new Set(modules.map((module) => module.contextName));
    const staleExemptions = [...seedStateExemptions.keys()].filter((name) => !mountedNames.has(name));
    expect(staleExemptions).toEqual([]);

    // The UNLOGGED-truncation fixture is not the coverage authority, but it may
    // never drift: every context it names must still be a mounted, non-exempt,
    // inspecting seeding context derived from the runtime mount list.
    const derivedInspecting = new Set(
      eligibleScenarioSeedContexts(runtime)
        .filter((context) => context.inspects)
        .map((context) => context.contextName),
    );
    for (const entry of unloggedGuardProjectionFixture) {
      const module = modules.find((candidate) => candidate.contextName === entry.contextName);
      expect(module, `truncation-fixture context '${entry.contextName}' is not mounted`).toBeDefined();
      expect(seedStateExemptions.has(entry.contextName)).toBe(false);
      expect(module?.inspectSeedState, `'${entry.contextName}' declares no inspectSeedState`).toBeDefined();
      expect(
        derivedInspecting.has(entry.contextName),
        `truncation-fixture context '${entry.contextName}' is not in the derived inspecting set`,
      ).toBe(true);
    }

    // Omission negative control: a mounted seeding context that does not declare
    // stream-sourced seed state must be reported by the very same enumeration.
    const withOmission = modules.map((module) =>
      module.contextName === "inventory" ? { contextName: module.contextName, seed: module.seed } : module,
    );
    const omitted = withOmission
      .filter((module) => !module.inspectSeedState && !seedStateExemptions.has(module.contextName))
      .map((module) => module.contextName);
    expect(omitted).toEqual(["inventory"]);
  });

  it("resumes every converted context after its UNLOGGED guard projections are truncated", async () => {
    await expectZeroRelationCaseEntry("UNLOGGED truncation resume");

    const runtime = createHost();
    await ordinaryBoot(runtime);

    const afterBootOne = await allContextEventCounts();
    for (const [contextName, count] of Object.entries(afterBootOne)) {
      expect(count, `${contextName} must have seeded events after boot one`).toBeGreaterThan(0);
    }
    const marketplaceModule = seedingModules(runtime).find((module) => module.contextName === "marketplace");
    const marketplaceReports = await marketplaceModule!.inspectSeedState!(poolFor("marketplace"));
    expect(marketplaceReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: requiredDraftListingId,
          kind: "active",
          status: "draft",
        }),
      ]),
    );

    for (const entry of unloggedGuardProjectionFixture) {
      await poolFor(entry.contextName).query(`TRUNCATE TABLE ${entry.projections.join(", ")} CASCADE`);
      for (const projection of entry.projections) {
        const rows = await poolFor(entry.contextName).query<Readonly<{ count: string }>>(
          `SELECT COUNT(*) AS count FROM ${projection}`,
        );
        expect(Number(rows.rows[0]?.count ?? 0), `${entry.contextName}.${projection}`).toBe(0);
      }
    }
    expect(await allContextEventCounts(), "truncating projections must not touch streams").toEqual(afterBootOne);

    // Re-invoke every seed three times against the emptied projections, exactly
    // as one boot does at api.ts:468, :475 and :494. Before this change the
    // inventory pass threw `InventoryDomainError: Storage location has already
    // been created.` and no later context seeded at all.
    for (let invocation = 1; invocation <= 3; invocation += 1) {
      await invokeConvertedSeeds(runtime);
      expect(await allContextEventCounts(), `invocation ${invocation}`).toEqual(afterBootOne);
    }

    const afterBootTwo = await allContextEventCounts();
    expect(afterBootTwo).toEqual(afterBootOne);

    for (const entry of unloggedGuardProjectionFixture) {
      const module = seedingModules(runtime).find((candidate) => candidate.contextName === entry.contextName);
      const reports = await module!.inspectSeedState!(poolFor(entry.contextName));
      console.log(
        `[#4906] ${entry.contextName}: truncated ${entry.projections.join(", ")} -> ` +
          `${reports.length} seed aggregates ${summarizeStates(reports)}, ` +
          `events ${afterBootTwo[entry.contextName]}`,
      );
      for (const report of reports) {
        console.log(
          `[#4906]   ${entry.contextName} ${report.aggregateName} '${report.key}' ` +
            `kind=${report.kind} status=${report.status ?? "-"} events=${report.eventCount} ` +
            `stream=${report.streamId}`,
        );
      }

      expect(reports.length, `${entry.contextName} reports no seed aggregates`).toBeGreaterThan(0);
      // No aggregate may be left half-authored: `draft` after a completed
      // resume is the committed-but-incomplete shape this issue exists to fix.
      const draft = reports.filter((report) => report.kind === "draft");
      expect(draft, `${entry.contextName} left draft aggregates: ${JSON.stringify(draft)}`).toEqual([]);
      expect(
        reports.some((report) => report.kind === "active"),
        `${entry.contextName} resumed no aggregate to active`,
      ).toBe(true);
    }
    // Full-host boot case: same explicit budget the suite already uses for
    // `bootstrap-scenario.db.test.ts`'s single full-host boot.
  }, 300_000);

  it("accepts a seeded resolution after the real deadline sweep advances it to closed", async () => {
    await expectZeroRelationCaseEntry("deadline sweep resolution");

    const runtime = createHost();
    await ordinaryBoot(runtime);
    const context = requirePlatformOperationsContext(runtime);
    const supportRequests = supportRequestServices(context);
    const supportRequestId = resolvedSeedSupportRequestId;
    const beforeSweepTypes = await supportRequestStreamEventTypes(supportRequestId);
    expect(beforeSweepTypes).toContain("support.support-request.resolved");
    expect(beforeSweepTypes).not.toContain("support.support-request.closed");

    const sweep = await supportRequests.sweepSupportRequestDeadlines(
      { now: "2026-04-02T10:30:00.000Z" },
      seedActorContext,
    );

    expect(sweep.autoClosed).toBe(1);
    const afterSweepTypes = await supportRequestStreamEventTypes(supportRequestId);
    expect(afterSweepTypes).toEqual([...beforeSweepTypes, "support.support-request.closed"]);
    const afterSweepReports = await context.module.inspectSeedState!(context.pool);
    expect(afterSweepReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: supportRequestId,
          kind: "active",
          status: "closed",
        }),
      ]),
    );

    const afterSweepEventCount = await contextEventCount("platform-operations");
    await expect(context.module.seed!(context.pool, context.services, seedOptions)).resolves.toBeUndefined();
    expect(await contextEventCount("platform-operations")).toBe(afterSweepEventCount);
    const afterReconciliationReports = await context.module.inspectSeedState!(context.pool);
    expect(afterReconciliationReports.filter((report) => report.kind === "draft")).toEqual([]);
    expect(await supportRequestStreamEventTypes(supportRequestId)).toEqual(afterSweepTypes);
    console.log(
      `[#6167 pass-after] status=closed inspection=active seed-reentry-appends=0 ` +
        "counterfactual-resolved-only-complete=false",
    );
  }, 300_000);
});
