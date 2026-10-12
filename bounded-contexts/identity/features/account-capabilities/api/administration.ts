import { resolveRecentAuthenticationStatus, type ResolvedActor } from "@chase-sets/auth-context";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountCapabilityCatalog, AccountCapabilityAssignmentResult } from "./runtime";
import { createId } from "@chase-sets/primitives/typed-ids";
import { createIdentityBootstrapContext } from "../../../support/runtime-support/bootstrap-context";
import { mintAccountCapabilityAssignmentAdmission, type AccountCapabilityAssignmentAdmission } from "./admission";
import { DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY, type CapabilityAdministrationAuthority } from "./authority";

export const AUTHORITY_RECEIPT_STREAM = "identity.capability-administration-authority";
export type CapabilityAssignmentInput = Readonly<{ accountId: string; capabilityKey: string; expectedVersion: number }>;
export function parseCapabilityAssignmentInput(value: unknown): CapabilityAssignmentInput | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !("accountId" in value) ||
    !("capabilityKey" in value) ||
    !("expectedVersion" in value)
  )
    return null;
  if (
    typeof value.accountId !== "string" ||
    !/^acc_[A-Za-z0-9_]{1,128}$/.test(value.accountId) ||
    typeof value.capabilityKey !== "string" ||
    !/^[a-z][a-z0-9.-]{0,127}$/.test(value.capabilityKey) ||
    typeof value.expectedVersion !== "number" ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 0
  )
    return null;
  return { accountId: value.accountId, capabilityKey: value.capabilityKey, expectedVersion: value.expectedVersion };
}
export type CapabilityAdministrationOptions = Readonly<{
  authority: CapabilityAdministrationAuthority;
  registry: AccountCapabilityCatalog;
  targetAccountInTenant: (accountId: string, tenantId: string) => Promise<boolean>;
  now?: () => Date;
}>;
export class CapabilityAdministrationError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
type Receipt = Readonly<{ authorityId: string; revision: number; configDigest: string; version: number }>;

