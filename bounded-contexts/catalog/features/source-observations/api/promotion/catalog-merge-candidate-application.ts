import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { CatalogRuntimeDeps } from "../../../../support/authoring-support/runtime-support";
import type { CatalogItemId, ReferenceRecordId } from "../../../../ids";
import type { ReferenceDataServices } from "../../../reference-data/api/runtime";
import {
  decideCatalogItem,
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemCommand,
  type CatalogItemEvent,
  type CatalogItemState,
} from "../../../catalog-items/domain/domain";
import type { SourceObservationState } from "../../domain/domain";
import {
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateCommand,
  type CatalogMergeCandidateEvent,
  type CatalogMergeCandidatePromotionApplication,
  type CatalogMergeCandidatePromotionPlan,
  type CatalogMergeCandidateReviewSnapshot,
  type CatalogMergeCandidateState,
} from "../../domain/catalog-merge-candidate";
import {
  assertCatalogIntegrationProfileUnitAllowed,
  type CatalogIntegrationRolloutControlPolicy,
} from "../governance/catalog-integration-rollout-controls";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import { createCatalogProviderIntegrationProfileVersionStore } from "../providers/provider-integration-profile-store";
import { catalogProviderProfileVersionsCompete } from "../providers/registry";
import {
  executeCatalogItemPromotionCommands,
  loadCatalogItemPromotionProfile,
  normalizePromotionProductAssetSet,
  promotionReferenceFieldKey,
  requireCatalogItemPromotionObservation,
  requireCatalogPromotionProfileVersion,
} from "../source-observation-promotion-execution";
import {
  resolvePromotionReferenceHierarchy,
  type CatalogItemPromotableSourceObservationNormalized,
} from "../source-observation-promotion-reference-hierarchy";
import type {
  CatalogMergeCandidateApplicationDiagnosticCode,
  CatalogMergeCandidateBulkUnitResult,
  CatalogProviderIntegrationProfileVersionReader,
} from "../source-observation-runtime-contracts";
import {
  catalogMergeCandidateReviewActor,
  catalogMergeCandidateStreamId,
  sourceObservationStreamId,
} from "../source-observation-stream-identity";
import {
  planCatalogMergeCandidatePromotionCommands,
  type CatalogMergeCandidatePromotionAssetPlan,
  type CatalogMergeCandidatePromotionCatalogMapping,
  type CatalogMergeCandidatePromotionFieldMapping,
} from "./catalog-merge-candidate-promotion-planner";
import { guardPromotionMaterial } from "./promotion-material-guards";
import {
  foldPromotionTargetSource,
  locatedPromotionSourceTargets,
  type PromotionTargetDiscovery,
} from "./promotion-target-discovery";
import type { PromotionTargetAuthority, PromotionTargetSession } from "./promotion-target-exclusion";
import {
  promotionTargetKeyIdentity,
  sourceObservationTargetId,
  type PromotionTargetKey,
} from "./promotion-target-identity";
import type { CatalogProviderPromotionResolvedCatalogMapping } from "./provider-promotion-command-planner";
import { resolveCatalogProviderDuplicatePrevention } from "./provider-duplicate-prevention-resolver";
import { promotionCurrentItem } from "./source-observation-target-exclusion";

export type CatalogMergeCandidateApplicationPorts = Readonly<{
  deps: CatalogRuntimeDeps;
  referenceData: ReferenceDataServices;
  profileVersions: CatalogProviderIntegrationProfileVersionReader;
  rolloutControlPolicy: Pick<CatalogIntegrationRolloutControlPolicy, "assertAllowed">;
  applyCandidateCommandAtVersion: (input: {
    candidateId: string;
    command: CatalogMergeCandidateCommand;
    expectedVersion: number;
    context: EventStoreContext;
  }) => Promise<CatalogMergeCandidateState>;
}>;

/**
 * A visible refusal of one candidate's application. `promotion-plan-blocked:*`
 * codes are preflight blocks with no Catalog Item writes; `promotion-application-*`
 * codes refuse a retained plan or target without retargeting or completing it.
 */
export class CatalogMergeCandidateApplicationError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
    readonly diagnosticCode?: CatalogMergeCandidateApplicationDiagnosticCode,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CatalogMergeCandidateApplicationError";
  }
}

const blocked = (code: string, detail?: string) =>
  new CatalogMergeCandidateApplicationError(`promotion-plan-blocked:${code}`, detail);
const refused = (code: string, detail?: string) =>
  new CatalogMergeCandidateApplicationError(`promotion-application-${code}`, detail);

