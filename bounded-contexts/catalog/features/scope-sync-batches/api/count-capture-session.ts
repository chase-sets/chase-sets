import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { CountCaptureStopped } from "../../source-observations/api/providers/count-capture-transport";
import { countFingerprint } from "../domain/count-acquisition";

export const countCaptureAdminOrigin = "https://admin.staging.chasesets.com";
export type CountCaptureSession = Readonly<{
  request: Request;
  actor: ResolvedActor | null;
  context: EventStoreContext;
}>;

// The run owner is derived from the authenticated session alone: a real staging
// platform-admin session with Catalog view and manage, no agent grant, posting
// from the staging Admin origin. There is no client-supplied run or phase ID.
export function countCaptureSessionOwner(session: CountCaptureSession, environment: string): string {
  const { actor, context, request } = session;
  if (environment !== "staging") throw new CountCaptureStopped();
  if (!actor || !actor.sessionId) throw new CountCaptureStopped();
  if (actor.agentGrant) throw new CountCaptureStopped();
  if (actor.roleKey !== "platform-admin") throw new CountCaptureStopped();
  if (!actor.permissions.includes("catalog.view")) throw new CountCaptureStopped();
  if (!actor.permissions.includes("catalog.manage")) throw new CountCaptureStopped();
  if (
    actor.tenantId !== context.tenantId ||
    actor.userId !== context.audit.performedByUserId ||
    actor.accountId !== context.audit.forAccountId
  )
    throw new CountCaptureStopped();
  if (request.method !== "POST") throw new CountCaptureStopped();
  if (request.headers.get("origin") !== countCaptureAdminOrigin) throw new CountCaptureStopped();
  if (resolvePublicRequestOrigin(request) !== countCaptureAdminOrigin) throw new CountCaptureStopped();
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new CountCaptureStopped();
  return countFingerprint({
    session: actor.sessionId,
    tenant: actor.tenantId,
    account: actor.accountId,
    user: actor.userId,
  });
}
