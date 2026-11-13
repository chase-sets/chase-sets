import { Hono } from "hono";
import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import type { Context } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type {
  CanonicalScopeRecordProposalAcceptRefusal,
  CanonicalScopeRecordProposalAcceptRequest,
} from "./proposal-acceptance";
import type { ProviderScopeDiscoveryServices } from "./runtime";
import type { ProviderScopeObservationRecord } from "./refresh-schedule-store";
import type {
  CanonicalScopeRecordProposalRecord,
  CanonicalScopeRecordProposalReviewStatus,
} from "./scope-record-proposal-store";

// Provider scope refresh schedule surface: visible to catalog viewers,
// pausable/resumable/runnable by catalog managers. The schedule itself is
// config-driven (provider-refresh-cadence.ts); these routes expose the
// operational state and the operator pause control the providers surface
// renders. Catalog managers also accept canonical Scope Record proposals here.
export function providerScopeDiscoveryRoutes(services: ProviderScopeDiscoveryServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/refresh-schedule", async (c) => {
    const permissionError = requirePermission(c, "catalog.view");
    if (permissionError) {
      return permissionError;
    }

    const items = await services.listRefreshSchedules();
    return c.json({ items, total: items.length, count: items.length });
  });

  app.post("/refresh-schedule/:providerKey/pause", async (c) => {
    const permissionError = requirePermission(c, "catalog.manage");
    if (permissionError) {
      return permissionError;
    }

    const body = await optionalJsonBody(c);
    const schedule = await services.setRefreshPaused({
      providerKey: c.req.param("providerKey"),
      paused: true,
      actor: actorLabel(c),
      reason: typeof body?.reason === "string" ? body.reason : null,
    });
    if (!schedule) {
      return providerNotFound(c);
    }
    return c.json(schedule);
  });

  app.post("/refresh-schedule/:providerKey/resume", async (c) => {
    const permissionError = requirePermission(c, "catalog.manage");
    if (permissionError) {
      return permissionError;
    }

    const schedule = await services.setRefreshPaused({
      providerKey: c.req.param("providerKey"),
      paused: false,
      actor: actorLabel(c),
    });
    if (!schedule) {
      return providerNotFound(c);
    }
    return c.json(schedule);
  });

  app.post("/refresh-schedule/:providerKey/run", async (c) => {
    const permissionError = requirePermission(c, "catalog.manage");
    if (permissionError) {
      return permissionError;
    }

    const result = await services.runProviderRefreshNow({
      providerKey: c.req.param("providerKey"),
      context: c.get("context"),
      triggeredBy: actorLabel(c),
    });
    return c.json(result, result.status === "failed" ? 502 : 200);
  });

  app.get("/scope-observations", async (c) => {
    const permissionError = requirePermission(c, "catalog.view");
    if (permissionError) {
      return permissionError;
    }

    const items = await services.listScopeObservations(scopeObservationListParams(c.req.query()));
    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/canonical-scope-record-proposals", async (c) => {
    const permissionError = requirePermission(c, "catalog.view");
    if (permissionError) {
      return permissionError;
    }

    const items = await services.listCanonicalScopeRecordProposals(scopeRecordProposalListParams(c.req.query()));
    return c.json({ items, total: items.length, count: items.length });
  });

  app.post("/canonical-scope-record-proposals/:proposalId/accept", async (c) => {
    const permissionError = requirePermission(c, "catalog.manage");
    if (permissionError) {
      return permissionError;
    }

    const request = parseScopeRecordProposalAcceptRequest(await optionalJsonBody(c));
    if (!request) {
      return c.json(
        {
          error: {
            code: "scope_record_proposal_accept_invalid_request",
            message: t("catalog.features.providerScopeDiscovery.api.route.accept.invalid.request"),
          },
        },
        400,
      );
    }

    const result = await services.acceptCanonicalScopeRecordProposal({
      proposalId: c.req.param("proposalId"),
      request,
      actor: actorLabel(c),
      context: c.get("context"),
    });
    if (!result.ok) {
      return c.json(
        {
          error: {
            code: result.refusal.code,
            message: t(acceptRefusalMessageKeys[result.refusal.code]),
            details: result.refusal.details,
          },
        },
        result.refusal.status,
      );
    }
    return c.json(result.acceptance);
  });

  return app;
}

const acceptRefusalMessageKeys = {
  scope_record_proposal_not_found: "catalog.features.providerScopeDiscovery.api.route.accept.proposal.not.found",
  scope_record_proposal_rejected: "catalog.features.providerScopeDiscovery.api.route.accept.proposal.rejected",
  scope_record_proposal_accepted_elsewhere:
    "catalog.features.providerScopeDiscovery.api.route.accept.proposal.accepted.elsewhere",
  scope_record_proposal_candidates_exist: "catalog.features.providerScopeDiscovery.api.route.accept.candidates.exist",
  scope_record_proposal_product_line_missing:
    "catalog.features.providerScopeDiscovery.api.route.accept.product.line.missing",
  scope_record_proposal_key_unavailable: "catalog.features.providerScopeDiscovery.api.route.accept.key.unavailable",
  scope_record_proposal_reference_history_conflict:
    "catalog.features.providerScopeDiscovery.api.route.accept.reference.history.conflict",
  scope_record_proposal_bind_target_ineligible:
    "catalog.features.providerScopeDiscovery.api.route.accept.bind.target.ineligible",
  scope_record_proposal_kind_not_creatable:
    "catalog.features.providerScopeDiscovery.api.route.accept.kind.not.creatable",
  scope_record_proposal_field_not_fillable:
    "catalog.features.providerScopeDiscovery.api.route.accept.field.not.fillable",
  scope_record_proposal_parent_ineligible: "catalog.features.providerScopeDiscovery.api.route.accept.parent.ineligible",
  scope_record_proposal_attribute_missing: "catalog.features.providerScopeDiscovery.api.route.accept.attribute.missing",
} as const satisfies Record<CanonicalScopeRecordProposalAcceptRefusal["code"], string>;

