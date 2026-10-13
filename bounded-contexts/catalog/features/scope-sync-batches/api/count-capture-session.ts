import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { countFingerprint } from "../domain/count-acquisition";
import type { ScopeSyncBatchBudget, ScopeSyncBatchSelection } from "../domain/batch";
import type { CountCaptureStore } from "../read-model/count-capture-store";
import { CountCaptureStopped, runCountCaptureRequest, type CountCapturePhase } from "./count-capture-context";

export type CountCaptureSession = Readonly<{
  request: Request;
  actor: ResolvedActor | null;
  context: EventStoreContext;
}>;

export function countCaptureSessionOwner(session: CountCaptureSession, environment: string) {
  const { actor, context, request } = session;
  if (
    environment !== "staging" ||
    !actor ||
    !actor.sessionId ||
    actor.agentGrant ||
    actor.roleKey !== "platform-admin" ||
    !actor.permissions.includes("catalog.view") ||
    !actor.permissions.includes("catalog.manage") ||
    actor.tenantId !== context.tenantId ||
    actor.userId !== context.audit.performedByUserId ||
    actor.accountId !== context.audit.forAccountId ||
    resolvePublicRequestOrigin(request) !== "https://admin.staging.chasesets.com" ||
    request.headers.get("origin") !== "https://admin.staging.chasesets.com" ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    request.method !== "POST"
  )
    throw new CountCaptureStopped();
  return countFingerprint({
    session: actor.sessionId,
    tenant: actor.tenantId,
    account: actor.accountId,
    user: actor.userId,
  });
}

// Run and request identities come only from the durable, authenticated session.
// There is no client-supplied run ID or phase token to transfer between owners.
export function createCountCaptureSessionBoundary(deps: {
  environment: string;
  store: Pick<CountCaptureStore, "findOwner" | "begin" | "finish" | "ledger">;
  now?: () => string;
}) {
  const now = deps.now ?? (() => new Date().toISOString());
  return {
    async run<T>(
      session: CountCaptureSession,
      input: Readonly<{
        phase: CountCapturePhase;
        selection: ScopeSyncBatchSelection;
        budget: ScopeSyncBatchBudget;
        quote?: Readonly<{ quoteId: string; fingerprint: string }>;
        planFingerprint?: string;
      }>,
      work: (binding: Awaited<ReturnType<CountCaptureStore["begin"]>>) => Promise<T>,
    ): Promise<T> {
      const owner = countCaptureSessionOwner(session, deps.environment);
      const state = await deps.store.findOwner(owner);
      if (
        !state ||
        state.ownerHash !== owner ||
        !Number.isFinite(Date.parse(now())) ||
        Date.parse(state.admittedAt) > Date.parse(now()) ||
        Date.parse(state.expiresAt) < Date.parse(now()) ||
        state.stage === "failed" ||
        state.stage === "frozen" ||
        countFingerprint(input.selection) !== state.selectionHash ||
        countFingerprint(input.budget) !== state.budgetHash ||
        (input.phase === "acquisition" &&
          (!input.quote ||
            input.quote.quoteId !== state.quoteId ||
            input.quote.fingerprint !== state.quoteFingerprint)) ||
        (input.phase !== "acquisition" && input.quote !== undefined) ||
        (input.phase === "pre-confirm" &&
          (!input.planFingerprint ||
            input.planFingerprint !== state.plannerReads.find((read) => read.phase === "preview")?.planFingerprint)) ||
        (input.phase !== "pre-confirm" && input.planFingerprint !== undefined)
      )
        throw new CountCaptureStopped();
      const binding = await deps.store.begin(state.runId, input.phase);
      return runCountCaptureRequest({ binding, ledger: deps.store.ledger }, async () => {
        const result = await work(binding);
        await deps.store.finish(binding);
        return result;
      });
    },
  };
}
