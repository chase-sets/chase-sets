import { createId } from "@chase-sets/primitives/typed-ids";
import { navigateAfterWrite } from "@chase-sets/http/responses";
import type { DomainEvent } from "@chase-sets/event-core";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventRecordToStore, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { hasPermission } from "../../../support/request-support/permissions";
import type { IdentityServices } from "../../../support/runtime-support/services";
import { deleteApiKeySecret, upsertApiKeySecret } from "../../api-keys/api/secret-store";
import { attemptStreamId, canonicalRequest, digest, parseActionTarget, type CanonicalRequest } from "../domain/attempt";
import {
  closedObject,
  isInstant,
  validateEventProofs,
  type AttemptBinding,
  type MutationAction,
} from "../domain/contract";
import { eligibilityScopeKeys, type IdentityMutationPersistence, type IdentityMutationTransaction } from "./fences";
import {
  AddressChoiceRequired,
  assertOwnerAuthorization,
  ownerForRequest,
  planOwnerMutation,
  validateOwnerHistory,
  type Owner,
  type OwnerKind,
} from "./owners";
import { IdentityDomainError } from "../../../support/runtime-support/common";
import { ShippingAddressFieldError, ShippingAddressUndeliverableError } from "../../shipping-addresses/domain/errors";
import type { ShippingAddressSnapshot } from "../../shipping-addresses/domain/domain";

const RECEIPT_EVENT = "identity.account-management-mutation-attempt.committed";
type SafeOwner = Readonly<{ id: string; version: number; status: string }>;
type Receipt = Readonly<{
  schemaVersion: 1;
  binding: AttemptBinding;
  action: MutationAction;
  target: string | null;
  owner: string;
  category: OwnerKind;
  hash: string;
  priorVersion: number;
  committedVersion: number;
  events: readonly Readonly<{ id: string; type: string; digest: string }>[];
  result: SafeOwner & Readonly<{ changed: boolean }>;
}>;
export type MutationResult =
  | Readonly<{
      outcome: "committed";
      newlyCommitted: boolean;
      receipt: Receipt;
      current: SafeOwner;
      destination?: string;
      secret?: string;
      secretState?: "committed-secret-unrecoverable";
      delivery?: "unknown";
    }>
  | Readonly<{
      outcome: "not-recorded" | "indeterminate" | "conflict";
      code: string;
      current?: SafeOwner;
      suggestedAddress?: ShippingAddressSnapshot;
    }>;
export type MutationInput = Readonly<{
  actor: ResolvedActor;
  context: EventStoreContext;
  key: string;
  action: string;
  target: string | null;
  body: unknown;
}>;
export type AccountManagementServices = Readonly<{
  submit: (input: MutationInput) => Promise<MutationResult>;
  lookup: (input: Omit<MutationInput, "body">) => Promise<MutationResult>;
}>;

function bindingOf(input: MutationInput | Omit<MutationInput, "body">): AttemptBinding {
  const { actor, context } = input;
  if (
    actor.tenantId !== context.tenantId ||
    actor.userId !== context.audit.performedByUserId ||
    actor.accountId !== context.audit.forAccountId
  )
    throw new Error("authorization_forbidden");
  return { tenantId: actor.tenantId, userId: actor.userId, accountId: actor.accountId };
}

export function assertMutationPermission(actor: ResolvedActor, action: MutationAction) {
  const permission =
    action === "withdraw"
      ? null
      : ["update-profile", "create", "update", "default", "archive"].includes(action)
        ? "accounts.manage"
        : ["update-user", "create-api-key", "rotate-api-key", "revoke-api-key"].includes(action)
          ? "security.manage"
          : "memberships.manage";
  if (permission && !hasPermission(actor, permission)) throw new Error("authorization_forbidden");
}

