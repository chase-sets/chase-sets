import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext, GlobalPosition } from "@chase-sets/event-core/storage";
import type {
  ListingAuthorityConsumerPort,
  ListingAuthorityOperation,
  ListingAuthoritySessionAuthorityPort,
  ListingAuthorityStandingAuthorityPort,
  ListingAuthorityReservation,
  ListingAuthoritySessionEvidence,
  ListingAuthorityPrincipal,
} from "@chase-sets/event-core/listing-authority";
import { requireListingAuthorityPrincipal } from "@chase-sets/event-core/listing-authority";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import { createListingAuthorityWriter } from "@chase-sets/platform-runtime/listing-authority-writer";
import {
  prepareListingSessionAuthority,
  prepareListingStandingAuthority,
  combineListingAuthorityReservations,
} from "@chase-sets/platform-runtime/listing-authority-fence";
import { randomUUID } from "node:crypto";
import { createIdentityListingCurrentFacts } from "./listing-current-facts";
import { decodeListingAccountFacts, decodeListingSellerFacts } from "./listing-authority-facts";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import { toJsonValue } from "@chase-sets/primitives/json";
import { createIdentitySecretAdapters } from "../../api-keys/api/secret-adapters";
import {
  createIdentityListingPolicy,
  identityListingParticipant,
  identityListingResources,
} from "./listing-authority-policy";
import {
  identityCredentialResource,
  type IdentityCredentialMutation,
  type IdentityCredentialStore,
} from "./listing-credentials";

export type IdentityListingAuthorityHostPorts = Readonly<{
  listingAuthorityConsumer(operation: ListingAuthorityOperation): ListingAuthorityConsumerPort;
  sessionAuthority?: ListingAuthoritySessionAuthorityPort;
  standingAuthority?(operation: ListingAuthorityOperation): ListingAuthorityStandingAuthorityPort;
}>;
export class IdentityAuthorityMutationPendingError extends HTTPException {
  readonly code = "identity_authority_mutation_pending";
  constructor(
    public readonly mutationId: string,
    cause: unknown,
  ) {
    const message = "Identity mutation is pending; resume the same mutation identity.";
    super(503, {
      message,
      cause,
      res: Response.json(
        { error: { code: "identity_authority_mutation_pending", mutationId, message } },
        { status: 503 },
      ),
    });
  }
}
const mounted = new WeakMap<EventStore, IdentityListingAuthorityServices>();
export function identityAuthorityMutationErrorHandler(error: Error, context: Context): Response {
  return error instanceof IdentityAuthorityMutationPendingError ? error.getResponse() : errorHandler(error, context);
}
const intentPrefix = "identity.authority-write-intent-";
function aggregateResource(streamId: string) {
  if (streamId.startsWith("identity.user-preferences-")) return null;
  for (const kind of ["account", "user", "membership", "api-key"] as const) {
    const prefix = `identity.${kind}-`;
    if (streamId.startsWith(prefix)) return `${kind}/${streamId.slice(prefix.length)}`;
  }
  return null;
}

