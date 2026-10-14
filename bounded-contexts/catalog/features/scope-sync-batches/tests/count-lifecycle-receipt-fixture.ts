import { countCaptureKindUnitKeys, countCaptureUnitKeys } from "../domain/count-capture-plan";

// Completely synthetic controls. No value here is a live staging, provider,
// deployment, review or spend observation; fixtures prove logic and shape only.
const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const image = `registry.example.invalid/synthetic/platform:${sha}@${digest}`;
const quoteId = "00000000-0000-4000-8000-000000000001";
const planFingerprint = "f".repeat(64);
const conforming = { verdict: "CONFORMING", reasons: [] as string[] };

export function syntheticCountCaptureAuthority() {
  return {
    dispatchId: "synthetic-dispatch",
    dispatchedAt: "2026-10-13T08:00:00.000Z",
    packetHash: "c".repeat(64),
    runnerSha: sha,
    review: { head: sha, receiptHash: "d".repeat(64), dispatchId: "synthetic-review" },
    budget: {
      withinAllowance: true,
      remainingCredits: 30,
      unreflectedCredits: 3,
      reservedCredits: 2,
      observedAt: "2026-10-13T08:00:00.000Z",
      countCap: 2,
      usageCap: 9,
      totalCap: 11,
    },
    deployment: {
      environment: "staging",
      runId: "100",
      attempt: 1,
      jobId: "200",
      jobName: "Deploy Staging",
      stepNumber: 35,
      stepName: "Deploy staging Kubernetes release",
      conclusion: "success",
      startedAt: "2026-10-13T07:40:00.000Z",
      completedAt: "2026-10-13T07:45:00.000Z",
      sha,
      digest,
      logSha: sha,
      logDigest: digest,
    },
    pods: {
      observedAt: "2026-10-13T08:01:00.000Z",
      adminReplicas: 1,
      apiReplicas: 2,
      ready: [
        { component: "admin", image, imageId: `docker-pullable://${image}` },
        { component: "api", image, imageId: `docker-pullable://${image}` },
        { component: "api", image, imageId: `docker-pullable://${image}` },
      ],
    },
    collection: syntheticCountCaptureCollection("2026-10-13T08:01:30.000Z"),
  };
}

export function syntheticCountCaptureCollection(collectedAt: string) {
  return {
    collectedAt,
    outcome: "bound",
    reason: null,
    binding: { runId: "100", attempt: 1, jobId: "200", stepNumber: 35, sha, digest },
    createdFrom: "2026-09-08T07:40:00.000Z",
    runCount: 4,
    attemptCount: 4,
    jobCount: 9,
    // One run page, an attempt read and a jobs page per attempt, the log and each definition.
    pageCount: 13,
    definitionCount: 3,
    nonMutatingJobCount: 5,
  };
}

function syntheticQuery(kind: "cards" | "sealed") {
  return {
    environment: "staging",
    accountRevision: "synthetic-account-revision",
    providerKey: "scrydex",
    productDomain: "one-piece",
    profileKey: `synthetic-${kind}`,
    profileVersion: "synthetic-1",
    unitKey: countCaptureKindUnitKeys[kind],
    kind,
    languageCode: "en",
    parentValue: "OP01",
    requestFingerprint: (kind === "cards" ? "1" : "2").repeat(64),
  };
}

function syntheticSend(
  sequence: number,
  phase: string,
  requestId: string,
  category: string,
  usage: { purpose: string; unitKey: string | null } | null,
  at: string,
) {
  return {
    sequence,
    phase,
    requestId,
    category,
    usage,
    requestFingerprint: (category === "cards" ? "1" : category === "sealed" ? "2" : "e").repeat(64),
    debitedAt: `2026-10-13T08:${at}.000Z`,
    respondedAt: `2026-10-13T08:${at}.500Z`,
    status: 200,
    outcome: "response",
  };
}