function generatedId(action: MutationAction, selector: string): string {
  const prefix = action === "create" ? "adr" : action === "create-invitation" ? "ivt" : "key";
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = BigInt(`0x${digest({ selector, prefix }).slice(0, 32)}`);
  let suffix = "";
  for (let index = 0; index < 26; index++) {
    suffix = alphabet[Number(value & 31n)] + suffix;
    value >>= 5n;
  }
  return `${prefix}_${suffix}`;
}

function safeOwner(owner: Owner, id: string, version: number): SafeOwner {
  return { id, version, status: "status" in owner.state ? owner.state.status : "active" };
}

function ownerReadDestination(action: MutationAction, category: OwnerKind, history: readonly StoredEvent[]) {
  if (action === "create-api-key" || action === "rotate-api-key") return undefined;
  const destination = {
    account: "/account",
    user: "/account/security",
    "api-key": "/account/security",
    "shipping-address-book": "/account/shipping-addresses",
    consent: "/account/consents",
    invitation: "/account/team",
    membership: "/account/team",
  }[category];
  const last = history.at(-1);
  if (!last) return destination;
  return navigateAfterWrite(
    {
      mode: "eventual",
      commitPositions: [
        {
          sourceContextName: "identity",
          maxGlobalPosition: String(last.globalPosition),
          eventIds: [String(last.eventId)],
        },
      ],
    },
    destination,
  );
}

