import { createHash } from "node:crypto";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { ReferenceRecordId } from "../../../ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { localizedTextMapFromEnglish, type CatalogValue } from "../../../support/runtime-support/common";
import {
  evolveProviderScopeMapping,
  initialProviderScopeMappingState,
  providerScopeMappingStreamId,
  type ProviderScopeMappingCommand,
  type ProviderScopeMappingEvent,
  type ProviderScopeMappingState,
} from "../../provider-scope-mapping/domain/domain";
import {
  buildProviderScopeMappingCandidate,
  isProviderScopeMappingAccepted,
  type ProviderScopeMappingReviewStatus,
} from "../../provider-scope-mapping/domain/mapping";
import { listProviderScopeMappingsByScopeRecord } from "../../provider-scope-mapping/read-model/queries";
import {
  evolveReferenceRecord,
  initialReferenceRecordState,
  isLegalReferenceRecordTransition,
  type ReferenceRecordCommand,
  type ReferenceRecordEvent,
  type ReferenceRecordState,
} from "../../reference-data/domain/domain";
import {
  catalogScopeProductDomainContracts,
  type CatalogScopeProductDomain,
  type CatalogScopeRecordKind,
} from "../../scope-registry/domain/contract";
import { getCatalogScopeRecord, type CatalogScopeRecordRow } from "../../scope-registry/read-model/queries";
import { scopeRecordIdentityKeys, scopeValueIdentityKeys } from "./scope-observation-matcher";
import {
  getCanonicalScopeRecordProposal,
  markCanonicalScopeRecordProposalAccepted,
  normalizeScopeMatchKey,
  type CanonicalScopeRecordProposalRecord,
} from "./scope-record-proposal-store";

export type CanonicalScopeRecordProposalAcceptRequest =
  | Readonly<{ mode: "bind"; scopeRecordId: string }>
  | Readonly<{
      mode: "create";
      parentScopeRecordId: string | null;
      releaseDate: string | null;
      officialSetCode: string | null;
    }>;

export type CanonicalScopeRecordProposalAcceptRefusal = Readonly<{
  status: 404 | 409 | 422;
  code:
    | "scope_record_proposal_not_found"
    | "scope_record_proposal_rejected"
    | "scope_record_proposal_accepted_elsewhere"
    | "scope_record_proposal_candidates_exist"
    | "scope_record_proposal_product_line_missing"
    | "scope_record_proposal_key_unavailable"
    | "scope_record_proposal_reference_history_conflict"
    | "scope_record_proposal_bind_target_ineligible"
    | "scope_record_proposal_kind_not_creatable"
    | "scope_record_proposal_field_not_fillable"
    | "scope_record_proposal_parent_ineligible"
    | "scope_record_proposal_attribute_missing";
  details: JsonObject;
}>;

export type ProviderScopeMappingRepoint = Readonly<{
  providerKey: string;
  unitKey: string;
  fromMappingId: string;
  toMappingId: string;
  retiredAs: "rejected" | "revoked";
  /** True when a retry found the target mapping this re-point proposed before it was interrupted. */
  targetAlreadyPresent: boolean;
}>;

export type ProviderScopeMappingRepointConflict = Readonly<{
  providerKey: string;
  unitKey: string;
  fromMappingId: string;
  keptMappingId: string;
  keptReviewStatus: ProviderScopeMappingReviewStatus;
  retiredAs: "rejected" | "revoked";
}>;

export type ProviderScopeMappingRepointSummary = Readonly<{
  repointed: readonly ProviderScopeMappingRepoint[];
  conflicts: readonly ProviderScopeMappingRepointConflict[];
  retained: readonly Readonly<{
    mappingId: string;
    providerKey: string;
    unitKey: string;
    reviewStatus: ProviderScopeMappingReviewStatus;
  }>[];
}>;

