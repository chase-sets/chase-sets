import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { getPolicyDocument, listActivePolicyDocuments, listPolicyRegistry } from "@chase-sets/platform-policy/queries";
import type { PlatformOperationsApiEnv } from "../../../api";
import type {
  CreatePolicyConsoleRevisionRequest,
  PolicyConsoleEntry,
  PolicyConsoleOverview,
  PolicyConsoleRegistryItem,
  PolicyConsoleUpcomingRevision,
} from "./contracts";

/**
 * The registry-driven admin surface for the platform policy console: lists every policy
 * declared by the migration slices, grouped by owning context, with history
 * and scheduled-revision support. See `contracts.ts` for the read/write
 * seam this route is built on.
 *
 * Gated by the new `platform-policy.view` / `platform-policy.manage`
 * permission pair rather than each owning context's own narrower
 * permission (`payouts.manage`, `security.manage`, ...): this console is a
 * deliberately more privileged, unified surface, so `manage` is restricted
 * to `platform-admin` alone (see the role grants in
 * `bounded-contexts/identity/features/memberships/read-model/constants.ts`
 * and `bounded-contexts/auth/support/auth-support/constants.ts`). Every
 * revision still stamps the acting user through the shared machinery
 * (`actorUserId` on the command), so it appears in that policy's own
 * detail history regardless of which surface wrote it.
 */

export const COMMERCIAL_TERMS_SCHEDULES_HREF = "/commerce/terms";

function requireAccess(
  c: { get(key: "actor"): PlatformOperationsApiEnv["Variables"]["actor"] },
  permission: "platform-policy.view" | "platform-policy.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("platformOperations.features.policyConsole.api.route.authentication.required"),
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authorization_forbidden",
            message: t("platformOperations.features.policyConsole.api.route.forbidden"),
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : t("platformOperations.features.policyConsole.api.route.request.failed");
}

function findEntry(entries: readonly PolicyConsoleEntry[], policyKey: string) {
  return entries.find((entry) => entry.policyKey === policyKey) ?? null;
}

function requestBody(body: Record<string, unknown>): CreatePolicyConsoleRevisionRequest {
  return {
    value: (body.value ?? null) as CreatePolicyConsoleRevisionRequest["value"],
    status: body.status === "inactive" ? "inactive" : "active",
    effectiveFrom: typeof body.effectiveFrom === "string" ? body.effectiveFrom : new Date().toISOString(),
    effectiveUntil:
      typeof body.effectiveUntil === "string" && body.effectiveUntil.trim().length > 0 ? body.effectiveUntil : null,
  };
}

export function createPolicyConsoleRoutes(entries: readonly PolicyConsoleEntry[]) {
  const app = new Hono<PlatformOperationsApiEnv>();

  app.get("/", async (c) => {
    const access = requireAccess(c, "platform-policy.view");
    if (access.response) {
      return access.response;
    }

    const knownKeys = new Set(entries.map((entry) => entry.policyKey));
    const dbByContext = new Map(entries.map((entry) => [entry.contextName, entry.db]));

    const rowsByContext = await Promise.all(Array.from(dbByContext.values()).map((db) => listPolicyRegistry(db)));
    const items: PolicyConsoleRegistryItem[] = rowsByContext
      .flat()
      .filter((row) => knownKeys.has(row.policy_key))
      .map((row) => ({
        policyKey: row.policy_key,
        contextName: row.context_name,
        schemaSummary: row.schema_summary,
        status: row.status,
        value: row.value as PolicyConsoleRegistryItem["value"],
        effectiveFrom: row.effective_from,
        effectiveUntil: row.effective_until,
        updatedAt: row.updated_at,
      }));

    // Policies declared but never revised have no document row yet -- the
    // registry read model is derived from documents, not a separate
    // catalog. Surface them with their compiled defaults so the console
    // still lists every declared policy, matching AC 1.
    const seenKeys = new Set(items.map((item) => item.policyKey));
    for (const entry of entries) {
      if (seenKeys.has(entry.policyKey)) {
        continue;
      }
      items.push({
        policyKey: entry.policyKey,
        contextName: entry.contextName,
        schemaSummary: entry.definition.schemaSummary,
        status: "fallback",
        value: entry.definition.defaultValue,
        effectiveFrom: "",
        effectiveUntil: null,
        updatedAt: "",
      });
    }

    return c.json({
      items,
      commercialTermsSchedulesHref: COMMERCIAL_TERMS_SCHEDULES_HREF,
    });
  });

  app.get("/:policyKey", async (c) => {
    const access = requireAccess(c, "platform-policy.view");
    if (access.response) {
      return access.response;
    }

    const entry = findEntry(entries, c.req.param("policyKey"));
    if (!entry) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("platformOperations.features.policyConsole.api.route.policy.not.found"),
          },
        },
        404,
      );
    }

    const overview = await loadOverview(entry);
    return c.json(overview);
  });

  app.get("/:policyKey/documents/:documentId", async (c) => {
    const access = requireAccess(c, "platform-policy.view");
    if (access.response) {
      return access.response;
    }

    const entry = findEntry(entries, c.req.param("policyKey"));
    if (!entry) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("platformOperations.features.policyConsole.api.route.policy.not.found"),
          },
        },
        404,
      );
    }

    const document = await getPolicyDocument(entry.db, c.req.param("documentId"));
    if (!document || document.policy_key !== entry.policyKey) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("platformOperations.features.policyConsole.api.route.document.not.found"),
          },
        },
        404,
      );
    }

    return c.json(document);
  });

  app.post("/:policyKey/revisions", async (c) => {
    const access = requireAccess(c, "platform-policy.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("platformOperations.features.policyConsole.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const entry = findEntry(entries, c.req.param("policyKey"));
    if (!entry) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("platformOperations.features.policyConsole.api.route.policy.not.found"),
          },
        },
        404,
      );
    }

    const body = requestBody(await c.req.json());

    try {
      const result = await createScheduledOrImmediateRevision(entry, body, access.actor.userId, context);
      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}