export function catalogMergeCandidateTargetId(candidateId: string): string {
  return `cat_candidate_${createHash("sha256").update(candidateId).digest("hex")}`;
}

type LoadedCandidate = Readonly<{
  state: CatalogMergeCandidateState;
  version: number;
  approvalVersion: number | null;
}>;

type ApplicationUnit = Readonly<{
  candidateId: string;
  jobId: string;
  unitId: string;
  approvalReason: string;
  context: EventStoreContext;
}>;

type ResolvedMember = Readonly<{
  revision: SourceObservationState;
  normalized: CatalogItemPromotableSourceObservationNormalized;
  version: CatalogProviderIntegrationProfileVersionRecord;
  mapping: CatalogProviderPromotionResolvedCatalogMapping;
}>;

/**
 * Apply one approved (or ready-then-approved) candidate inside a version-1
 * scope promotion unit. Every decision folds the complete candidate, member and
 * target streams; projections only ever nominate reuse candidates.
 *
 * - applied: the initiating unit recovers its promoted result; any other unit skips.
 * - planned, not applied: resume the bound plan under the original target.
 * - ready: preflight, approve at the checked version, then bind the plan.
 * - approved without a plan: this unit plans and becomes the initiator.
 */
export async function applyCatalogMergeCandidatePromotion(
  ports: CatalogMergeCandidateApplicationPorts,
  unit: ApplicationUnit,
): Promise<CatalogMergeCandidateBulkUnitResult> {
  const loaded = await loadCandidateApplication(ports.deps.eventStore, unit.candidateId);
  const { state } = loaded;
  if (state.id === null || state.snapshot === null) {
    return unappliedOutcome(unit.candidateId, "skipped-not-eligible", "Catalog Merge Candidate was not found.");
  }
  const application = state.promotionApplication;
  if (application) {
    return application.jobId === unit.jobId && application.unitId === unit.unitId
      ? promotedOutcome(unit.candidateId, state.snapshot, application)
      : unappliedOutcome(
          unit.candidateId,
          "skipped-not-eligible",
          "Catalog Merge Candidate application is already complete.",
        );
  }
  if (state.promotionPlan) {
    return resumeBoundPlan(ports, unit, loaded, state.snapshot, state.promotionPlan);
  }
  if (state.status !== "ready" && state.status !== "promoted") {
    return unappliedOutcome(unit.candidateId, "skipped-not-eligible", `Catalog Merge Candidate is ${state.status}.`);
  }

  const approvalVersion = state.status === "promoted" ? loaded.approvalVersion! : loaded.version + 1;
  const prepared = await prepareApplicationPlan(ports, unit, state.snapshot, approvalVersion);
  let version = loaded.version;
  const now = new Date().toISOString();
  if (state.status === "ready") {
    await ports.applyCandidateCommandAtVersion({
      candidateId: unit.candidateId,
      command: {
        type: "PromoteCatalogMergeCandidate",
        reason: unit.approvalReason,
        actor: catalogMergeCandidateReviewActor(unit.context),
        promotedAt: now,
      },
      expectedVersion: version,
      context: unit.context,
    });
    version += 1;
  }
  await ports.applyCandidateCommandAtVersion({
    candidateId: unit.candidateId,
    command: { type: "PlanCatalogMergeCandidatePromotion", plan: prepared.plan, plannedAt: now },
    expectedVersion: version,
    context: unit.context,
  });
  return executeBoundPlan(ports, unit, state.snapshot, prepared.plan, prepared.session, version + 1);
}

/** Fold the complete candidate stream, refusing histories whose checkpoints do not bind its one approval. */
export async function loadCandidateApplication(eventStore: EventStore, candidateId: string): Promise<LoadedCandidate> {
  const history = await readCompleteStream(eventStore, { streamId: catalogMergeCandidateStreamId(candidateId) });
  const codec = createPassthroughDomainEventCodec<CatalogMergeCandidateEvent>();
  let state = initialCatalogMergeCandidateState;
  let approvalVersion: number | null = null;
  for (const stored of history) {
    state = evolveCatalogMergeCandidate(state, codec.decode(stored));
    if (stored.eventType === "catalog.merge-candidate.promoted") {
      if (approvalVersion !== null) throw refused("conflicting-history", "more than one approval is recorded");
      approvalVersion = stored.streamVersion;
    }
  }
  const plan = state.promotionPlan;
  const application = state.promotionApplication;
  if (
    plan &&
    (plan.approvalVersion !== approvalVersion || plan.identityFingerprint !== state.snapshot?.identityFingerprint)
  )
    throw refused("conflicting-history", "the application plan does not bind the recorded approval");
  if (
    application &&
    (!plan ||
      !isDeepStrictEqual(application, {
        approvalVersion: plan.approvalVersion,
        catalogItemId: plan.catalogItemId,
        appliedMode: plan.mode,
        planFingerprint: plan.planFingerprint,
        jobId: plan.jobId,
        unitId: plan.unitId,
      }))
  )
    throw refused("conflicting-history", "the recorded application does not complete its plan");
  return { state, version: history.at(-1)?.streamVersion ?? 0, approvalVersion };
}