export type CanonicalScopeRecordProposalAcceptance = Readonly<{
  mode: CanonicalScopeRecordProposalAcceptRequest["mode"];
  scopeRecordId: string;
  proposal: CanonicalScopeRecordProposalRecord;
  /** Create mode only: the Reference Record events this request appended. */
  referenceRecord: Readonly<{ referenceRecordId: string; created: boolean; published: boolean }> | null;
  mappings: ProviderScopeMappingRepointSummary;
}>;

export type CanonicalScopeRecordProposalAcceptResult =
  | Readonly<{ ok: true; acceptance: CanonicalScopeRecordProposalAcceptance }>
  | Readonly<{ ok: false; refusal: CanonicalScopeRecordProposalAcceptRefusal }>;

export type CanonicalScopeRecordProposalAcceptancePorts = Readonly<{
  referenceRecordCommandHandler: CommandHandler<ReferenceRecordCommand, ReferenceRecordState, ReferenceRecordEvent>;
  providerScopeMappingCommandHandler: CommandHandler<
    ProviderScopeMappingCommand,
    ProviderScopeMappingState,
    ProviderScopeMappingEvent
  >;
}>;

type Refused = Readonly<{ ok: false; refusal: CanonicalScopeRecordProposalAcceptRefusal }>;

type CreateFields = Readonly<{
  ok: true;
  typeKey: CatalogScopeRecordKind;
  leaf: boolean;
  releaseDate: string | null;
  officialSetCode: string | null;
}>;

type CreatePlan = Readonly<{
  referenceRecordId: ReferenceRecordId;
  typeKey: CatalogScopeRecordKind;
  key: string;
  parentReferenceRecordId: string;
  attributes: Readonly<Record<string, CatalogValue>>;
}>;

type CandidateScopeRecordRow = Readonly<{
  scope_record_id: string;
  reference_record_id: string;
  reference_record_key: string;
  name: string;
  official_set_code: string | null;
  language_editions: readonly string[];
  lifecycle_status: string;
}>;

const MAX_CONCURRENCY_ATTEMPTS = 2;

/**
 * Accepts one canonical Scope Record proposal onto exactly one Scope Record:
 * bind onto an existing active or draft Scope Record, or create and publish one
 * Reference Record from the proposal's own facts. The Scope Record itself only
 * ever comes from Reference Record events through the Scope Registry
 * projection. A concurrent writer on the same streams loses its version fence
 * and the whole acceptance re-reads once, which resolves to the idempotent
 * result or a deterministic refusal.
 */
export async function acceptCanonicalScopeRecordProposal(
  deps: Pick<CatalogRuntimeDeps, "db" | "eventStore">,
  ports: CanonicalScopeRecordProposalAcceptancePorts,
  input: Readonly<{
    proposalId: string;
    request: CanonicalScopeRecordProposalAcceptRequest;
    actor: string;
    context: EventStoreContext;
  }>,
): Promise<CanonicalScopeRecordProposalAcceptResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await acceptOnce(deps, ports, input);
    } catch (error) {
      if (attempt >= MAX_CONCURRENCY_ATTEMPTS || !isConcurrencyConflict(error)) {
        throw error;
      }
    }
  }
}

export function acceptedReferenceRecordIdForProposal(proposalId: string): ReferenceRecordId {
  return `ref_${createHash("sha256").update(proposalId).digest("hex").slice(0, 26)}` as ReferenceRecordId;
}

/** The normalized code, else name, suffixed with the language editions; empty when neither normalizes. */
export function acceptedReferenceRecordKey(
  input: Readonly<{ officialSetCode: string | null; name: string; languageEditions: readonly string[] }>,
): string {
  const base = slug(input.officialSetCode ?? "") || slug(input.name);
  if (!base) {
    return "";
  }
  const languages = input.languageEditions.map(slug).filter(Boolean);
  return languages.length > 0 ? `${base}-${languages.join("-")}` : base;
}