export function createIdentityListingAuthority(
  deps: Readonly<{ eventStore: EventStore; credentials?: IdentityCredentialStore }> &
    Partial<IdentityListingAuthorityHostPorts>,
) {
  const raw = deps.eventStore;
  const policy = createIdentityListingPolicy(raw, deps.credentials);
  const secrets = createIdentitySecretAdapters();
  const consumer = (operation: ListingAuthorityOperation) => {
    if (!deps.listingAuthorityConsumer) throw new Error("Identity authority consumer is not mounted.");
    return deps.listingAuthorityConsumer(operation);
  };
  async function upstream(operation: ListingAuthorityOperation, context: EventStoreContext) {
    const p = requireListingAuthorityPrincipal(context);
    if (p.kind === "standing-system") {
      if (!deps.standingAuthority) throw new Error("Standing owner authority is not mounted.");
      return [await prepareListingStandingAuthority(operation, context, deps.standingAuthority(operation))];
    }
    if (p.authentication.kind === "session") {
      if (!deps.sessionAuthority) throw new Error("Auth session authority is not mounted.");
      return [await prepareListingSessionAuthority(operation, context, deps.sessionAuthority)];
    }
    return [];
  }
  const source = createListingAuthorityParticipant({
    eventStore: raw,
    participant: identityListingParticipant,
    resourceScope: "owner",
    consumer,
    resources: identityListingResources,
    validate: async (operation, context) => {
      await upstream(operation, context);
      return policy.validate(operation, context);
    },
  });
  const writer = createListingAuthorityWriter({
    eventStore: raw,
    source,
    owner: "identity",
    resources: async (inputs) => {
      const resources: string[] = [];
      for (const input of inputs) {
        if (!input.events.length) continue;
        const resource = aggregateResource(input.streamId);
        if (resource) resources.push(resource);
        if (input.streamId === "identity.founders-cohort-global") {
          for (const event of input.events) {
            if (typeof event.payload.accountId !== "string") throw new Error("Founder writer must name its account.");
            resources.push(`account/${event.payload.accountId}`);
          }
        }
      }
      return resources;
    },
  });
  async function resumeWrite(id: string) {
    try {
      const history = await readCompleteStream(raw, { streamId: `${intentPrefix}${id}` });
      const inputs = history[0]?.payload.inputs as unknown as readonly AppendToStreamInput[];
      if (history.length !== 1 || !Array.isArray(inputs) || !inputs.length)
        throw new Error("Unknown Identity write intent.");
      return await writer.eventStore.appendToStreams!(inputs);
    } catch (cause) {
      if ((cause as { code?: string }).code === "concurrency_conflict") throw cause;
      throw new IdentityAuthorityMutationPendingError(id, cause);
    }
  }
  async function append(inputs: readonly AppendToStreamInput[]) {
    if (
      !inputs.some(
        (input) =>
          input.events.length &&
          (aggregateResource(input.streamId) || input.streamId === "identity.founders-cohort-global"),
      )
    )
      return writer.eventStore.appendToStreams!(inputs);
    const id = `identity-write-${randomUUID()}`;
    try {
      await raw.appendToStream({
        streamId: `${intentPrefix}${id}`,
        expectedVersion: 0,
        context: inputs[0]!.context,
        events: [{ eventType: "identity.authority-write-intent.recorded", payload: { inputs: toJsonValue(inputs) } }],
      });
      return await resumeWrite(id);
    } catch (cause) {
      if (
        cause instanceof IdentityAuthorityMutationPendingError ||
        (cause as { code?: string }).code === "concurrency_conflict"
      )
        throw cause;
      throw new IdentityAuthorityMutationPendingError(id, cause);
    }
  }
  const eventStore: EventStore = {
    ...writer.eventStore,
    appendToStream: async (input) => (await append([input]))[0]!.storedEvents,
    appendToStreams: append,
  };
  async function resumeCredential(mutationId: string) {
    try {
      if (!deps.credentials) throw new Error("Identity credential persistence is not mounted.");
      const retained = await deps.credentials.readMutation(mutationId);
      if (!retained) throw new Error("Unknown Identity credential mutation.");
      await source.mutate({
        mutationId,
        resources: [identityCredentialResource(retained.command)],
        command: { kind: retained.command.kind, mutationId, resourceId: identityCredentialResource(retained.command) },
        context: retained.context,
        prepare: async () => {
          await deps.credentials!.apply(mutationId);
          return [];
        },
      });
      const receipt = await deps.credentials.readMutation(mutationId);
      if (!receipt?.applied) throw new Error("Missing Identity credential receipt.");
      await deps.credentials.complete(mutationId);
      return receipt.result;
    } catch (cause) {
      throw new IdentityAuthorityMutationPendingError(mutationId, cause);
    }
  }
  const services = {
    accountFacts: decodeListingAccountFacts,
    sellerFacts: decodeListingSellerFacts,
    readCurrentSeller: createIdentityListingCurrentFacts(raw),
    source,
    port: source,
    eventStore,
    async prepareAuthorities(operation: ListingAuthorityOperation, context: EventStoreContext) {
      const grants = await upstream(operation, context);
      grants.push(await source.prepare(operation, context));
      return combineListingAuthorityReservations(operation, grants);
    },
    async principalFromSession(
      evidence: ListingAuthoritySessionEvidence,
      membershipId: string,
      delegation: Extract<ListingAuthorityPrincipal, { kind: "user" }>["delegation"] = null,
    ): Promise<ListingAuthorityPrincipal> {
      const m = await policy.membership(membershipId);
      if (
        m.tenantId !== evidence.tenantId ||
        m.state.userId !== evidence.userId ||
        m.state.accountId !== evidence.accountId ||
        m.state.status !== "active"
      )
        throw new Error("Selected membership does not match Auth evidence.");
      return { ...evidence, kind: "user", membershipId, delegation };
    },
    async authenticateApiKey(
      secret: string,
      membershipId: string,
      validBefore: string,
    ): Promise<ListingAuthorityPrincipal | null> {
      const credential = await deps.credentials?.authenticateApiKey(secrets.hashSecret(secret));
      if (!credential?.authority_revision) return null;
      const key = await policy.apiKey(credential.api_key_id);
      const m = await policy.membership(membershipId);
      const scope = key.state.listingScope;
      if (scope) {
        if (
          scope.accountId !== m.state.accountId ||
          scope.membershipId !== membershipId ||
          scope.permissions.length !== 1 ||
          scope.permissions[0] !== "listings.manage"
        )
          return null;
        const deadline = Math.min(Date.parse(validBefore), Date.parse(scope.expiresAt));
        if (!(Date.now() < deadline)) return null;
        validBefore = new Date(deadline).toISOString();
      }
      if (
        !key.tenantId ||
        key.state.status !== "active" ||
        key.state.userId !== credential.user_id ||
        key.state.keyPrefix !== credential.key_prefix ||
        m.tenantId !== key.tenantId ||
        m.state.userId !== credential.user_id ||
        m.state.status !== "active" ||
        !m.state.accountId ||
        !(Date.now() < Date.parse(validBefore))
      )
        return null;
      return {
        kind: "user",
        tenantId: key.tenantId,
        userId: credential.user_id,
        accountId: m.state.accountId,
        membershipId,
        authentication: {
          kind: "api-key",
          keyId: credential.api_key_id,
          revision: `${key.revision}:${credential.authority_revision}`,
        },
        delegation: null,
        validBefore,
      };
    },
    async authenticateDelegation(secret: string, membershipId: string): Promise<ListingAuthorityPrincipal | null> {
      const d = await deps.credentials?.authenticateDelegation(secrets.hashSecret(secret));
      if (
        !d?.authority_revision ||
        d.status !== "active" ||
        !(Date.now() < new Date(d.access_token_expires_at).getTime())
      )
        return null;
      const m = await policy.membership(membershipId);
      const u = await policy.user(d.user_id);
      if (
        !m.tenantId ||
        u.tenantId !== m.tenantId ||
        m.state.userId !== d.user_id ||
        m.state.accountId !== d.account_id ||
        m.state.status !== "active" ||
        u.state.status !== "active"
      )
        return null;
      return {
        kind: "user",
        tenantId: m.tenantId,
        userId: d.user_id,
        accountId: d.account_id,
        membershipId,
        authentication: {
          kind: "delegation",
          delegationId: d.authorization_id,
          revision: d.authority_revision,
          scopeCeiling: d.scopes,
        },
        delegation: null,
        validBefore: new Date(d.access_token_expires_at).toISOString(),
      };
    },
    async credentialContext(userId: string, accountId: string): Promise<EventStoreContext> {
      const a = await policy.account(accountId);
      const u = await policy.user(userId);
      if (!a.state.id || !u.state.id || !a.tenantId || a.tenantId !== u.tenantId)
        throw new Error("Credential owner history is missing or mismatched.");
      return { tenantId: a.tenantId, audit: { performedByUserId: u.state.id, forAccountId: a.state.id } };
    },
    async mutateCredential(input: IdentityCredentialMutation) {
      try {
        if (!deps.credentials) throw new Error("Identity credential persistence is not mounted.");
        await deps.credentials.stage(input);
      } catch (cause) {
        throw new IdentityAuthorityMutationPendingError(input.mutationId, cause);
      }
      return resumeCredential(input.mutationId);
    },
    resumeCredential,
    resumeWrite,
    async resumeMutation(id: string, context: EventStoreContext) {
      if (id.startsWith("identity-write-")) return resumeWrite(id);
      if (id.startsWith("writer-")) return writer.resume(id, context);
      return resumeCredential(id);
    },
    async recoverPage(input: Readonly<{ after?: string; credentialAfter?: string; limit?: number }> = {}) {
      const limit = input.limit ?? 25;
      const after = input.after ?? "0";
      if (!/^\d+$/.test(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid Identity recovery page.");
      const outcomes: { identity: string; status: "recovered" | "pending" }[] = [];
      async function recover(identity: string, run: () => Promise<unknown>) {
        try {
          await run();
          outcomes.push({ identity, status: "recovered" });
        } catch {
          outcomes.push({ identity, status: "pending" });
        }
      }
      const ids = (await deps.credentials?.pending(limit, input.credentialAfter)) ?? [];
      for (const id of ids) await recover(id, () => resumeCredential(id));
      const events = await raw.readAll({
        afterGlobalPosition: after as GlobalPosition,
        eventTypes: ["identity.authority-write-intent.recorded", "identity.listing-authority.reserved"],
        limit,
      });
      for (const event of events) {
        if (event.eventType === "identity.authority-write-intent.recorded") {
          const id = event.streamId.slice(intentPrefix.length);
          await recover(id, () => resumeWrite(id));
        } else {
          const reservation = event.payload.reservation as unknown as ListingAuthorityReservation;
          await recover(reservation.reservationId, async () => {
            const current = await source.inspect(reservation.operation);
            if (!current) throw new Error("Missing Identity promise.");
            if (current.status !== "reserved") return;
            let terminal = await consumer(reservation.operation).inspect(reservation.operation);
            if (terminal.status === "pending" && Date.now() >= Date.parse(current.validBefore))
              terminal = await consumer(reservation.operation).invalidate(
                reservation.operation,
                "identity-validity-ended",
              );
            if (terminal.status === "pending" || terminal.status === "unknown")
              throw new Error("Identity promise remains unresolved.");
            await source.settle(reservation.operation);
          });
        }
      }
      return {
        after: events.length === limit ? events.at(-1)!.globalPosition : "0",
        credentialAfter: ids.length === limit ? ids.at(-1)! : "",
        outcomes,
      };
    },
  };
  mounted.set(raw, services);
  mounted.set(eventStore, services);
  return services;
}
export type IdentityListingAuthorityServices = ReturnType<typeof createIdentityListingAuthority>;
/** Direct aggregate runtimes and service composition share the same guarded source. */
export function identityAuthorityEventStore(eventStore: EventStore): EventStore {
  return (mounted.get(eventStore) ?? createIdentityListingAuthority({ eventStore })).eventStore;
}