async function prepareApplicationPlan(
  ports: CatalogMergeCandidateApplicationPorts,
  unit: ApplicationUnit,
  snapshot: CatalogMergeCandidateReviewSnapshot,
  approvalVersion: number,
): Promise<Readonly<{ plan: CatalogMergeCandidatePromotionPlan; session: PromotionTargetSession }>> {
  const { deps } = ports;
  const members = await resolveApprovedMemberRevisions(deps.eventStore, snapshot);
  const resolved: ResolvedMember[] = [];
  for (const revision of members) {
    const normalized = promotableNormalized(revision);
    if (!normalized) continue;
    let version: CatalogProviderIntegrationProfileVersionRecord;
    try {
      version = await requireCatalogPromotionProfileVersion(ports.profileVersions, revision.providerKey, normalized);
    } catch (error) {
      throw blocked("promotion-profile-unavailable", errorText(error));
    }
    assertCatalogIntegrationProfileUnitAllowed(ports.rolloutControlPolicy, "promotion", version);
    resolved.push({
      revision,
      normalized,
      version,
      mapping: await loadCatalogItemPromotionProfile(deps, version.profile),
    });
  }
  const primary = resolved[0];
  if (!primary) throw blocked("no-promotable-member", "no approved member has a Catalog Item promotion mapping");
  if (
    resolved.some(
      (member) =>
        member.normalized.kind !== primary.normalized.kind || !isDeepStrictEqual(member.mapping, primary.mapping),
    )
  )
    throw blocked(
      "profile-disagreement",
      "approved members resolve different Catalog blueprints, categories or fields",
    );

  // Idempotent Reference Record provisioning may precede a later block; it never writes a Catalog Item.
  const references = [];
  for (const member of resolved) {
    references.push(
      await resolvePromotionReferenceHierarchy({
        deps,
        referenceData: ports.referenceData,
        profile: member.version.profile,
        normalized: member.normalized,
        context: unit.context,
      }),
    );
  }
  const reference = references[0]!;
  if (references.some((entry) => entry.targetReferenceRecordId !== reference.targetReferenceRecordId))
    throw blocked("reference-provenance-ambiguous", "approved members resolve different hierarchy Reference Records");
  const catalog = candidateCatalogMapping(primary, reference.targetReferenceRecordId);

  // Projected duplicate evidence only nominates reuse candidates; discovery folds their streams.
  const reuseCandidates = new Set<string>(snapshot.matches.catalogItemId ? [snapshot.matches.catalogItemId] : []);
  for (const member of resolved) {
    const duplicate = await resolveCatalogProviderDuplicatePrevention({
      db: deps.db,
      profile: member.version.profile,
      providerKey: member.revision.providerKey,
      externalKey: member.revision.externalKey,
      normalized: member.normalized,
      catalog: primary.mapping,
    });
    if (duplicate.status === "blocked" || duplicate.status === "review-only")
      throw blocked("ambiguous-duplicate-candidates", duplicate.candidateCatalogItemIds.join(", "));
    if (duplicate.status === "matched") reuseCandidates.add(duplicate.catalogItemId);
  }

  const pinned = uniqueProfiles(resolved.map((member) => member.version));
  const session = await acquireCandidateTarget(ports, {
    candidateId: unit.candidateId,
    snapshot,
    boundTargetId: null,
    reuseCandidates: [...reuseCandidates],
    blueprintId: primary.mapping.blueprintId,
    validateAuthority: pinnedProfileAuthority(pinned),
    context: unit.context,
  });
  for (const member of resolved) {
    await guardPromotionMaterial({
      deps,
      session,
      profile: member.version.profile,
      mapping: primary.mapping,
      normalized: member.normalized,
    });
  }

  const targetId = session.targetId;
  const target = session.evidence.items.get(targetId)!;
  const baselineVersion = session.evidence.histories.get(`catalog.item-${targetId}`)?.at(-1)?.streamVersion ?? 0;
  const mode =
    target.id === null
      ? "create"
      : snapshot.promotionIntent === "link-existing-catalog-item"
        ? "link-existing"
        : "refresh";
  if (mode === "create" && snapshot.promotionIntent !== "create-catalog-item")
    throw blocked("missing-catalog-item-target", "the reviewed intent requires an existing Catalog Item");

  const assetPlan = await prepareCandidateAssets(deps, resolved, targetId as CatalogItemId);
  const planned = await planCatalogMergeCandidatePromotionCommands({
    db: deps.db,
    candidate: {
      candidateId: unit.candidateId,
      status: "promoted",
      snapshot: {
        ...snapshot,
        promotionIntent:
          mode === "create"
            ? "create-catalog-item"
            : mode === "refresh"
              ? "update-catalog-item"
              : "link-existing-catalog-item",
        matches: { ...snapshot.matches, catalogItemId: mode === "create" ? null : targetId },
      },
    },
    catalog,
    createCatalogItemId: mode === "create" ? (targetId as CatalogItemId) : null,
    assetPlan,
    promoteAsDraft: false,
    currentItem: mode === "create" ? null : promotionCurrentItem(target),
  });
  if (planned.status === "blocked") {
    throw blocked(
      planned.diagnostics[0]?.code ?? "unknown",
      planned.diagnostics.map((diagnostic) => diagnostic.diagnosticText).join(" "),
    );
  }

  const plan: CatalogMergeCandidatePromotionPlan = {
    approvalVersion,
    jobId: unit.jobId,
    unitId: unit.unitId,
    catalogItemId: targetId,
    mode,
    targetBaseline: { streamVersion: baselineVersion, status: target.id === null ? null : target.status },
    identityFingerprint: snapshot.identityFingerprint,
    membership: snapshot.membership,
    profiles: pinned.map((version) => ({
      providerKey: version.providerKey,
      profileKey: version.profileKey,
      profileVersion: version.profileVersion,
    })),
    catalogMapping: toJsonObject(catalog),
    referenceRecordIds: { ...reference.referenceRecordIdsByTypeKey },
    assetPlan: assetPlan ? toJsonObject(assetPlan) : null,
    commands: planned.plan.commands.map(toJsonObject),
    planFingerprint: planned.plan.planFingerprint,
  };
  return { plan, session };
}