async function acceptOnce(
  deps: Pick<CatalogRuntimeDeps, "db" | "eventStore">,
  ports: CanonicalScopeRecordProposalAcceptancePorts,
  input: Parameters<typeof acceptCanonicalScopeRecordProposal>[2],
): Promise<CanonicalScopeRecordProposalAcceptResult> {
  const proposal = await getCanonicalScopeRecordProposal(deps.db, input.proposalId);
  if (!proposal) {
    return refuse(404, "scope_record_proposal_not_found", { proposalId: input.proposalId });
  }
  if (proposal.reviewStatus === "rejected") {
    return refuse(409, "scope_record_proposal_rejected", { proposalId: proposal.proposalId });
  }

  const request = input.request;
  if (request.mode === "bind") {
    if (proposal.reviewStatus === "accepted") {
      return acceptedProposal(deps, ports, input, proposal, request.scopeRecordId, null);
    }
    const refusal = bindTargetRefusal(
      proposal,
      request.scopeRecordId,
      await getCatalogScopeRecord(deps.db, request.scopeRecordId),
    );
    if (refusal) {
      return refusal;
    }
    return transitionAndRepoint(deps, ports, input, proposal, request.scopeRecordId, null);
  }

  const referenceRecordId = acceptedReferenceRecordIdForProposal(proposal.proposalId);
  if (proposal.reviewStatus === "accepted") {
    return acceptedProposal(deps, ports, input, proposal, referenceRecordId, {
      referenceRecordId,
      created: false,
      published: false,
    });
  }

  const fields = fillCreateFields(proposal, request);
  if (!fields.ok) {
    return fields;
  }
  const history = await readReferenceRecordHistory(deps, referenceRecordId);
  if (!history) {
    return historyConflict(referenceRecordId);
  }
  if (history.version === 0) {
    const candidates = await listCreateCandidates(deps.db, proposal, fields.officialSetCode, referenceRecordId);
    if (candidates.length > 0) {
      return refuse(409, "scope_record_proposal_candidates_exist", { proposalId: proposal.proposalId, candidates });
    }
  }
  const planned = await planCreate(deps.db, proposal, fields, request.parentScopeRecordId, referenceRecordId);
  if (!planned.ok) {
    return planned;
  }
  const plan = planned.plan;

  let version = history.version;
  let created = false;
  if (version === 0) {
    const keyRefusal = await keyRefusalForCreate(deps.db, proposal, plan);
    if (keyRefusal) {
      return keyRefusal;
    }
    const result = await ports.referenceRecordCommandHandler({
      streamId: referenceRecordStreamId(plan.referenceRecordId),
      command: {
        type: "CreateReferenceRecord",
        referenceRecordId: plan.referenceRecordId,
        typeKey: plan.typeKey,
        key: plan.key,
        name: localizedTextMapFromEnglish(proposal.name),
        attributes: plan.attributes,
        relationships: [
          { relationshipType: "part-of", referenceId: plan.parentReferenceRecordId as ReferenceRecordId },
        ],
      },
      context: input.context,
      expectedVersion: 0,
    });
    version = result.version;
    created = true;
  } else if (!historyRepresentsPlan(history.state, plan)) {
    return historyConflict(plan.referenceRecordId);
  }

  let published = false;
  if (created || history.state.status === "draft") {
    await ports.referenceRecordCommandHandler({
      streamId: referenceRecordStreamId(plan.referenceRecordId),
      command: { type: "PublishReferenceRecord" },
      context: input.context,
      expectedVersion: version,
    });
    published = true;
  }

  return transitionAndRepoint(deps, ports, input, proposal, plan.referenceRecordId, {
    referenceRecordId: plan.referenceRecordId,
    created,
    published,
  });
}

async function transitionAndRepoint(
  deps: Pick<CatalogRuntimeDeps, "db" | "eventStore">,
  ports: CanonicalScopeRecordProposalAcceptancePorts,
  input: Parameters<typeof acceptCanonicalScopeRecordProposal>[2],
  proposal: CanonicalScopeRecordProposalRecord,
  targetScopeRecordId: string,
  referenceRecord: CanonicalScopeRecordProposalAcceptance["referenceRecord"],
): Promise<CanonicalScopeRecordProposalAcceptResult> {
  const transitioned =
    (await markCanonicalScopeRecordProposalAccepted(deps.db, {
      proposalId: proposal.proposalId,
      acceptedScopeRecordId: targetScopeRecordId,
    })) ?? (await getCanonicalScopeRecordProposal(deps.db, proposal.proposalId));
  if (!transitioned || transitioned.reviewStatus === "rejected") {
    return refuse(409, "scope_record_proposal_rejected", { proposalId: proposal.proposalId });
  }
  return acceptedProposal(deps, ports, input, transitioned, targetScopeRecordId, referenceRecord);
}

