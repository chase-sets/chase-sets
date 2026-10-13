import { countCaptureUnitKeys, countLifecycleReceiptSchema } from "../domain/count-lifecycle-receipt";
import { scrydexCountQuery } from "../../source-observations/api/providers/scrydex/adapter";
import { syntheticCountCaptureAuthority } from "./count-capture-fixture";

export function syntheticCountLifecycleReceipt() {
  const quoteId = "00000000-0000-4000-8000-000000000001";
  const hash = "f".repeat(64);
  const acquisitions = (["cards", "sealed"] as const).map((kind) => ({
    evidence: {
      query: scrydexCountQuery({
        environment: "staging",
        accountRevision: "synthetic",
        productDomain: "one-piece",
        profileKey: `synthetic-${kind}`,
        profileVersion: "synthetic-1",
        kind,
        languageCode: "en",
        parentValue: "OP01",
        unitKey: countCaptureUnitKeys[kind === "cards" ? 1 : 2],
      }),
      validationKind: "page-1-count",
      sourceId: `synthetic-${kind}-debit`,
      totalCount: kind === "cards" ? 121 : 7,
      pageSize: 100,
      returnedPage: 1,
      returnedItemCount: kind === "cards" ? 100 : 7,
      observedAt: "2026-10-13T08:03:02.000Z",
      expiresAt: "2026-10-13T08:18:02.000Z",
    },
    debitId: `synthetic-${kind}-debit`,
    quoteId,
    debitedAt: "2026-10-13T08:03:00.000Z",
    credits: 1,
    reused: false,
    priorReceiptHash: null,
  }));
  const consumption = (["preview", "pre-confirm"] as const).flatMap((phase, index) =>
    acquisitions.map((acquired) => {
      const readAt = `2026-10-13T08:0${4 + index}:10.000Z`;
      return {
        phase,
        requestId: `synthetic-${phase}-request`,
        kind: acquired.evidence.query.kind,
        query: acquired.evidence.query,
        source: acquired.evidence,
        readAt,
        ageMs: Date.parse(readAt) - Date.parse(acquired.evidence.observedAt),
        estimate: Math.max(1, Math.ceil(acquired.evidence.totalCount / 100)),
        planFingerprint: hash,
      };
    }),
  );
  const sends = acquisitions.map((acquired, index) => ({
    phase: "acquisition",
    requestId: "synthetic-acquisition-request",
    sequence: index + 1,
    category: acquired.evidence.query.kind,
    requestFingerprint: acquired.evidence.query.requestFingerprint,
    debitedAt: "2026-10-13T08:03:01.000Z",
    respondedAt: "2026-10-13T08:03:02.000Z",
    status: 200,
    outcome: "response",
  }));
  const usageSends = (["preview", "pre-confirm"] as const).flatMap((phase, index) =>
    countCaptureUnitKeys.map((unitKey, unitIndex) => ({
      phase,
      requestId: `synthetic-${phase}-request`,
      sequence: 3 + index * 3 + unitIndex,
      category: "usage",
      usage: { purpose: "planImport", unitKey },
      requestFingerprint: hash,
      debitedAt: `2026-10-13T08:0${4 + index}:01.000Z`,
      respondedAt: `2026-10-13T08:0${4 + index}:02.000Z`,
      status: 200,
      outcome: "response",
    })),
  );
  return countLifecycleReceiptSchema.parse({
    schemaVersion: "scope-sync-count-lifecycle/v1",
    runId: "synthetic-run",
    authority: syntheticCountCaptureAuthority(),
    startedAt: "2026-10-13T08:02:00.000Z",
    frozenAt: "2026-10-13T08:06:00.000Z",
    selection: {
      scopeRecordId: "synthetic-scope",
      productDomain: "one-piece",
      parentValue: "OP01",
      languageCode: "en",
    },
    units: countCaptureUnitKeys.map((unitKey, index) => ({
      unitKey,
      profileKey: `synthetic-${["set", "cards", "sealed"][index]}`,
      profileVersion: "synthetic-1",
      mappingId: `synthetic-${index}`,
      mappingVersion: "2026-10-13T07:00:00.000Z",
      estimate: index === 1 ? 2 : 1,
      blockers: [],
    })),
    notices: {
      initialAt: "2026-10-13T08:02:01.000Z",
      finalAt: "2026-10-13T08:02:02.000Z",
      approvalAt: "2026-10-13T08:03:00.000Z",
      quoteId,
      quoteFingerprint: hash,
      membershipFingerprint: hash,
      authorityFingerprint: hash,
      plannedCount: 2,
      serverCap: 2,
    },
    usage: {
      bootstrap: "skipped",
      observedAt: "2026-10-13T08:01:00.000Z",
      providerUpdatedAt: null,
      remainingCredits: 100,
      unreflectedCredits: 2,
      reservedCredits: 2,
      lagCategory: "documented-window",
      persisted: true,
    },
    acquisitions,
    consumption,
    sends: [...sends, ...usageSends],
    preConfirm: {
      comparedFingerprint: hash,
      currentFingerprint: hash,
      eligible: true,
      blockers: [],
      effectsCapability: false,
    },
    effects: {
      baselineAt: "2026-10-13T08:02:00.000Z",
      finalAt: "2026-10-13T08:06:00.000Z",
      batches: 0,
      reservations: 0,
      jobs: 0,
      enqueues: 0,
      imports: 0,
      complete: true,
    },
    freezeCollection: { ...syntheticCountCaptureAuthority().collection, collectedAt: "2026-10-13T08:06:00.000Z" },
    stopReasons: [],
  });
}