/**
 * Resume a retained plan exactly: never re-plan, retarget or adopt current-active
 * content. A newer profile activation alone does not block completion; revoked
 * authority, missing evidence or unrelated target history refuses visibly and
 * leaves the checkpoint for explicit recovery.
 */
async function resumeBoundPlan(
  ports: CatalogMergeCandidateApplicationPorts,
  unit: ApplicationUnit,
  loaded: LoadedCandidate,
  snapshot: CatalogMergeCandidateReviewSnapshot,
  plan: CatalogMergeCandidatePromotionPlan,
): Promise<CatalogMergeCandidateBulkUnitResult> {
  const pinned = [];
  for (const profile of plan.profiles) {
    const version = requirePinnedProfileEligible(
      await ports.profileVersions.listProfileVersions(profile.providerKey),
      profile,
    );
    assertCatalogIntegrationProfileUnitAllowed(ports.rolloutControlPolicy, "promotion", version);
    pinned.push(version);
  }
  await requireBoundTargetHistory(ports.deps.eventStore, plan, "prefix");
  const session = await acquireCandidateTarget(ports, {
    candidateId: unit.candidateId,
    snapshot,
    boundTargetId: plan.catalogItemId,
    reuseCandidates: [],
    blueprintId: String(plan.catalogMapping.blueprintId),
    validateAuthority: pinnedProfileAuthority(pinned),
    context: unit.context,
  });
  for (const referenceRecordId of Object.values(plan.referenceRecordIds)) {
    const streamId = `catalog.reference-record-${String(referenceRecordId)}`;
    const history = await readCompleteStream(ports.deps.eventStore, { streamId });
    if (history.length === 0) throw refused("missing-reference-evidence", streamId);
    session.guard(streamId, history.at(-1)!.streamVersion);
  }
  return executeBoundPlan(ports, unit, snapshot, plan, session, loaded.version);
}