/**
 * An accepted proposal answers a repeat of the same acceptance idempotently and
 * finishes any unfinished re-point; acceptance onto any other target is refused.
 */
async function acceptedProposal(
  deps: Pick<CatalogRuntimeDeps, "db" | "eventStore">,
  ports: CanonicalScopeRecordProposalAcceptancePorts,
  input: Parameters<typeof acceptCanonicalScopeRecordProposal>[2],
  proposal: CanonicalScopeRecordProposalRecord,
  targetScopeRecordId: string,
  referenceRecord: CanonicalScopeRecordProposalAcceptance["referenceRecord"],
): Promise<CanonicalScopeRecordProposalAcceptResult> {
  if (proposal.reviewStatus !== "accepted" || proposal.acceptedScopeRecordId !== targetScopeRecordId) {
    return refuse(409, "scope_record_proposal_accepted_elsewhere", {
      proposalId: proposal.proposalId,
      acceptedScopeRecordId: proposal.acceptedScopeRecordId,
    });
  }
  return {
    ok: true,
    acceptance: {
      mode: input.request.mode,
      scopeRecordId: targetScopeRecordId,
      proposal,
      referenceRecord,
      mappings: await repointProposalMappings(deps, ports, {
        proposal,
        targetScopeRecordId,
        actor: input.actor,
        context: input.context,
      }),
    },
  };
}

/**
 * A bind target must be an active or draft Scope Record with the proposal's
 * product domain and scope kind whose language editions are empty or include
 * the proposal's.
 */
function bindTargetRefusal(
  proposal: CanonicalScopeRecordProposalRecord,
  scopeRecordId: string,
  target: CatalogScopeRecordRow | null,
): Refused | null {
  const reason = !target
    ? "missing"
    : target.lifecycle_status !== "active" && target.lifecycle_status !== "draft"
      ? "lifecycle"
      : target.product_domain !== proposal.productDomain
        ? "product-domain"
        : target.scope_kind !== proposal.scopeKind
          ? "scope-kind"
          : !languageEditionsInclude(stringList(target.language_editions), proposal.languageEditions)
            ? "language-editions"
            : null;
  return reason
    ? refuse(422, "scope_record_proposal_bind_target_ineligible", {
        proposalId: proposal.proposalId,
        scopeRecordId,
        reason,
      })
    : null;
}

/**
 * Create uses the contract type for the proposal's kind (the domain's leaf type
 * for expansion/set, `series` for series). Request values may only fill fields
 * the proposal lacks; repeating the proposal's own value is allowed.
 */
function fillCreateFields(
  proposal: CanonicalScopeRecordProposalRecord,
  request: Extract<CanonicalScopeRecordProposalAcceptRequest, { mode: "create" }>,
): CreateFields | Refused {
  const contract = catalogScopeProductDomainContracts[proposal.productDomain];
  const leaf = proposal.scopeKind === contract.leafReferenceTypeKey;
  if (!leaf && proposal.scopeKind !== "series") {
    return refuse(422, "scope_record_proposal_kind_not_creatable", {
      proposalId: proposal.proposalId,
      scopeKind: proposal.scopeKind,
    });
  }
  const releaseDate = fill(proposal.releaseDate, request.releaseDate);
  if (releaseDate === undefined) {
    return refuse(422, "scope_record_proposal_field_not_fillable", {
      proposalId: proposal.proposalId,
      field: "releaseDate",
    });
  }
  const officialSetCode = fill(proposal.officialSetCode, request.officialSetCode);
  if (officialSetCode === undefined) {
    return refuse(422, "scope_record_proposal_field_not_fillable", {
      proposalId: proposal.proposalId,
      field: "officialSetCode",
    });
  }
  return {
    ok: true,
    typeKey: leaf ? contract.leafReferenceTypeKey : contract.seriesReferenceTypeKey,
    leaf,
    releaseDate,
    officialSetCode,
  };
}