async function loadOverview(entry: PolicyConsoleEntry): Promise<PolicyConsoleOverview> {
  const active = await listActivePolicyDocuments(entry.db, entry.policyKey);
  const nowIso = new Date().toISOString();

  const current = active.find(
    (document) =>
      document.effective_from <= nowIso && (document.effective_until === null || nowIso < document.effective_until),
  );
  const upcoming: PolicyConsoleUpcomingRevision[] = active
    .filter((document) => document.effective_from > nowIso)
    .map((document) => ({
      documentId: document.document_id,
      status: document.status,
      value: document.value as PolicyConsoleUpcomingRevision["value"],
      effectiveFrom: document.effective_from,
      effectiveUntil: document.effective_until,
    }));

  return {
    policyKey: entry.policyKey,
    contextName: entry.contextName,
    schemaSummary: entry.definition.schemaSummary,
    current: current
      ? {
          source: "policy",
          documentId: current.document_id,
          status: current.status,
          value: current.value as PolicyConsoleOverview["current"]["value"],
          effectiveFrom: current.effective_from,
          effectiveUntil: current.effective_until,
        }
      : {
          source: "fallback",
          documentId: null,
          status: null,
          value: entry.definition.defaultValue,
          effectiveFrom: null,
          effectiveUntil: null,
        },
    upcoming,
  };
}

/**
 * Orchestrates the "effective now or future timestamp" scheduling AC. The
 * shared machinery revises a document in place (same document id, same
 * row) -- scheduling a revision for later without leaving a gap where the
 * resolver would fall back to the compiled default therefore takes two
 * steps when a document is currently active and the request is future
 * dated: close the current document's window at the new effective-from
 * instant, then create a new document for the scheduled value. Both steps
 * reuse the owning context's own `PolicyRuntime`, so both go through its
 * bounds validation (`definition.decodeValue`) and its overlap check
 * (`assertNoActiveOverlap`) unchanged.
 */
async function createScheduledOrImmediateRevision(
  entry: PolicyConsoleEntry,
  body: CreatePolicyConsoleRevisionRequest,
  actorUserId: string,
  context: NonNullable<PlatformOperationsApiEnv["Variables"]["context"]>,
) {
  const resolved = await entry.write.resolvePolicy(entry.definition);
  const isFutureDated = Date.parse(body.effectiveFrom) > Date.now();

  if (isFutureDated && resolved.source === "policy" && resolved.documentId && resolved.effectiveFrom) {
    await entry.write.revisePolicyDocument(
      entry.definition,
      resolved.documentId,
      {
        value: resolved.value,
        status: "active",
        effectiveFrom: resolved.effectiveFrom,
        effectiveUntil: body.effectiveFrom,
        actorUserId,
      },
      context,
    );
    const created = await entry.write.createPolicyDocument(
      entry.definition,
      {
        value: body.value,
        status: body.status,
        effectiveFrom: body.effectiveFrom,
        effectiveUntil: body.effectiveUntil,
        actorUserId,
      },
      context,
    );
    return { id: created.documentId, version: created.version, scheduled: true };
  }

  if (resolved.source === "policy" && resolved.documentId) {
    const revised = await entry.write.revisePolicyDocument(
      entry.definition,
      resolved.documentId,
      {
        value: body.value,
        status: body.status,
        effectiveFrom: body.effectiveFrom,
        effectiveUntil: body.effectiveUntil,
        actorUserId,
      },
      context,
    );
    return { id: revised.documentId, version: revised.version, scheduled: false };
  }

  const created = await entry.write.createPolicyDocument(
    entry.definition,
    {
      value: body.value,
      status: body.status,
      effectiveFrom: body.effectiveFrom,
      effectiveUntil: body.effectiveUntil,
      actorUserId,
    },
    context,
  );
  return { id: created.documentId, version: created.version, scheduled: isFutureDated };
}