/**
 * Exactly one mode: `{ "bind": { "scopeRecordId" } }` or
 * `{ "create": { "parentScopeRecordId"?, "releaseDate"?, "officialSetCode"? } }`.
 * Unknown keys, a blank value, or a release date that is not YYYY-MM-DD refuse.
 */
export function parseScopeRecordProposalAcceptRequest(
  body: Readonly<Record<string, unknown>> | null,
): CanonicalScopeRecordProposalAcceptRequest | null {
  const modes = body ? Object.keys(body) : [];
  if (modes.length !== 1) {
    return null;
  }
  const payload = body![modes[0]!];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const fields = payload as Record<string, unknown>;
  if (modes[0] === "bind") {
    const scopeRecordId = requestText(fields.scopeRecordId);
    return onlyKeys(fields, ["scopeRecordId"]) && scopeRecordId ? { mode: "bind", scopeRecordId } : null;
  }
  if (modes[0] !== "create" || !onlyKeys(fields, ["parentScopeRecordId", "releaseDate", "officialSetCode"])) {
    return null;
  }
  const values = {
    parentScopeRecordId: optionalRequestText(fields.parentScopeRecordId),
    releaseDate: optionalRequestText(fields.releaseDate),
    officialSetCode: optionalRequestText(fields.officialSetCode),
  };
  if (Object.values(values).includes(undefined) || (values.releaseDate && !isIsoDate(values.releaseDate))) {
    return null;
  }
  return {
    mode: "create",
    parentScopeRecordId: values.parentScopeRecordId ?? null,
    releaseDate: values.releaseDate ?? null,
    officialSetCode: values.officialSetCode ?? null,
  };
}

function onlyKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function requestText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Absent is null; present but not a non-blank string is undefined (invalid). */
function optionalRequestText(value: unknown): string | null | undefined {
  return value === undefined || value === null ? null : (requestText(value) ?? undefined);
}

function isIsoDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function stringQueryValue(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : value === undefined || value === null ? undefined : String(value);
}

export function scopeObservationListParams(
  record: Readonly<Record<string, unknown>>,
): Parameters<NonNullable<ProviderScopeDiscoveryServices["listScopeObservations"]>>[0] {
  return {
    providerKey: stringQueryValue(record, "providerKey"),
    unitKey: stringQueryValue(record, "unitKey"),
    scopeKind: scopeKindQueryValue(stringQueryValue(record, "scopeKind")),
    limit: positiveIntegerQueryValue(stringQueryValue(record, "limit")) ?? undefined,
  };
}

export function scopeRecordProposalListParams(
  record: Readonly<Record<string, unknown>>,
): Parameters<NonNullable<ProviderScopeDiscoveryServices["listCanonicalScopeRecordProposals"]>>[0] {
  return {
    reviewStatus: proposalReviewStatusQueryValue(stringQueryValue(record, "reviewStatus")),
    productDomain: productDomainQueryValue(stringQueryValue(record, "productDomain")),
    limit: positiveIntegerQueryValue(stringQueryValue(record, "limit")) ?? undefined,
  };
}

function scopeKindQueryValue(value: string | undefined): ProviderScopeObservationRecord["scopeKind"] | null {
  return value === "language" ||
    value === "product-line" ||
    value === "series" ||
    value === "expansion" ||
    value === "set"
    ? value
    : null;
}

function proposalReviewStatusQueryValue(value: string | undefined): CanonicalScopeRecordProposalReviewStatus | null {
  return value === "proposed" || value === "accepted" || value === "rejected" ? value : null;
}

function productDomainQueryValue(
  value: string | undefined,
): CanonicalScopeRecordProposalRecord["productDomain"] | null {
  return value === "pokemon" || value === "magic" || value === "yugioh" || value === "one-piece" || value === "lorcana"
    ? value
    : null;
}

function requirePermission(c: Context<CatalogAuthoringEnv>, permission: "catalog.view" | "catalog.manage") {
  const actor = c.get("actor");
  if (!actor) {
    return c.json(authenticationRequiredResponse(), 401);
  }
  if (!actor.permissions.includes(permission)) {
    return c.json(forbiddenResponse(), 403);
  }
  return null;
}

function providerNotFound(c: Context<CatalogAuthoringEnv>) {
  return c.json(
    {
      error: {
        code: "provider_refresh_schedule_not_found",
        message: t("catalog.features.providerScopeDiscovery.api.route.schedule.not.found"),
      },
    },
    404,
  );
}

function actorLabel(c: Context<CatalogAuthoringEnv>): string {
  return `user:${c.get("context").audit.performedByUserId}`;
}

function positiveIntegerQueryValue(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function optionalJsonBody(c: Context<CatalogAuthoringEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body = (await c.req.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