async function planCreate(
  db: PgQueryable,
  proposal: CanonicalScopeRecordProposalRecord,
  fields: CreateFields,
  parentScopeRecordId: string | null,
  referenceRecordId: ReferenceRecordId,
): Promise<Readonly<{ ok: true; plan: CreatePlan }> | Refused> {
  const parent = await resolveCreateParent(db, proposal.productDomain, parentScopeRecordId);
  if (!parent.ok) {
    return parent;
  }

  const attributes: Record<string, CatalogValue> = {};
  if (fields.releaseDate) {
    attributes["release-date"] = fields.releaseDate;
  }
  if (fields.officialSetCode) {
    attributes["official-set-code"] = fields.officialSetCode;
  }
  if (proposal.languageEditions.length > 0) {
    attributes["language-editions"] = [...proposal.languageEditions];
  }
  if (fields.leaf) {
    const missing = catalogScopeProductDomainContracts[proposal.productDomain].requiredLeafAttributeKeys.find(
      (key) => attributes[key] === undefined,
    );
    if (missing) {
      return refuse(422, "scope_record_proposal_attribute_missing", {
        proposalId: proposal.proposalId,
        attributeKey: missing,
      });
    }
  }

  return {
    ok: true,
    plan: {
      referenceRecordId,
      typeKey: fields.typeKey,
      key: acceptedReferenceRecordKey({
        officialSetCode: fields.officialSetCode,
        name: proposal.name,
        languageEditions: proposal.languageEditions,
      }),
      parentReferenceRecordId: parent.referenceRecordId,
      attributes,
    },
  };
}

/**
 * The default parent is the domain's exact contract product line, never any
 * other product line of the domain. An explicit parent must be an active
 * product-line or series Scope Record of the same domain.
 */
async function resolveCreateParent(
  db: PgQueryable,
  productDomain: CatalogScopeProductDomain,
  parentScopeRecordId: string | null,
): Promise<Readonly<{ ok: true; referenceRecordId: string }> | Refused> {
  if (parentScopeRecordId) {
    const parent = await getCatalogScopeRecord(db, parentScopeRecordId);
    if (
      !parent ||
      parent.product_domain !== productDomain ||
      parent.lifecycle_status !== "active" ||
      (parent.scope_kind !== "product-line" && parent.scope_kind !== "series")
    ) {
      return refuse(422, "scope_record_proposal_parent_ineligible", { parentScopeRecordId });
    }
    return { ok: true, referenceRecordId: parent.reference_record_id };
  }

  const referenceRecordKey = catalogScopeProductDomainContracts[productDomain].productLineReferenceRecordKey;
  const result = await db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id
     FROM catalog_scope_records
     WHERE product_domain = $1
       AND scope_kind = 'product-line'
       AND reference_record_key = $2
       AND lifecycle_status = 'active'`,
    [productDomain, referenceRecordKey],
  );
  const [productLine] = result.rows;
  if (!productLine || result.rows.length !== 1) {
    return refuse(409, "scope_record_proposal_product_line_missing", { productDomain, referenceRecordKey });
  }
  return { ok: true, referenceRecordId: productLine.reference_record_id };
}

/**
 * An empty key, or a key another Reference Record of the type already holds,
 * is refused rather than authored beside it.
 */
async function keyRefusalForCreate(
  db: PgQueryable,
  proposal: CanonicalScopeRecordProposalRecord,
  plan: CreatePlan,
): Promise<Refused | null> {
  if (!plan.key) {
    return refuse(409, "scope_record_proposal_key_unavailable", {
      proposalId: proposal.proposalId,
      referenceRecordKey: plan.key,
      reason: "empty",
    });
  }
  const taken = await db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id
     FROM catalog_reference_records
     WHERE type_key = $1
       AND key = $2
       AND reference_record_id <> $3
     LIMIT 1`,
    [plan.typeKey, plan.key, plan.referenceRecordId],
  );
  if (taken.rows[0]) {
    return refuse(409, "scope_record_proposal_key_unavailable", {
      proposalId: proposal.proposalId,
      referenceRecordKey: plan.key,
      reason: "taken",
      referenceRecordId: taken.rows[0].reference_record_id,
    });
  }
  return null;
}

