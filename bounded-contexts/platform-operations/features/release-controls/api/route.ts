import type { AuthenticatedApiEnv, ResolvedActor } from "@chase-sets/auth-context";
import { Hono } from "hono";
import {
  normalizeRolloutEnvironment,
  normalizeRolloutSubjectType,
  type RolloutSubject,
} from "@chase-sets/release-controls";
import { canSubjectReadDecision } from "../read-model/policy-contracts";
import type { ReleaseControlsPolicyServices } from "./runtime";

export type PlatformOperationsApiEnv = AuthenticatedApiEnv;

function apiError(code: string, message: string, status: number) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireActor(
  c: { get(key: "actor"): PlatformOperationsApiEnv["Variables"]["actor"] },
  permission?: "security.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return { actor: null, response: apiError("authentication_required", "Authentication required.", 401) };
  }

  if (permission && !actor.permissions.includes(permission)) {
    return { actor: null, response: apiError("authorization_forbidden", "Forbidden.", 403) };
  }

  return { actor, response: null };
}

function requireContext(c: { get(key: "context"): PlatformOperationsApiEnv["Variables"]["context"] }) {
  const context = c.get("context");
  if (!context) {
    return {
      context: null,
      response: apiError("authentication_context_missing", "Authentication context missing.", 401),
    };
  }

  return { context, response: null };
}

function policyActor(actor: ResolvedActor) {
  return { userId: actor.userId, accountId: actor.accountId };
}

function readSubject(actor: ResolvedActor, query: (key: string) => string | undefined): RolloutSubject {
  const subjectType = normalizeRolloutSubjectType(query("subjectType"));
  const explicitSubjectId = query("subjectId")?.trim();

  return {
    subjectType,
    subjectId:
      explicitSubjectId ||
      (subjectType === "operator" ? actor.userId : subjectType === "anonymous" ? "anonymous" : actor.accountId),
  };
}

export function createReleaseControlsPolicyRoutes(services: ReleaseControlsPolicyServices) {
  const app = new Hono<PlatformOperationsApiEnv>();

  app.get("/", async (c) => {
    const access = requireActor(c, "security.manage");
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getPolicySnapshot());
  });

  app.post("/release-lock", async (c) => {
    const access = requireActor(c, "security.manage");
    if (access.response) {
      return access.response;
    }
    const authContext = requireContext(c);
    if (authContext.response) {
      return authContext.response;
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    try {
      return c.json(
        await services.setReleaseLock(
          {
            locked: Boolean(body.locked),
            reason: typeof body.reason === "string" ? body.reason : "",
            reference: typeof body.reference === "string" ? body.reference : "",
            actor: policyActor(access.actor),
          },
          authContext.context,
        ),
      );
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.put("/rollouts/:featureKey", async (c) => {
    const access = requireActor(c, "security.manage");
    if (access.response) {
      return access.response;
    }
    const authContext = requireContext(c);
    if (authContext.response) {
      return authContext.response;
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    try {
      return c.json(
        await services.setRolloutPolicy(
          {
            featureKey: c.req.param("featureKey"),
            environment: normalizeRolloutEnvironment(body.environment),
            percentage: Number(body.percentage ?? 0),
            allowSubjects:
              Array.isArray(body.allowSubjects) || typeof body.allowSubjects === "string" ? body.allowSubjects : [],
            optOutSubjects:
              Array.isArray(body.optOutSubjects) || typeof body.optOutSubjects === "string" ? body.optOutSubjects : [],
            killSwitchActive: Boolean(body.killSwitchActive),
            reason: String(body.reason ?? ""),
            reference: String(body.reference ?? ""),
            actor: policyActor(access.actor),
          },
          authContext.context,
        ),
      );
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/rollouts/:featureKey/decision", async (c) => {
    const access = requireActor(c);
    if (access.response) {
      return access.response;
    }
    const subject = readSubject(access.actor, (key) => c.req.query(key));

    if (!canSubjectReadDecision(access.actor, subject)) {
      return apiError("authorization_forbidden", "Forbidden.", 403);
    }

    return c.json(
      await services.evaluateRollout({
        featureKey: c.req.param("featureKey"),
        environment: normalizeRolloutEnvironment(c.req.query("environment")),
        subject,
      }),
    );
  });

  return app;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}