async function executeBoundPlan(
  ports: CatalogMergeCandidateApplicationPorts,
  unit: ApplicationUnit,
  snapshot: CatalogMergeCandidateReviewSnapshot,
  plan: CatalogMergeCandidatePromotionPlan,
  session: PromotionTargetSession,
  candidateVersion: number,
): Promise<CatalogMergeCandidateBulkUnitResult> {
  if (session.targetId !== plan.catalogItemId) throw refused("bound-elsewhere", session.targetId);
  await executeCatalogItemPromotionCommands({
    targetSession: session,
    plan: {
      catalogItemId: plan.catalogItemId,
      mode: plan.mode,
      commands: planCommands(plan),
      planFingerprint: portPlanFingerprint(plan.planFingerprint),
    },
    context: unit.context,
  });
  // Completion is proven from the authoritative stream, never from the command loop returning.
  await requireBoundTargetHistory(ports.deps.eventStore, plan, "complete");
  const application: CatalogMergeCandidatePromotionApplication = {
    approvalVersion: plan.approvalVersion,
    catalogItemId: plan.catalogItemId,
    appliedMode: plan.mode,
    planFingerprint: plan.planFingerprint,
    jobId: plan.jobId,
    unitId: plan.unitId,
  };
  try {
    await ports.applyCandidateCommandAtVersion({
      candidateId: unit.candidateId,
      command: {
        type: "RecordCatalogMergeCandidatePromotionApplied",
        application,
        appliedAt: new Date().toISOString(),
      },
      expectedVersion: candidateVersion,
      context: unit.context,
    });
  } catch (error) {
    // Only a lost version race can mean a concurrent unit recorded this same
    // completion; any other failure (including a lost lease) stays a failure.
    if (!isConcurrencyConflict(error)) throw error;
    const reloaded = await loadCandidateApplication(ports.deps.eventStore, unit.candidateId);
    if (!isDeepStrictEqual(reloaded.state.promotionApplication, application)) throw error;
  }
  return promotedOutcome(unit.candidateId, snapshot, application);
}

/**
 * Validate the target stream against the plan's bound baseline: the baseline
 * state must be unchanged and every later event must be the plan's own exact
 * event sequence (a prefix while resuming, the whole sequence on completion).
 */
async function requireBoundTargetHistory(
  eventStore: EventStore,
  plan: CatalogMergeCandidatePromotionPlan,
  expectation: "prefix" | "complete",
): Promise<void> {
  const history = await readCompleteStream(eventStore, { streamId: `catalog.item-${plan.catalogItemId}` });
  const baseline = plan.targetBaseline.streamVersion;
  if (history.length < baseline)
    throw refused("target-history-conflict", "the target is shorter than its bound baseline");
  const codec = createPassthroughDomainEventCodec<CatalogItemEvent>();
  let state = history.slice(0, baseline).map(codec.decode).reduce(evolveCatalogItem, initialCatalogItemState);
  if ((state.id === null ? null : state.status) !== plan.targetBaseline.status)
    throw refused("target-history-conflict", "the target baseline state changed");
  const expected: { eventType: string; payload: unknown }[] = [];
  for (const command of planCommands(plan)) {
    const events = decideCatalogItem(state, command);
    state = events.reduce(evolveCatalogItem, state);
    expected.push(...events.map((event) => ({ eventType: event.type, payload: jsonCopy(event.data) })));
  }
  const suffix = history
    .slice(baseline)
    .map((event) => ({ eventType: event.eventType, payload: jsonCopy(event.payload) }));
  const matches =
    expectation === "complete"
      ? isDeepStrictEqual(suffix, expected)
      : suffix.length <= expected.length && isDeepStrictEqual(suffix, expected.slice(0, suffix.length));
  if (!matches)
    throw refused(
      "target-history-conflict",
      expectation === "complete"
        ? "the target does not hold the bound plan's complete event sequence"
        : "unrelated events follow the bound baseline",
    );
}

async function acquireCandidateTarget(
  ports: CatalogMergeCandidateApplicationPorts,
  input: Readonly<{
    candidateId: string;
    snapshot: CatalogMergeCandidateReviewSnapshot;
    boundTargetId: string | null;
    reuseCandidates: readonly string[];
    blueprintId: string;
    validateAuthority: PromotionTargetAuthority;
    context: EventStoreContext;
  }>,
): Promise<PromotionTargetSession> {
  const boundary = ports.deps.promotionTargetExclusion;
  if (!boundary) throw new Error("promotion-target-exclusion-required");
  const allocated = catalogMergeCandidateTargetId(input.candidateId);
  return boundary.acquire({
    keys: candidateTargetKeys(input.snapshot),
    additionalTargetIds: [
      ...new Set([allocated, ...(input.boundTargetId ? [input.boundTargetId] : []), ...input.reuseCandidates]),
    ],
    context: input.context,
    validateAuthority: input.validateAuthority,
    selectTarget: async (evidence) => {
      const owners = completeTargetOwners(evidence, input.reuseCandidates, input.boundTargetId);
      if (input.boundTargetId) {
        const elsewhere = [...owners].filter((owner) => owner !== input.boundTargetId);
        if (elsewhere.length > 0) throw refused("bound-elsewhere", elsewhere.join(", "));
        return input.boundTargetId;
      }
      if (owners.size > 1) throw blocked("ambiguous-target", [...owners].sort().join(", "));
      const owner = [...owners][0];
      if (!owner) {
        // The allocated stream is only ever written after its plan is bound.
        if (evidence.items.get(allocated)?.id) throw refused("unplanned-target-history", allocated);
        return allocated;
      }
      const item = evidence.items.get(owner)!;
      if (item.status !== "draft" && item.status !== "active") throw blocked("inactive-target", owner);
      if (item.languageCode !== input.snapshot.identity.languageCode || item.blueprintId !== input.blueprintId)
        throw blocked("incompatible-target", owner);
      return owner;
    },
  });
}