/**
 * An active or draft Scope Record of the same domain and kind that matches by
 * the matcher's identity keys or a non-empty normalized name, and whose
 * language editions are empty or overlap the proposal's, is a candidate the
 * operator must bind instead of creating beside it. The language rule only
 * avoids false conflicts; it never pairs editions.
 */
async function listCreateCandidates(
  db: PgQueryable,
  proposal: CanonicalScopeRecordProposalRecord,
  officialSetCode: string | null,
  referenceRecordId: ReferenceRecordId,
): Promise<readonly JsonObject[]> {
  const result = await db.query<CandidateScopeRecordRow>(
    `SELECT scope_record_id,
            reference_record_id,
            reference_record_key,
            name,
            official_set_code,
            language_editions,
            lifecycle_status
     FROM catalog_scope_records
     WHERE product_domain = $1
       AND scope_kind = $2
       AND lifecycle_status IN ('draft', 'active')
       AND scope_record_id <> $3
     ORDER BY scope_record_id ASC`,
    [proposal.productDomain, proposal.scopeKind, referenceRecordId],
  );

  const proposalKeys = new Set(scopeValueIdentityKeys([officialSetCode, ...proposalEvidenceExternalIds(proposal)]));
  const proposalName = normalizeScopeMatchKey(proposal.name);
  return result.rows
    .map((row) => {
      const matchedBy = scopeRecordIdentityKeys(row).some((key) => proposalKeys.has(key))
        ? "identity"
        : proposalName && normalizeScopeMatchKey(row.name) === proposalName
          ? "normalized-name"
          : null;
      const languageEditions = stringList(row.language_editions);
      return matchedBy && languageEditionsOverlap(languageEditions, proposal.languageEditions)
        ? {
            scopeRecordId: row.scope_record_id,
            name: row.name,
            officialSetCode: row.official_set_code,
            languageEditions: [...languageEditions],
            lifecycleStatus: row.lifecycle_status,
            matchedBy,
          }
        : null;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
}

/**
 * Re-points every live mapping on the proposal's `proposed-scope-*` id onto the
 * accepted Scope Record as `proposed`, with identical coordinates and
 * provenance, then rejects (or revokes, when it was accepted) the old one with a
 * reason naming the target. Rejected and revoked mappings stay where they are.
 * Mappings are found through the mapping read model and, so a lagging
 * projection cannot hide the matcher's own mappings, the provider units recorded
 * in the proposal's evidence; each is then decided from its own stream. The
 * target is written before the old mapping is retired, so a retry after a crash
 * finds the old mapping still live and finishes the re-point.
 */
async function repointProposalMappings(
  deps: Pick<CatalogRuntimeDeps, "db" | "eventStore">,
  ports: CanonicalScopeRecordProposalAcceptancePorts,
  input: Readonly<{
    proposal: CanonicalScopeRecordProposalRecord;
    targetScopeRecordId: string;
    actor: string;
    context: EventStoreContext;
  }>,
): Promise<ProviderScopeMappingRepointSummary> {
  const sourceScopeRecordId = input.proposal.scopeRecordId;
  const units = new Map<string, Readonly<{ providerKey: string; unitKey: string }>>();
  const addUnit = (providerKey: string, unitKey: string) =>
    units.set(JSON.stringify([providerKey, unitKey]), { providerKey, unitKey });
  for (const row of await listProviderScopeMappingsByScopeRecord(deps.db, sourceScopeRecordId)) {
    addUnit(row.provider_key, row.unit_key);
  }
  for (const evidence of Object.values(input.proposal.evidence)) {
    if (isJsonObject(evidence) && typeof evidence.providerKey === "string" && typeof evidence.unitKey === "string") {
      addUnit(evidence.providerKey, evidence.unitKey);
    }
  }

  const reason = `Canonical Scope Record proposal ${input.proposal.proposalId} was accepted onto Scope Record ${input.targetScopeRecordId}.`;
  const repointed: ProviderScopeMappingRepoint[] = [];
  const conflicts: ProviderScopeMappingRepointConflict[] = [];
  const retained: Array<ProviderScopeMappingRepointSummary["retained"][number]> = [];
  for (const unit of [...units.values()].sort(compareUnits)) {
    const sourceStreamId = providerScopeMappingStreamId({ scopeRecordId: sourceScopeRecordId, ...unit });
    const source = await readMapping(deps, sourceStreamId);
    const sourceState = source.state;
    if (!sourceState.mappingId || !sourceState.reviewStatus || !sourceState.coordinates || !sourceState.provenance) {
      continue;
    }
    if (sourceState.reviewStatus === "rejected" || sourceState.reviewStatus === "revoked") {
      retained.push({ mappingId: sourceState.mappingId, ...unit, reviewStatus: sourceState.reviewStatus });
      continue;
    }

    const targetStreamId = providerScopeMappingStreamId({ scopeRecordId: input.targetScopeRecordId, ...unit });
    const target = await readMapping(deps, targetStreamId);
    const retiredAs = isProviderScopeMappingAccepted(sourceState.reviewStatus) ? "revoked" : "rejected";
    if (!target.state.mappingId) {
      const candidate = buildProviderScopeMappingCandidate({
        scopeRecordId: input.targetScopeRecordId,
        providerKey: unit.providerKey,
        unitKey: unit.unitKey,
        coordinates: sourceState.coordinates,
        confidence: sourceState.confidence ?? "generated",
        reviewStatus: "proposed",
        provenance: sourceState.provenance,
        evidence: {
          ...sourceState.evidence,
          proposedCanonicalScopeRecord: false,
          canonicalScopeRecordProposalId: input.proposal.proposalId,
          repointedFromScopeRecordId: sourceScopeRecordId,
        },
      });
      await ports.providerScopeMappingCommandHandler({
        streamId: targetStreamId,
        command: { type: "ProposeProviderScopeMapping", candidate, actor: input.actor },
        context: input.context,
        expectedVersion: 0,
      });
      repointed.push({
        ...unit,
        fromMappingId: sourceState.mappingId,
        toMappingId: candidate.mappingId,
        retiredAs,
        targetAlreadyPresent: false,
      });
    } else if (isThisRepoint(target.state, input.proposal.proposalId, sourceScopeRecordId)) {
      repointed.push({
        ...unit,
        fromMappingId: sourceState.mappingId,
        toMappingId: target.state.mappingId,
        retiredAs,
        targetAlreadyPresent: true,
      });
    } else {
      conflicts.push({
        ...unit,
        fromMappingId: sourceState.mappingId,
        keptMappingId: target.state.mappingId,
        keptReviewStatus: target.state.reviewStatus!,
        retiredAs,
      });
    }

    await ports.providerScopeMappingCommandHandler({
      streamId: sourceStreamId,
      command:
        retiredAs === "revoked"
          ? { type: "RevokeProviderScopeMapping", actor: input.actor, reason }
          : { type: "RejectProviderScopeMapping", actor: input.actor, reason },
      context: input.context,
      expectedVersion: source.version,
    });
  }

  return { repointed, conflicts, retained };
}

async function readReferenceRecordHistory(
  deps: Pick<CatalogRuntimeDeps, "eventStore">,
  referenceRecordId: ReferenceRecordId,
): Promise<Readonly<{ state: ReferenceRecordState; version: number }> | null> {
  const history = await readCompleteStream(deps.eventStore, { streamId: referenceRecordStreamId(referenceRecordId) });
  const codec = createPassthroughDomainEventCodec<ReferenceRecordEvent>();
  let state = initialReferenceRecordState;
  for (const stored of history) {
    const event = codec.decode(stored);
    if (!isLegalReferenceRecordTransition(state, event, referenceRecordId)) {
      return null;
    }
    state = evolveReferenceRecord(state, event);
  }
  return { state, version: history[history.length - 1]?.streamVersion ?? 0 };
}

/** A resumed stream must be the record this proposal plans, still draft or active. */
function historyRepresentsPlan(state: ReferenceRecordState, plan: CreatePlan): boolean {
  const parents = state.relationships.filter((relationship) => relationship.relationshipType === "part-of");
  return (
    state.typeKey === plan.typeKey &&
    state.key === plan.key &&
    parents.length === 1 &&
    parents[0]!.referenceId === plan.parentReferenceRecordId &&
    (state.status === "draft" || state.status === "active")
  );
}

async function readMapping(
  deps: Pick<CatalogRuntimeDeps, "eventStore">,
  streamId: string,
): Promise<Readonly<{ state: ProviderScopeMappingState; version: number }>> {
  const history = await readCompleteStream(deps.eventStore, { streamId });
  const codec = createPassthroughDomainEventCodec<ProviderScopeMappingEvent>();
  const state = history.reduce(
    (folded, stored) => evolveProviderScopeMapping(folded, codec.decode(stored)),
    initialProviderScopeMappingState,
  );
  return { state, version: history[history.length - 1]?.streamVersion ?? 0 };
}

/**
 * The target mapping this same re-point proposed before a crash, still live.
 * Any other mapping the target already holds for the unit is kept and reported
 * as a conflict.
 */
function isThisRepoint(target: ProviderScopeMappingState, proposalId: string, sourceScopeRecordId: string): boolean {
  return (
    target.reviewStatus !== "rejected" &&
    target.reviewStatus !== "revoked" &&
    target.evidence.canonicalScopeRecordProposalId === proposalId &&
    target.evidence.repointedFromScopeRecordId === sourceScopeRecordId
  );
}

function proposalEvidenceExternalIds(proposal: CanonicalScopeRecordProposalRecord): readonly string[] {
  return Object.values(proposal.evidence).flatMap((evidence) =>
    isJsonObject(evidence) && typeof evidence.externalId === "string" ? [evidence.externalId] : [],
  );
}

/** Undefined means the request tried to replace a value the proposal already has. */
function fill(proposalValue: string | null, requestValue: string | null): string | null | undefined {
  if (requestValue === null) {
    return proposalValue;
  }
  return proposalValue === null || proposalValue === requestValue ? requestValue : undefined;
}

function languageEditionsInclude(target: readonly string[], proposal: readonly string[]): boolean {
  return target.length === 0 || proposal.every((language) => target.includes(language));
}

function languageEditionsOverlap(record: readonly string[], proposal: readonly string[]): boolean {
  return record.length === 0 || record.some((language) => proposal.includes(language));
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim().toLowerCase())
    : [];
}

function slug(value: string): string {
  return normalizeScopeMatchKey(value).replace(/ /g, "-");
}

function compareUnits(
  left: Readonly<{ providerKey: string; unitKey: string }>,
  right: Readonly<{ providerKey: string; unitKey: string }>,
): number {
  return left.providerKey.localeCompare(right.providerKey) || left.unitKey.localeCompare(right.unitKey);
}

function referenceRecordStreamId(referenceRecordId: string): string {
  return `catalog.reference-record-${referenceRecordId}`;
}

function historyConflict(referenceRecordId: string): Refused {
  return refuse(409, "scope_record_proposal_reference_history_conflict", { referenceRecordId });
}

function refuse(
  status: CanonicalScopeRecordProposalAcceptRefusal["status"],
  code: CanonicalScopeRecordProposalAcceptRefusal["code"],
  details: JsonObject,
): Refused {
  return { ok: false, refusal: { status, code, details } };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConcurrencyConflict(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "concurrency_conflict";
}
