import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { catalogAliasStreamId } from "../../../alias-equivalence/domain/domain";
import type {
  CatalogAliasCommand,
  CatalogAliasEvent,
  CatalogAliasState,
} from "../../../alias-equivalence/domain/domain";
import type { CatalogAliasCandidate } from "../../../alias-equivalence/domain/alias";
import {
  planPromotionAliases,
  type PromotionAliasCandidate,
  type PromotionAliasPlan,
  type PromotionAliasTargetResolution,
  type PromotionPublishedAlias,
} from "./provider-promotion-alias-planner";

// ---------------------------------------------------------------------------
// Promotion alias writer
//
// Bridges the pure promotion alias plan to the Catalog Alias aggregate. The
// writer reads the reviewed candidate rows an observation produced, reads the
// aliases already published for the resolved targets, runs the planner, and
// drives the aggregate command handler so each accepted alias becomes a Catalog
// fact and each retraction is revoked.
//
// All aggregate commands are idempotent (keyed by alias hash), so re-promoting
// or reapplying a scope updates aliases without duplicating facts: `Propose`
// is a no-op when nothing changed, `Accept` is a no-op when already publishable,
// and `Revoke` is a no-op when already revoked. The writer is therefore safe to
// run on every promotion/reapply pass.
// ---------------------------------------------------------------------------

/** Actor recorded for system-driven promotion alias acceptance/revocation. */
export const PROMOTION_ALIAS_SYSTEM_ACTOR = "system";

const PROMOTION_ALIAS_ACCEPT_REASON = "Accepted alias promoted from reviewed Source Observation evidence.";
const PROMOTION_ALIAS_REVOKE_REASONS: Record<string, string> = {
  "rejected-candidate": "Alias candidate was rejected in review; retracting the promoted alias fact.",
  "revoked-candidate": "Alias candidate was revoked in review; retracting the promoted alias fact.",
};

export type PromotionAliasReader = Readonly<{
  /** Reviewed alias candidates an observation produced (intake rows). */
  listCandidatesForObservation: (observationId: string) => Promise<readonly PromotionAliasCandidate[]>;
  /** Aliases already published for a Catalog Item, for retraction detection. */
  listPublishedCatalogItemAliases: (catalogItemId: string) => Promise<readonly PromotionPublishedAlias[]>;
  /** Aliases already published for a Reference Record, for retraction detection. */
  listPublishedReferenceRecordAliases: (referenceRecordId: string) => Promise<readonly PromotionPublishedAlias[]>;
}>;

export type PromotionAliasServices = PromotionAliasReader &
  Readonly<{
    catalogAliasCommandHandler: CommandHandler<CatalogAliasCommand, CatalogAliasState, CatalogAliasEvent>;
  }>;

export type WritePromotionAliasesInput = Readonly<{
  services: PromotionAliasServices;
  observationId: string;
  resolution: PromotionAliasTargetResolution;
  context: EventStoreContext;
}>;

export type WritePromotionAliasesResult = Readonly<{
  proposed: number;
  accepted: number;
  retracted: number;
}>;

/**
 * Plan and write the durable alias facts for one promoted/reapplied observation.
 * Returns counts for telemetry/tests. No-ops cleanly when the observation has no
 * reviewed alias candidates, so promotion of provider products (which produce no
 * aliases) is unaffected.
 */
export async function writePromotionAliases(input: WritePromotionAliasesInput): Promise<WritePromotionAliasesResult> {
  const candidates = await input.services.listCandidatesForObservation(input.observationId);
  const publishedReferenceRecordAliasesByRecordId = await collectPublishedReferenceRecordAliases(
    input.services,
    input.resolution.referenceRecordIdsByTypeKey,
  );
  const publishedCatalogItemAliases = await input.services.listPublishedCatalogItemAliases(
    input.resolution.catalogItemId,
  );

  const plan = planPromotionAliases({
    candidates,
    resolution: input.resolution,
    publishedCatalogItemAliases,
    publishedReferenceRecordAliasesByRecordId,
  });

  return executePromotionAliasPlan({
    plan,
    catalogAliasCommandHandler: input.services.catalogAliasCommandHandler,
    context: input.context,
  });
}

async function collectPublishedReferenceRecordAliases(
  services: PromotionAliasReader,
  referenceRecordIdsByTypeKey: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, readonly PromotionPublishedAlias[]>>> {
  const recordIds = [...new Set(Object.values(referenceRecordIdsByTypeKey))];
  const entries = await Promise.all(
    recordIds.map(
      async (recordId) => [recordId, await services.listPublishedReferenceRecordAliases(recordId)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

export async function executePromotionAliasPlan(input: {
  plan: PromotionAliasPlan;
  catalogAliasCommandHandler: PromotionAliasServices["catalogAliasCommandHandler"];
  context: EventStoreContext;
}): Promise<WritePromotionAliasesResult> {
  let proposed = 0;
  let accepted = 0;
  let retracted = 0;

  for (const action of input.plan.actions) {
    if (action.kind === "propose") {
      await proposeAlias(input, action.candidate);
      proposed += 1;
      if (action.accept) {
        await acceptAlias(input, action.candidate);
        accepted += 1;
      }
    } else {
      await revokeAlias(input, action.aliasHash, action.reason);
      retracted += 1;
    }
  }

  return { proposed, accepted, retracted };
}

async function proposeAlias(
  input: {
    catalogAliasCommandHandler: PromotionAliasServices["catalogAliasCommandHandler"];
    context: EventStoreContext;
  },
  candidate: CatalogAliasCandidate,
): Promise<void> {
  await input.catalogAliasCommandHandler({
    streamId: catalogAliasStreamId(candidate.aliasHash),
    command: { type: "ProposeCatalogAlias", candidate, actor: PROMOTION_ALIAS_SYSTEM_ACTOR },
    context: input.context,
  });
}

async function acceptAlias(
  input: {
    catalogAliasCommandHandler: PromotionAliasServices["catalogAliasCommandHandler"];
    context: EventStoreContext;
  },
  candidate: CatalogAliasCandidate,
): Promise<void> {
  // Auto-accepted candidates already land publishable via the proposed event;
  // accepting again is idempotent. Pending candidates that policy resolved to
  // accepted are accepted explicitly so the published row carries the system
  // acceptance audit.
  if (candidate.reviewStatus === "auto-accepted") {
    return;
  }
  await input.catalogAliasCommandHandler({
    streamId: catalogAliasStreamId(candidate.aliasHash),
    command: { type: "AcceptCatalogAlias", actor: PROMOTION_ALIAS_SYSTEM_ACTOR, reason: PROMOTION_ALIAS_ACCEPT_REASON },
    context: input.context,
  });
}

async function revokeAlias(
  input: {
    catalogAliasCommandHandler: PromotionAliasServices["catalogAliasCommandHandler"];
    context: EventStoreContext;
  },
  aliasHash: string,
  reason: string,
): Promise<void> {
  await input.catalogAliasCommandHandler({
    streamId: catalogAliasStreamId(aliasHash),
    command: {
      type: "RevokeCatalogAlias",
      actor: PROMOTION_ALIAS_SYSTEM_ACTOR,
      reason: PROMOTION_ALIAS_REVOKE_REASONS[reason] ?? "Retracting promoted alias fact.",
    },
    context: input.context,
  });
}