// The CONFORMING control: every Required Receipt Field is present, each card and
// sealed read consumes the page-1 source its own acquisition validated, and every
// send, phase, notice, effect and freeze fact is causally ordered.
export function syntheticCountLifecycleReceipt() {
  const acquisitions = (["cards", "sealed"] as const).map((kind) => ({
    evidence: {
      query: syntheticQuery(kind),
      validationKind: "page-1-count",
      sourceId: `synthetic-${kind}-debit`,
      totalCount: kind === "cards" ? 121 : 7,
      pageSize: 100,
      returnedPage: 1,
      returnedItemCount: kind === "cards" ? 100 : 7,
      observedAt: "2026-10-13T08:03:01.500Z",
      expiresAt: "2026-10-13T08:18:01.500Z",
    },
    debitId: `synthetic-${kind}-debit`,
    quoteId,
    kind,
    debitedAt: "2026-10-13T08:03:00.500Z",
    credits: 1,
    outcome: "complete",
    reused: false,
    priorReceiptHash: null,
    method: "GET",
  }));
  const planned = (["preview", "pre-confirm"] as const).map((phase, index) => ({
    phase,
    requestId: `synthetic-${phase}-request`,
    minute: 4 + index,
  }));
  const consumption = planned.flatMap(({ phase, requestId, minute }) =>
    acquisitions.map((acquired) => {
      const readAt = `2026-10-13T08:0${minute}:10.000Z`;
      const pages = Math.max(1, Math.ceil(acquired.evidence.totalCount / acquired.evidence.pageSize));
      return {
        phase,
        requestId,
        kind: acquired.kind,
        // Independent copies: each row is its own observation of the writer's source.
        query: structuredClone(acquired.evidence.query),
        source: structuredClone(acquired.evidence),
        readAt,
        ageMs: Date.parse(readAt) - Date.parse(acquired.evidence.observedAt),
        pages,
        estimate: pages,
        planFingerprint,
      };
    }),
  );
  const sends = [
    syntheticSend(1, "acquisition", "synthetic-acquisition-request", "cards", null, "03:01"),
    syntheticSend(2, "acquisition", "synthetic-acquisition-request", "sealed", null, "03:01"),
    ...planned.flatMap(({ phase, requestId, minute }, index) =>
      countCaptureUnitKeys.map((unitKey, unitIndex) =>
        syntheticSend(
          3 + index * 3 + unitIndex,
          phase,
          requestId,
          "usage",
          { purpose: "planImport", unitKey },
          `0${minute}:0${1 + unitIndex}`,
        ),
      ),
    ),
  ];
  return {
    schemaVersion: "scope-sync-count-lifecycle/v1",
    attribution: {
      dispatchId: "synthetic-dispatch",
      runnerRunId: "300",
      runnerRunAttempt: 1,
      runnerSha: sha,
      packetHash: "c".repeat(64),
      reviewReceiptHash: "d".repeat(64),
      phases: [
        { phase: "admission", startedAt: "2026-10-13T08:02:00.000Z", endedAt: "2026-10-13T08:02:05.000Z" },
        { phase: "baseline", startedAt: "2026-10-13T08:02:05.000Z", endedAt: "2026-10-13T08:02:07.000Z" },
        { phase: "quote", startedAt: "2026-10-13T08:02:10.000Z", endedAt: "2026-10-13T08:02:40.000Z" },
        { phase: "acquisition", startedAt: "2026-10-13T08:03:00.000Z", endedAt: "2026-10-13T08:03:05.000Z" },
        { phase: "preview", startedAt: "2026-10-13T08:04:00.000Z", endedAt: "2026-10-13T08:04:30.000Z" },
        { phase: "pre-confirm", startedAt: "2026-10-13T08:05:00.000Z", endedAt: "2026-10-13T08:05:30.000Z" },
        { phase: "freeze", startedAt: "2026-10-13T08:05:30.000Z", endedAt: "2026-10-13T08:06:00.000Z" },
      ],
    },
    authority: syntheticCountCaptureAuthority(),
    startedAt: "2026-10-13T08:02:00.000Z",
    frozenAt: "2026-10-13T08:06:00.000Z",
    selection: {
      scopeRecordId: "synthetic-scope",
      accountRevision: "synthetic-account-revision",
      productDomain: "one-piece",
      parentValue: "OP01",
      languageCode: "en",
    },
    access: {
      originHost: "admin.staging.chasesets.com",
      role: "platform-admin",
      permissions: ["catalog.view", "catalog.manage"],
      ownerMatch: true,
      checkedAt: "2026-10-13T08:02:01.000Z",
    },
    units: countCaptureUnitKeys.map((unitKey, index) => ({
      unitKey,
      profileKey: `synthetic-${["set", "cards", "sealed"][index]}`,
      profileVersion: "synthetic-1",
      mappingId: `synthetic-mapping-${index}`,
      mappingVersion: "2026-10-13T07:00:00.000Z",
      setCoordinate: "OP01",
      estimate: index === 1 ? 2 : 1,
      blockers: [],
    })),
    notices: {
      initial: { at: "2026-10-13T08:02:08.000Z", fingerprint: "9".repeat(64) },
      final: {
        at: "2026-10-13T08:02:45.000Z",
        fingerprint: "8".repeat(64),
        readBackAt: "2026-10-13T08:02:46.000Z",
        readBackFingerprint: "8".repeat(64),
      },
      approvalAt: "2026-10-13T08:03:00.000Z",
    },
    quote: {
      quoteId,
      fingerprint: "7".repeat(64),
      state: "complete",
      membershipFingerprint: "6".repeat(64),
      authorityFingerprint: "5".repeat(64),
      expiresAt: "2026-10-13T08:12:10.000Z",
      queries: [syntheticQuery("cards"), syntheticQuery("sealed")],
      missingKinds: ["cards", "sealed"],
      reusedKinds: [],
      plannedCredits: 2,
      cap: 2,
      perKindBound: 1,
    },
    usage: {
      bootstrap: "skipped",
      creditState: "available",
      totalCredits: 1000,
      remainingCredits: 100,
      usedCredits: 900,
      observedAt: "2026-10-13T08:01:00.000Z",
      ageMs: 120_000,
      providerUpdatedAt: null,
      lagCategory: "documented-window",
      unreflectedCredits: 2,
      reservedCredits: 2,
      additionalUsageCredits: 0,
      persisted: true,
    },
    acquisitions,
    consumption,
    sends,
    accounting: {
      possibleSends: { bootstrap: 0, acquisition: 2, preview: 3, "pre-confirm": 3, other: 0 },
      total: 8,
      debitedCountCredits: 2,
      plannedMaximumCredits: 10,
    },
    preConfirm: {
      comparedFingerprint: planFingerprint,
      currentFingerprint: planFingerprint,
      eligible: true,
      refusal: null,
      blockers: [],
      effectsCapability: false,
    },
    effects: {
      baseline: { at: "2026-10-13T08:02:06.000Z", batches: 4, reservations: 1, jobs: 9, enqueues: 9, imports: 3 },
      final: { at: "2026-10-13T08:06:00.000Z", batches: 4, reservations: 1, jobs: 9, enqueues: 9, imports: 3 },
      complete: true,
    },
    freezeCollection: syntheticCountCaptureCollection("2026-10-13T08:06:00.000Z"),
    stopReasons: [] as string[],
    classification: {
      ...conforming,
      acceptance: { "9431-ac7": conforming, "9424-ac5": conforming },
    },
  };
}