/**
 * Existing Catalog Items that already hold this candidate's identity: bound
 * targets, reference owners, retained member targets and nominated duplicates.
 * A deterministic member target counts only with its member's recorded
 * completion; a partial or still-executing prefix is never a reuse match and
 * never "no match" either: it refuses.
 */
function completeTargetOwners(
  evidence: PromotionTargetDiscovery,
  reuseCandidates: readonly string[],
  boundTargetId: string | null,
): ReadonlySet<string> {
  const owners = new Set<string>();
  const nominate = (id: string) => {
    if (evidence.items.get(id)?.id) owners.add(id);
  };
  for (const binding of evidence.bindings.values()) if (binding) nominate(binding.targetId);
  for (const [id, item] of evidence.items) if (item.id && ownsCandidateKey(item, evidence)) owners.add(id);
  for (const source of evidence.sources.values()) locatedPromotionSourceTargets(evidence, source).forEach(nominate);
  reuseCandidates.forEach(nominate);

  const memberTargets = new Map([...evidence.sources.keys()].map((id) => [sourceObservationTargetId(id), id]));
  for (const owner of owners) {
    if (owner === boundTargetId) continue;
    if (hasIncompleteExecution(evidence, owner)) throw refused("partial-target", owner);
    const member = memberTargets.get(owner);
    if (member && !evidence.sources.get(member)!.revisions.some((revision) => revision.promotedCatalogItemId === owner))
      throw refused("partial-target", owner);
  }
  return owners;
}

function ownsCandidateKey(item: CatalogItemState, evidence: PromotionTargetDiscovery): boolean {
  return [
    ...item.externalCatalogItemReferences.map((reference) => ({ level: "item" as const, ...referenceKey(reference) })),
    ...item.externalProductReferences.map((reference) => ({ level: "product" as const, ...referenceKey(reference) })),
  ].some((key) => evidence.keys.has(promotionTargetKeyIdentity(key)));
}

function referenceKey(reference: Readonly<{ providerKey: string; externalKey: string }>) {
  return { providerKey: reference.providerKey, externalKey: reference.externalKey };
}

function hasIncompleteExecution(evidence: PromotionTargetDiscovery, targetId: string): boolean {
  const history = evidence.histories.get(`catalog.item-${targetId}`) ?? [];
  return [...evidence.bindings.values()].some((binding) => {
    if (!binding?.execution || binding.targetId !== targetId) return false;
    const expected = binding.execution.batches.flat();
    const actual = history
      .slice(binding.execution.baselineVersion, binding.execution.baselineVersion + expected.length)
      .map(({ eventType, payload }) => ({ eventType, payload }));
    return !isDeepStrictEqual(actual, expected);
  });
}

function candidateTargetKeys(snapshot: CatalogMergeCandidateReviewSnapshot): readonly PromotionTargetKey[] {
  return [
    ...snapshot.membership.map((member) => ({ level: "member" as const, observationId: member.observationId })),
    ...snapshot.proposedExternalCatalogItemReferences.map((reference) => ({
      level: "item" as const,
      ...referenceKey(reference),
    })),
    ...snapshot.proposedExternalProductReferences.map((reference) => ({
      level: "product" as const,
      ...referenceKey(reference),
    })),
  ];
}