export function createAccountManagementRuntime(
  persistence: IdentityMutationPersistence,
  services: Pick<IdentityServices, "auth" | "shippingAddresses">,
): AccountManagementServices {
  async function historicalResult(
    tx: IdentityMutationTransaction,
    input: Omit<MutationInput, "body">,
    request: Pick<CanonicalRequest, "action" | "target">,
    history: readonly StoredEvent[],
    hash?: string,
  ): Promise<MutationResult> {
    const binding = bindingOf(input);
    const receipt = validateReceiptHistory(history, binding, request);
    const id = request.target ?? generatedId(request.action, attemptStreamId(binding, input.key));
    const target = ownerForRequest({ ...request, fields: {}, hash: receipt.hash }, input.actor, id);
    if (receipt.owner !== target.streamId || receipt.category !== target.kind || receipt.result.id !== id)
      throw new Error("INDETERMINATE");
    const ownerHistory = await tx.read(receipt.owner);
    const owner = validateOwnerHistory(receipt.category, ownerHistory, binding.tenantId);
    assertOwnerAuthorization(owner, { ...request, fields: {}, hash: receipt.hash }, input.actor);
    if (
      receipt.committedVersion > ownerHistory.length ||
      receipt.events.length !== receipt.committedVersion - receipt.priorVersion
    )
      throw new Error("INDETERMINATE");
    const committedEvents = ownerHistory.slice(receipt.priorVersion, receipt.committedVersion);
    for (let index = 0; index < committedEvents.length; index++) {
      const event = committedEvents[index];
      const proof = receipt.events[index];
      if (event.eventId !== proof.id || event.eventType !== proof.type || digest(event.payload) !== proof.digest)
        throw new Error("INDETERMINATE");
    }
    const historicalOwner = validateOwnerHistory(
      receipt.category,
      ownerHistory.slice(0, receipt.committedVersion),
      binding.tenantId,
    );
    const expected = safeOwner(historicalOwner, receipt.result.id, receipt.committedVersion);
    if (
      digest(expected) !==
        digest({ id: receipt.result.id, version: receipt.result.version, status: receipt.result.status }) ||
      receipt.result.changed !== receipt.events.length > 0
    )
      throw new Error("INDETERMINATE");
    const current = safeOwner(owner, receipt.result.id, ownerHistory.length);
    if (hash !== undefined && receipt.hash !== hash)
      return { outcome: "conflict", code: "attempt-hash-conflict", current };
    return {
      outcome: "committed",
      newlyCommitted: false,
      receipt,
      current,
      destination: ownerReadDestination(receipt.action, receipt.category, ownerHistory),
      ...(["create-api-key", "rotate-api-key"].includes(receipt.action)
        ? { secretState: "committed-secret-unrecoverable" as const }
        : {}),
    };
  }

  async function lookup(input: Omit<MutationInput, "body">): Promise<MutationResult> {
    try {
      const action = parseActionTarget(input.action, input.target);
      assertMutationPermission(input.actor, action);
      const selector = attemptStreamId(bindingOf(input), input.key);
      return await persistence.transaction([], async (tx) => {
        const history = await tx.read(selector);
        if (history.length === 0) return { outcome: "not-recorded", code: "not-recorded" };
        try {
          return await historicalResult(tx, input, { action, target: input.target }, history);
        } catch (error) {
          if (error instanceof Error && error.message === "authorization_forbidden")
            return { outcome: "not-recorded", code: "not-recorded" };
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message === "authorization_forbidden")
        return { outcome: "not-recorded", code: "not-recorded" };
      return { outcome: "indeterminate", code: "INDETERMINATE" };
    }
  }

  async function submit(input: MutationInput): Promise<MutationResult> {
    let request: CanonicalRequest;
    try {
      request = canonicalRequest(input.action, input.target, input.body);
    } catch {
      return { outcome: "indeterminate", code: "INDETERMINATE" };
    }
    assertMutationPermission(input.actor, request.action);
    const binding = bindingOf(input);
    const selector = attemptStreamId(binding, input.key);
    const id = request.target ?? generatedId(request.action, selector);
    const target = ownerForRequest(request, input.actor, id);
    async function conflictResult(code: string): Promise<MutationResult> {
      try {
        return await persistence.transaction([], async (tx) => {
          const history = await tx.read(target.streamId);
          const owner = validateOwnerHistory(target.kind, history, binding.tenantId);
          assertOwnerAuthorization(owner, request, input.actor);
          return { outcome: "conflict", code, current: safeOwner(owner, id, history.length) };
        });
      } catch {
        return { outcome: "indeterminate", code: "INDETERMINATE" };
      }
    }
    // Only immutable owner identity is read to choose scope keys. Authority is read again under the locks.
    let prefixHistory: readonly StoredEvent[];
    let scopes: readonly string[];
    try {
      prefixHistory = await readCompleteStream(persistence.eventStore, { streamId: target.streamId, maxEvents: 10000 });
      scopes = [
        ...eligibilityScopeKeys(binding.tenantId, target.streamId, prefixHistory),
        ...(request.action === "create-invitation"
          ? eligibilityScopeKeys(binding.tenantId, `identity.account-${binding.accountId}`, [])
          : []),
      ];
    } catch {
      return { outcome: "indeterminate", code: "INDETERMINATE" };
    }
    let conflict = false;
    try {
      return await persistence
        .transaction(scopes, async (tx) => {
          const attempts = await tx.read(selector);
          if (attempts.length) return historicalResult(tx, input, request, attempts, request.hash);
          const history = await tx.read(target.streamId);
          const owner = validateOwnerHistory(target.kind, history, binding.tenantId);
          assertOwnerAuthorization(owner, request, input.actor);
          if (history.length !== prefixHistory.length)
            return {
              outcome: "conflict" as const,
              code: "owner-version-conflict",
              current: safeOwner(owner, id, history.length),
            };
          const accountGuard = await assertNewEligibility(tx, owner, request, input.actor, input.context);
          const plan = await planOwnerMutation({
            owner,
            history,
            request,
            actor: input.actor,
            context: input.context,
            id,
            services,
          });
          const events: readonly EventRecordToStore[] = plan.events.map((event: DomainEvent) => ({
            eventId: createId("evt"),
            eventType: event.type,
            payload: event.data,
          }));
          const proposedHistory = [
            ...history,
            ...events.map((event, index) => ({
              ...history[0],
              eventId: event.eventId!,
              streamId: target.streamId,
              streamVersion: history.length + index + 1,
              tenantId: input.context.tenantId,
              eventType: event.eventType,
              payload: event.payload,
            })),
          ] as readonly StoredEvent[];
          const nextOwner = validateOwnerHistory(target.kind, proposedHistory, binding.tenantId);
          const result = { ...safeOwner(nextOwner, id, history.length + events.length), changed: events.length > 0 };
          const receipt: Receipt = {
            schemaVersion: 1,
            binding,
            action: request.action,
            target: request.target,
            owner: target.streamId,
            category: target.kind,
            hash: request.hash,
            priorVersion: history.length,
            committedVersion: result.version,
            events: events.map((event) => ({
              id: event.eventId!,
              type: event.eventType,
              digest: digest(event.payload),
            })),
            result,
          };
          const appended = await tx.append!([
            {
              streamId: selector,
              expectedVersion: "no_stream",
              context: input.context,
              events: [{ eventType: RECEIPT_EVENT, payload: receipt as unknown as JsonObject }],
            },
            {
              streamId: target.streamId,
              expectedVersion: history.length || "no_stream",
              context: input.context,
              events,
            },
            ...(accountGuard && accountGuard.streamId !== target.streamId ? [accountGuard] : []),
          ]);
          if (target.kind === "api-key") {
            if (plan.secret)
              await upsertApiKeySecret(tx.db, {
                apiKeyId: id,
                userId: input.actor.userId,
                keyPrefix: plan.secret.slice(0, 12),
                secretHash: services.auth.hashSecret(plan.secret),
                expectedVersion: result.version,
              });
            else if (request.action === "revoke-api-key") await deleteApiKeySecret(tx.db, id);
          }
          return {
            outcome: "committed" as const,
            newlyCommitted: true,
            receipt,
            current: safeOwner(nextOwner, id, result.version),
            destination: ownerReadDestination(request.action, target.kind, [
              ...history,
              ...appended.find((entry) => entry.streamId === target.streamId)!.storedEvents,
            ]),
            ...(plan.secret ? { secret: plan.secret } : {}),
            committedEvents: appended.flatMap((entry) => entry.storedEvents),
          };
        })
        .then((result) => {
          if ("committedEvents" in result) {
            recordCommittedEvents(result.committedEvents, "identity");
            const { committedEvents: _events, ...safe } = result;
            return safe;
          }
          return result;
        });
    } catch (error) {
      conflict =
        typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
      if (conflict) {
        const recovered = await lookup(input);
        if (recovered.outcome === "committed")
          return recovered.receipt.hash === request.hash
            ? recovered
            : { outcome: "conflict", code: "attempt-hash-conflict", current: recovered.current };
        return conflictResult("owner-version-conflict");
      }
      if (error instanceof Error && ["conflict", "last-active-owner", "current-consent"].includes(error.message))
        return conflictResult(error.message);
      if (error instanceof Error && error.message === "authorization_forbidden") throw error;
      if (error instanceof AddressChoiceRequired)
        return {
          outcome: "not-recorded",
          code: "address-standardization-suggested",
          suggestedAddress: error.suggestedAddress,
        };
      if (error instanceof ShippingAddressUndeliverableError || error instanceof ShippingAddressFieldError)
        return {
          outcome: "not-recorded",
          code: error instanceof ShippingAddressFieldError ? "validation-failed" : "shipping-address-undeliverable",
        };
      if (error instanceof IdentityDomainError) return conflictResult("owner-state-conflict");
      return { outcome: "indeterminate", code: "INDETERMINATE" };
    }
  }
  return { submit, lookup };
}

async function assertNewEligibility(
  tx: IdentityMutationTransaction,
  owner: Owner,
  request: CanonicalRequest,
  actor: ResolvedActor,
  context: EventStoreContext,
) {
  if (owner.kind === "invitation" && request.action === "create-invitation") {
    const streamId = `identity.account-${actor.accountId}`;
    const history = await tx.read(streamId);
    const account = validateOwnerHistory("account", history, actor.tenantId);
    if (account.kind !== "account" || !account.state.id) throw new Error("conflict");
    return { streamId, expectedVersion: history.length, context, events: [] } as const;
  }
  if (owner.kind === "membership") {
    if (!owner.state.id || owner.state.accountId !== actor.accountId) throw new Error("authorization_forbidden");
    const streamId = `identity.account-${actor.accountId}`;
    const accountHistory = await tx.read(streamId);
    const account = validateOwnerHistory("account", accountHistory, actor.tenantId);
    if (account.kind !== "account" || !account.state.id) throw new Error("INDETERMINATE");
    const removes =
      owner.state.status === "active" &&
      owner.state.roleKey === "owner" &&
      (request.action === "revoke" || (request.action === "change-role" && request.fields.roleKey !== "owner"));
    if (removes && account.state.status !== "closed") {
      const count = await tx.projectionPredicate("identity-membership-projection", [actor.accountId]);
      if (!count[0]?.count || BigInt(count[0].count) <= 1n) throw new Error("last-active-owner");
    }
    return { streamId, expectedVersion: accountHistory.length, context, events: [] } as const;
  }
  if (owner.kind === "consent") {
    const current = await tx.projectionPredicate("identity-consent-current-state-projection", [
      owner.state.subjectType,
      owner.state.subjectType === "user" ? owner.state.userId : owner.state.accountId,
      owner.state.policyKey,
    ]);
    if (current.length !== 1) throw new Error("INDETERMINATE");
    if (current[0].consent_id !== owner.state.id) throw new Error("current-consent");
  }
  return null;
}

export function validateReceiptHistory(
  history: readonly StoredEvent[],
  binding: AttemptBinding,
  request: Pick<CanonicalRequest, "action" | "target">,
): Receipt {
  if (
    history.length !== 1 ||
    history[0].streamVersion !== 1 ||
    history[0].eventType !== RECEIPT_EVENT ||
    history[0].tenantId !== binding.tenantId ||
    history[0].performedByUserId !== binding.userId ||
    history[0].forAccountId !== binding.accountId
  )
    throw new Error("INDETERMINATE");
  if (!isInstant(history[0].occurredAt) || !isInstant(history[0].recordedAt)) throw new Error("INDETERMINATE");
  closedObject(history[0].metadata, []);
  const raw = closedObject(history[0].payload, [
    "schemaVersion",
    "binding",
    "action",
    "target",
    "owner",
    "category",
    "hash",
    "priorVersion",
    "committedVersion",
    "events",
    "result",
  ]);
  const bound = closedObject(raw.binding, ["tenantId", "userId", "accountId"]);
  if (digest(bound as JsonObject) !== digest(binding) || raw.action !== request.action || raw.target !== request.target)
    throw new Error("authorization_forbidden");
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.owner !== "string" ||
    raw.owner.length > 250 ||
    typeof raw.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.hash) ||
    !["account", "shipping-address-book", "consent", "user", "api-key", "membership", "invitation"].includes(
      String(raw.category),
    )
  )
    throw new Error("INDETERMINATE");
  if (
    !Number.isSafeInteger(raw.priorVersion) ||
    Number(raw.priorVersion) < 0 ||
    !Number.isSafeInteger(raw.committedVersion) ||
    Number(raw.committedVersion) < Number(raw.priorVersion) ||
    Number(raw.committedVersion) > 10000 ||
    !Array.isArray(raw.events) ||
    raw.events.length > 2
  )
    throw new Error("INDETERMINATE");
  validateEventProofs(request.action, raw.events);
  const result = closedObject(raw.result, ["id", "version", "status", "changed"]);
  if (
    typeof result.id !== "string" ||
    result.id.length > 100 ||
    result.version !== raw.committedVersion ||
    typeof result.changed !== "boolean" ||
    ![
      "active",
      "revoked",
      "pending",
      "cancelled",
      "accepted",
      "declined",
      "expired",
      "recorded",
      "withdrawn",
      "suspended",
      "closed",
    ].includes(String(result.status))
  )
    throw new Error("INDETERMINATE");
  return raw as unknown as Receipt;
}