export function syntheticCountLifecycleStopReceipt() {
  const incomplete = { verdict: "INCOMPLETE", reasons: ["authority-unbound"] };
  return {
    schemaVersion: "scope-sync-count-lifecycle-stop/v1",
    attribution: {
      dispatchId: "synthetic-dispatch",
      runnerRunId: "300",
      runnerRunAttempt: 1,
      runnerSha: sha,
      packetHash: null,
      reviewReceiptHash: null,
      phases: [{ phase: "admission", startedAt: "2026-10-13T08:02:00.000Z", endedAt: "2026-10-13T08:02:01.000Z" }],
    },
    stoppedAt: "2026-10-13T08:02:01.000Z",
    phase: "admission",
    reason: "authority-unbound",
    evidence: {},
    classification: { ...incomplete, acceptance: { "9431-ac7": incomplete, "9424-ac5": incomplete } },
  };
}

// The ordinary preview or pre-confirm planner read of the CONFORMING control: the
// capture scope's three units, each count unit naming the source its winner read.
export function syntheticCountCapturePlannerRead(phase: "preview" | "pre-confirm" = "preview") {
  const receipt = syntheticCountLifecycleReceipt();
  const units = receipt.units.map((unit, index) => {
    const acquired = receipt.acquisitions[index - 1];
    return {
      providerKey: "scrydex",
      unitKey: unit.unitKey,
      profileKey: unit.profileKey,
      profileVersion: unit.profileVersion,
      selected: true,
      defaultSelected: true,
      eligibility: "eligible",
      requirement: "required",
      role: acquired ? "primary-source-observation" : "reference-data",
      estimate: {
        countSourceId: acquired?.evidence.sourceId ?? null,
        targetCount: acquired?.evidence.totalCount ?? null,
        estimatedRequestCount: unit.estimate,
        requestStrategy: "bulk-first",
        estimateState: "estimated",
        usageCheckState: "checked",
      },
      blockers: [] as string[],
    };
  });
  return {
    phase,
    requestId: `synthetic-${phase}-request`,
    planFingerprint: receipt.preConfirm.currentFingerprint,
    comparedFingerprint: phase === "preview" ? null : receipt.preConfirm.comparedFingerprint,
    eligible: true,
    refusal: null as string | null,
    effectsCapability: false,
    plan: {
      selection: { mode: "ids", scopeRecordIds: [receipt.selection.scopeRecordId] },
      budget: {
        maxScopesPerTurn: 1,
        defaultProviderConcurrency: 1,
        providerConcurrency: {},
        providerRequestLimits: {},
        creditedProviderRequestLimits: {},
        providerFailureThreshold: 1,
      },
      resolvedAt: receipt.startedAt,
      status: "ready",
      blockers: [],
      scopes: [
        {
          scopeRecordId: receipt.selection.scopeRecordId,
          scopeRecordVersion: receipt.startedAt,
          mappingVersions: [],
          profileVersions: units.map(({ providerKey, unitKey, profileKey, profileVersion }) => ({
            providerKey,
            unitKey,
            profileKey,
            profileVersion,
          })),
          scope: {
            scopeVersion: "catalog-sync-scope-v2",
            productDomain: "one-piece",
            reference: { kind: "set", scopeRecordId: receipt.selection.scopeRecordId },
          },
          providerUnitCount: units.length,
          status: "ready",
          startAllowed: true,
          blockers: [],
          participationBlockers: [],
          units,
        },
      ],
    },
    winners: receipt.acquisitions.map((acquired) => ({
      kind: acquired.kind,
      query: structuredClone(acquired.evidence.query),
      source: structuredClone(acquired.evidence) as Record<string, unknown> | null,
      readAt: phase === "preview" ? "2026-10-13T08:04:10.000Z" : "2026-10-13T08:05:10.000Z",
    })),
  };
}