export function createCapabilityAdministration(
  eventStore: EventStore,
  options: CapabilityAdministrationOptions | undefined,
) {
  const authority = options?.authority ?? DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY;
  let initialization: Promise<Receipt | null> | undefined;
  const initialize = () => (initialization ??= compareAndRecord());
  // Start the receipt at composition, but preserve its rejection for main's boot barrier.
  if (authority.kind === "configured") void initialize().catch(() => undefined);

  async function readReceipt(): Promise<Receipt | null> {
    const events = await readCompleteStream(eventStore, { streamId: AUTHORITY_RECEIPT_STREAM, maxEvents: 10000 });
    let receipt: Receipt | null = null;
    for (const event of events) {
      const p = event.payload;
      if (
        event.eventType !== "identity.capability-administration-authority.recorded" ||
        typeof p.authorityId !== "string" ||
        !/^[a-z0-9-]{1,64}$/.test(p.authorityId) ||
        typeof p.revision !== "number" ||
        !Number.isInteger(p.revision) ||
        p.revision < 1 ||
        p.revision > 2147483647 ||
        typeof p.configDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(p.configDigest) ||
        typeof p.implementationSha !== "string" ||
        !/^[a-f0-9]{40}$/.test(p.implementationSha) ||
        (receipt && p.revision <= receipt.revision)
      )
        throw new CapabilityAdministrationError("authority_history_invalid");
      receipt = {
        authorityId: p.authorityId,
        revision: p.revision,
        configDigest: p.configDigest,
        version: event.streamVersion,
      };
    }
    return receipt;
  }

  async function compareAndRecord(): Promise<Receipt | null> {
    if (authority.kind === "deny-all") return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await readReceipt();
      if (previous && previous.revision >= authority.revision) {
        if (previous.revision === authority.revision && previous.configDigest !== authority.configDigest)
          throw new CapabilityAdministrationError("authority_digest_conflict");
        return previous;
      }
      try {
        const events = await eventStore.appendToStream({
          streamId: AUTHORITY_RECEIPT_STREAM,
          expectedVersion: previous?.version ?? "no_stream",
          context: createIdentityBootstrapContext(),
          events: [
            {
              eventType: "identity.capability-administration-authority.recorded",
              payload: {
                authorityId: authority.authorityId,
                revision: authority.revision,
                configDigest: authority.configDigest,
                implementationSha: authority.implementationSha,
              },
            },
          ],
        });
        return {
          authorityId: authority.authorityId,
          revision: authority.revision,
          configDigest: authority.configDigest,
          version: events[0].streamVersion,
        };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "concurrency_conflict")) throw error;
      }
    }
    throw new CapabilityAdministrationError("authority_unavailable");
  }

  async function attempt(
    action: "grant" | "revoke",
    actor: ResolvedActor | null,
    rawInput: unknown,
    context: EventStoreContext,
    assign: (admission: AccountCapabilityAssignmentAdmission) => Promise<AccountCapabilityAssignmentResult>,
  ) {
    const input = parseCapabilityAssignmentInput(rawInput);
    const instant = (options?.now?.() ?? new Date()).toISOString();
    const attemptId = createId("evt");
    const audit = (reason: string, assignmentVersion: number | null): AppendToStreamInput => ({
      streamId: `identity.capability-assignment-attempt-${attemptId}`,
      expectedVersion: "no_stream",
      // Never let request-derived trace data or a mismatched context enter attempt metadata.
      context: actor
        ? {
            tenantId: actor.tenantId as never,
            audit: { performedByUserId: actor.userId as never, forAccountId: actor.accountId as never },
          }
        : createIdentityBootstrapContext(),
      events: [
        {
          eventType: "identity.account-capability.assignment-attempted",
          payload: {
            attemptId,
            actorUserId: actor?.userId ?? null,
            actorAccountId: actor?.accountId ?? null,
            tenantId: actor?.tenantId ?? null,
            targetAccountId: input?.accountId ?? null,
            capabilityKey: input?.capabilityKey ?? null,
            action,
            authorityId: authority.kind === "configured" ? authority.authorityId : null,
            authorityRevision: authority.kind === "configured" ? authority.revision : null,
            configDigest: authority.kind === "configured" ? authority.configDigest : null,
            expectedAssignmentVersion: input?.expectedVersion ?? null,
            assignmentVersion,
            reason,
            attemptedAt: instant,
          },
        },
      ],
    });
    async function deny(reason: string): Promise<never> {
      await eventStore.appendToStream(audit(reason, null));
      throw new CapabilityAdministrationError(reason);
    }
    if (!input) return deny("invalid_assignment_input");
    if (!actor) return deny("authentication_required");
    if (
      actor.tenantId !== context.tenantId ||
      actor.userId !== context.audit.performedByUserId ||
      actor.accountId !== context.audit.forAccountId
    )
      return deny("actor_context_mismatch");
    if (
      !/^ses_[A-Za-z0-9_]{1,128}$/.test(actor.sessionId) ||
      !/^mbr_[A-Za-z0-9_]{1,128}$/.test(actor.membershipId) ||
      actor.agentGrant ||
      actor.roleKey === "guest"
    )
      return deny("human_session_required");
    if (authority.kind === "deny-all" || !authority.adminUserIds.includes(actor.userId))
      return deny("administration_authority_required");
    if (
      !actor.authenticatedAt ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(actor.authenticatedAt) ||
      !resolveRecentAuthenticationStatus(actor, { maxAgeMinutes: 15, now: new Date(instant) }).recentlyAuthenticated
    )
      return deny("recent_authentication_required");
    const declaration = options?.registry.find((entry) => entry.key === input.capabilityKey);
    if (
      input.capabilityKey !== "support.evidence.any-case" ||
      declaration?.kind !== "boolean" ||
      declaration.defaultValue !== false
    )
      return deny("invalid_capability_key");
    let targetInTenant: boolean;
    try {
      targetInTenant = await options!.targetAccountInTenant(input.accountId, actor.tenantId);
    } catch {
      return deny("assignment_unavailable");
    }
    if (!targetInTenant) return deny("target_account_outside_tenant");
    try {
      await initialize();
    } catch {
      return deny("authority_unavailable");
    }
    let receipt: Receipt | null;
    try {
      receipt = await readReceipt();
    } catch {
      return deny("authority_unavailable");
    }
    if (
      !receipt ||
      receipt.revision !== authority.revision ||
      receipt.configDigest !== authority.configDigest ||
      receipt.authorityId !== authority.authorityId
    )
      return deny("authority_receipt_stale");
    const admitted = audit("accepted", null);
    const admission = mintAccountCapabilityAssignmentAdmission(context.tenantId, actor.userId, [
      {
        streamId: AUTHORITY_RECEIPT_STREAM,
        expectedVersion: receipt.version,
        context: createIdentityBootstrapContext(),
        events: [],
      },
      admitted,
    ]);
    try {
      return await assign(admission);
    } catch (error) {
      await eventStore.appendToStream(
        audit(
          error instanceof Error && "code" in error && error.code === "concurrency_conflict"
            ? "assignment_concurrency_conflict"
            : "assignment_refused",
          null,
        ),
      );
      throw new CapabilityAdministrationError(
        error instanceof Error && "code" in error && error.code === "concurrency_conflict"
          ? "assignment_concurrency_conflict"
          : "assignment_unavailable",
      );
    }
  }
  return { initialize, attempt };
}