/** The approved member revisions exactly as reviewed, folded from their streams; later revisions never substitute. */
async function resolveApprovedMemberRevisions(
  eventStore: EventStore,
  snapshot: CatalogMergeCandidateReviewSnapshot,
): Promise<readonly SourceObservationState[]> {
  const revisions: SourceObservationState[] = [];
  for (const member of snapshot.membership) {
    const history = await readCompleteStream(eventStore, { streamId: sourceObservationStreamId(member.observationId) });
    if (history.length === 0) throw blocked("member-revision-missing", member.observationId);
    let folded: ReturnType<typeof foldPromotionTargetSource>;
    try {
      folded = foldPromotionTargetSource(member.observationId, history);
    } catch (error) {
      throw refused("member-history-conflict", `${member.observationId}: ${errorText(error)}`);
    }
    const revision = [...folded.revisions]
      .reverse()
      .find(
        (candidate) =>
          candidate.providerKey === member.providerKey &&
          candidate.externalKey === member.externalKey &&
          candidate.sourceRecordHash === member.sourceRecordHash &&
          candidate.sourceProfileKey === member.sourceProfileKey &&
          candidate.sourceProfileVersion === member.sourceProfileVersion &&
          candidate.sourceMappingFingerprint === member.sourceMappingFingerprint,
      );
    if (!revision?.normalized) throw blocked("member-revision-missing", member.observationId);
    revisions.push(revision);
  }
  return revisions;
}

function promotableNormalized(
  revision: SourceObservationState,
): CatalogItemPromotableSourceObservationNormalized | null {
  try {
    return requireCatalogItemPromotionObservation(revision.normalized!, revision.providerKey);
  } catch {
    return null;
  }
}

function candidateCatalogMapping(
  primary: ResolvedMember,
  referenceRecordId: string,
): CatalogMergeCandidatePromotionCatalogMapping {
  const { fieldIds } = primary.mapping;
  const referenceField = promotionReferenceFieldKey(primary.normalized.kind);
  const referenceFieldId =
    referenceField === "expansion" ? fieldIds.expansion : referenceField === "set" ? fieldIds.set : null;
  if (referenceField && !referenceFieldId) throw blocked("missing-reference-record-target", referenceField);
  const fields: CatalogMergeCandidatePromotionFieldMapping[] = [
    {
      fieldPath: "catalogItem.name",
      fieldId: fieldIds.cardName,
      valueKind: "localized-text",
      factKey: "name",
      required: true,
    },
    {
      fieldPath: "catalogItem.collectorNumber",
      fieldId: fieldIds.cardNumber,
      valueKind: "raw",
      factKey: "collectorNumber",
    },
    { fieldPath: "catalogItem.rarity", fieldId: fieldIds.rarity, valueKind: "raw", factKey: "rarity" },
    { fieldPath: "catalogItem.releaseYear", fieldId: fieldIds.releaseYear, valueKind: "raw", factKey: "releaseYear" },
  ];
  if (referenceFieldId) {
    fields.push({
      fieldPath: referenceField === "expansion" ? "catalogItem.expansionName" : "catalogItem.setName",
      fieldId: referenceFieldId,
      valueKind: "reference-record",
      referenceRecordId: referenceRecordId as ReferenceRecordId,
      required: true,
    });
  }
  return { blueprintId: primary.mapping.blueprintId, categoryId: primary.mapping.categoryId, fields };
}

/**
 * Product images come from exactly one image evidence; disagreeing member
 * evidence is an ambiguous plan, never a first-member choice. Storage writes
 * are idempotent preparation, and a failure inside this boundary is classified.
 */
async function prepareCandidateAssets(
  deps: CatalogRuntimeDeps,
  resolved: readonly ResolvedMember[],
  catalogItemId: CatalogItemId,
): Promise<CatalogMergeCandidatePromotionAssetPlan | null> {
  const withImages = resolved.flatMap((member) => {
    const evidence = imageEvidence(member.normalized);
    return evidence ? [{ member, evidence }] : [];
  });
  const source = withImages[0];
  if (!source) return null;
  if (withImages.some((entry) => !isDeepStrictEqual(entry.evidence, source.evidence)))
    throw blocked("asset-provenance-ambiguous", "approved members carry different product image evidence");
  try {
    const productAssetSet = await normalizePromotionProductAssetSet({
      deps,
      catalogItemId,
      normalized: source.member.normalized,
      providerKey: source.member.revision.providerKey,
      providerProfile: source.member.version.profile,
      sourceUpdatedAt: source.member.revision.sourceUpdatedAt,
      observedAt: source.member.revision.observedAt ?? new Date(0).toISOString(),
    });
    return productAssetSet ? { productAssetSets: [productAssetSet] } : null;
  } catch (error) {
    throw new CatalogMergeCandidateApplicationError(
      "asset-processing-failed",
      errorText(error),
      "asset-processing-failed",
    );
  }
}

