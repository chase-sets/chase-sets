import { t } from "@chase-sets/localization";
import { hasPermission as hasActorPermission } from "@chase-sets/platform-runtime/auth";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  encodeCommitReceipt,
  getMutationResultCommandReceipt,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
import {
  createIdentityAuthRequestClient,
  isRegistrationConsentRejectionCode,
  type IdentityAuthMutationClient,
  type RegistrationConsentSubmission,
} from "@chase-sets/identity/server";
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

/**
 * The unaffirmed server-minted submission, for first-use paths that have no
 * human affirmation moment to carry one -- a social-login provider callback,
 * an emailed magic link, a phone code, a passkey ceremony, an invitation
 * acceptance.
 *
 * It takes no affirmation from anybody: there is no parameter to pass one in,
 * so this can never become the shape that receives a detached boolean and
 * resolves a version afterwards. While the resolved requirement set is empty
 * there is nothing to affirm and registration proceeds. The moment the set is
 * non-empty these paths fail closed, because an unaffirmed submission carrying
 * requirements is rejected -- which is the correct outcome, not a regression:
 * a path with no way to show someone what they are agreeing to has no business
 * recording that they agreed.
 */
export async function resolveUnaffirmedRegistrationConsent(
  identityMutations: Pick<IdentityAuthMutationClient, "resolveRegistrationConsent">,
): Promise<RegistrationConsentSubmission> {
  return {
    resolution: await identityMutations.resolveRegistrationConsent(),
    affirmed: false,
  };
}

/**
 * Relay Identity's registration-consent rejection to the caller unchanged.
 *
 * Identity is the single place that decides whether a submission was
 * server-minted, so Auth forwards the verdict rather than re-deciding it. That
 * is what makes an omitted submission, a destructured raw client, a
 * reconstructed URL, and a local impostor binder produce one error body for one
 * reason instead of four lookalike codes.
 */
export function readRegistrationConsentRejection(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error) || Number(error.status) !== 400) {
    return null;
  }

  const body = "body" in error ? error.body : null;
  if (!body || typeof body !== "object" || !("error" in body)) {
    return null;
  }

  const rejection = (body as { error?: unknown }).error;
  if (!rejection || typeof rejection !== "object" || !("code" in rejection)) {
    return null;
  }

  return isRegistrationConsentRejectionCode((rejection as { code?: unknown }).code) ? body : null;
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

export function readIdentityMutationConflict(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error) || Number(error.status) !== 409) {
    return null;
  }

  const body = "body" in error ? error.body : null;
  const message = error instanceof Error ? error.message : "Identity mutation conflict.";

  return body && typeof body === "object"
    ? body
    : {
        error: {
          code: "identity_mutation_conflict",
          message,
        },
      };
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
