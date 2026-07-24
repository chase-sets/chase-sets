import { t } from "@chase-sets/localization";
import { hasPermission as hasActorPermission } from "@chase-sets/platform-runtime/auth";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  encodeCommitReceipt,
  getMutationResultCommandReceipt,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
import { createIdentityAuthRequestClient } from "@chase-sets/identity/server";
import type { Context, Hono, MiddlewareHandler } from "hono";

export type AuthApiEnv = {
  Variables: {
    context: EventStoreContext;
    actor: import("@chase-sets/auth-context").ResolvedActor | null;
  };
};

export type AuthApiApp = Hono<AuthApiEnv>;
export type AuthApiContext = Context<AuthApiEnv>;

export function getBootstrapContext(c: AuthApiContext) {
  return c.var.context;
}

export function getRequiredContext(c: AuthApiContext) {
  const context = c.var.context;
  if (!context) {
    throw new Error(t("auth.support.apiSupport.support.missing.auth.request.context"));
  }

  return context;
}

export function getRequiredActor(c: AuthApiContext) {
  const actor = c.var.actor;
  if (!actor) {
    throw new Error(t("auth.support.apiSupport.support.missing.auth.actor"));
  }

  return actor;
}

export function createIdentityMutations(c: AuthApiContext) {
  return createIdentityAuthRequestClient(c.req.raw);
}

function maxCommitPosition(left: string | undefined, right: string | undefined) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return BigInt(right) > BigInt(left) ? right : left;
}

function mergeSourceCommitPositions(sources: readonly SourceCommitPosition[]) {
  const byContext = new Map<string, SourceCommitPosition>();

  for (const source of sources) {
    const current = byContext.get(source.sourceContextName);
    if (!current) {
      byContext.set(source.sourceContextName, source);
      continue;
    }

    byContext.set(source.sourceContextName, {
      sourceContextName: source.sourceContextName,
      maxGlobalPosition:
        maxCommitPosition(current.maxGlobalPosition, source.maxGlobalPosition) ?? source.maxGlobalPosition,
      eventIds: [...new Set([...current.eventIds, ...source.eventIds])],
    });
  }

  return [...byContext.values()].sort((left, right) => left.sourceContextName.localeCompare(right.sourceContextName));
}

export function mutationReceiptHeadersFromSources(sources: readonly unknown[]): Record<string, string> {
  let commitPosition: string | undefined;
  const commitEventIds = new Set<string>();
  const commitPositions: SourceCommitPosition[] = [];

  for (const source of sources) {
    const receipt = getMutationResultCommandReceipt(source);
    if (!receipt) {
      continue;
    }

    commitPosition = maxCommitPosition(commitPosition, receipt.commitPosition);
    for (const eventId of receipt.commitEventIds) {
      commitEventIds.add(eventId);
    }
    commitPositions.push(...receipt.commitPositions);
  }

  const mergedCommitPositions = mergeSourceCommitPositions(commitPositions);
  if (!commitPosition && commitEventIds.size === 0 && mergedCommitPositions.length === 0) {
    return {};
  }

  return {
    "Chase-Sets-Consistency": "eventual",
    ...(commitPosition ? { "Chase-Sets-Commit-Position": commitPosition } : {}),
    ...(mergedCommitPositions.length > 0
      ? { [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt(mergedCommitPositions) }
      : {}),
    ...(commitEventIds.size > 0 ? { "Chase-Sets-Commit-Event-Ids": [...commitEventIds].join(",") } : {}),
  };
}

export function jsonWithMutationReceipts(
  c: AuthApiContext,
  body: object,
  status: 200 | 201,
  sources: readonly unknown[],
) {
  return c.json(body, status, mutationReceiptHeadersFromSources(sources));
}

export function readIdentityMutationFailure(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return null;
  }

  const status = Number(error.status);
  if (status !== 400 && status !== 409) {
    return null;
  }

  const body = "body" in error ? error.body : null;
  return {
    status: status as 400 | 409,
    body:
      body && typeof body === "object"
        ? body
        : {
            error: {
              code: status === 400 ? "validation_failed" : "identity_mutation_conflict",
              message: error instanceof Error ? error.message : "Identity mutation failed.",
            },
          },
  };
}

export function identityMutationFailureMessage(body: unknown, fallback: string) {
  if (!body || typeof body !== "object" || !("error" in body)) {
    return fallback;
  }

  const error = body.error;
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }

  return fallback;
}

export function createPermissionGuard(permission: string): MiddlewareHandler<AuthApiEnv> {
  return async (c, next) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({ error: t("auth.support.apiSupport.support.authentication.required") }, 401);
    }

    if (!hasActorPermission(actor, permission)) {
      return c.json({ error: t("auth.support.apiSupport.support.forbidden") }, 403);
    }

    await next();
  };
}

export function createOwnedUserDisplayName(contactValue: string) {
  return contactValue.includes("@") ? contactValue.split("@")[0] : contactValue;
}