function imageEvidence(normalized: CatalogItemPromotableSourceObservationNormalized): JsonObject | null {
  if (normalized.kind === "pokemon-card" && normalized.imageBaseUrl) return { imageBaseUrl: normalized.imageBaseUrl };
  if (
    (normalized.kind === "lorcana-card-print" || normalized.kind === "lorcana-sealed-product") &&
    normalized.imageUrls.length
  )
    return { imageUrls: [...normalized.imageUrls] };
  return null;
}

type PinnedProfile = Readonly<{ providerKey: string; profileKey: string; profileVersion: string }>;

/**
 * A pinned profile stays eligible while it is active, or deprecated only
 * because a competing version (same profile key or ingestion unit) was activated. Any other deprecation, retirement,
 * removed promotion capability or missing record is revocation and refuses.
 */
export function requirePinnedProfileEligible(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  pinned: PinnedProfile,
): CatalogProviderIntegrationProfileVersionRecord {
  const matches = versions.filter(
    (version) =>
      version.providerKey === pinned.providerKey &&
      version.profileKey === pinned.profileKey &&
      version.profileVersion === pinned.profileVersion,
  );
  const version = matches[0];
  if (matches.length !== 1 || !version)
    throw refused("profile-missing", `${pinned.providerKey}@${pinned.profileVersion}`);
  const promotes = (candidate: CatalogProviderIntegrationProfileVersionRecord) =>
    candidate.profile.status === "active" && candidate.profile.capabilities.includes("catalog-item-promotion");
  if (!promotes(version)) throw refused("profile-revoked", `${pinned.providerKey}@${pinned.profileVersion}`);
  if (version.active && version.lifecycle === "active") return version;
  const superseded =
    version.lifecycle === "deprecated" &&
    versions.some(
      (other) =>
        other !== version &&
        other.active &&
        other.lifecycle === "active" &&
        promotes(other) &&
        other.profile.normalizedObservationMapping.kind === version.profile.normalizedObservationMapping.kind &&
        catalogProviderProfileVersionsCompete(other, version),
    );
  if (!superseded) throw refused("profile-revoked", `${pinned.providerKey}@${pinned.profileVersion}`);
  return version;
}

/** Revalidated under the canonical profile SHARE lock on the append client, so revocation cannot race the append. */
function pinnedProfileAuthority(pinned: readonly PinnedProfile[]): PromotionTargetAuthority {
  return async (client: PgQueryable) => {
    const store = createCatalogProviderIntegrationProfileVersionStore(client);
    for (const profile of pinned)
      requirePinnedProfileEligible(await store.listProfileVersions(profile.providerKey), profile);
  };
}

function uniqueProfiles(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
): readonly CatalogProviderIntegrationProfileVersionRecord[] {
  const unique = new Map(
    versions.map((version) => [
      JSON.stringify([version.providerKey, version.profileKey, version.profileVersion]),
      version,
    ]),
  );
  return [...unique.values()];
}

function planCommands(plan: CatalogMergeCandidatePromotionPlan): readonly CatalogItemCommand[] {
  return plan.commands as unknown as readonly CatalogItemCommand[];
}

function portPlanFingerprint(fingerprint: string): string {
  const hex = fingerprint.startsWith("sha256:") ? fingerprint.slice("sha256:".length) : fingerprint;
  if (!/^[a-f0-9]{64}$/.test(hex)) throw refused("invalid-plan-fingerprint", fingerprint);
  return hex;
}

function promotedOutcome(
  candidateId: string,
  snapshot: CatalogMergeCandidateReviewSnapshot,
  application: CatalogMergeCandidatePromotionApplication,
): CatalogMergeCandidateBulkUnitResult {
  return {
    candidateId,
    status: "promoted",
    catalogItemId: snapshot.matches.catalogItemId,
    reason: null,
    appliedCatalogItemId: application.catalogItemId,
    appliedMode: application.appliedMode,
    approvalVersion: application.approvalVersion,
    planFingerprint: application.planFingerprint,
  };
}

export function unappliedOutcome(
  candidateId: string,
  status: Exclude<CatalogMergeCandidateBulkUnitResult["status"], "promoted" | "deferred">,
  reason: string,
  diagnosticCode?: CatalogMergeCandidateApplicationDiagnosticCode,
): CatalogMergeCandidateBulkUnitResult {
  return {
    candidateId,
    status,
    catalogItemId: null,
    reason,
    appliedCatalogItemId: null,
    appliedMode: null,
    approvalVersion: null,
    planFingerprint: null,
    ...(diagnosticCode ? { diagnosticCode } : {}),
  };
}

function toJsonObject(value: unknown): JsonObject {
  return jsonCopy(value) as JsonObject;
}

function jsonCopy(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function isConcurrencyConflict(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "concurrency_conflict";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
