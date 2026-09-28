import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { DomainEvent, AggregateEvolver } from "@chase-sets/event-core";
import type { ListingAuthorityOperation } from "@chase-sets/event-core/listing-authority";
import type { EventStoreContext, AppendToStreamInput } from "@chase-sets/event-core/storage";
import { resolveAgentOAuthScopedPermissions } from "@chase-sets/auth-context";
import { createHash } from "node:crypto";
import { evolveAccount, initialAccountState, type AccountEvent } from "../../accounts/domain/domain";
import { evolveUser, initialUserState, type UserEvent } from "../../users/domain/domain";
import { evolveMembership, initialMembershipState, type MembershipEvent } from "../../memberships/domain/domain";
import { evolveApiKey, initialApiKeyState, type ApiKeyEvent } from "../../api-keys/domain/domain";
import { ROLE_PERMISSIONS } from "../../memberships/read-model/constants";
import type { IdentityCredentialStore } from "./listing-credentials";

export const identityListingParticipant = { owner: "identity", purpose: "manage-listing" } as const;
export function identityListingResources(operation: ListingAuthorityOperation): readonly string[] {
  const p = operation.principal;
  if (!p) throw new Error("Identity requires the original authenticated principal.");
  const resources = [`account/${operation.accountId}`];
  if (p.kind === "user") {
    resources.push(`user/${p.userId}`, `membership/${p.membershipId}`);
    if (p.authentication.kind === "api-key") resources.push(`api-key/${p.authentication.keyId}`);
    if (p.authentication.kind === "delegation") resources.push(`delegation/${p.authentication.delegationId}`);
    if (p.delegation) resources.push(`delegation/${p.delegation.delegationId}`);
  }
  return [...new Set(resources)].sort();
}

export function createIdentityListingPolicy(eventStore: EventStore, credentials?: IdentityCredentialStore) {
  async function load<State, Event extends DomainEvent>(
    streamId: string,
    initial: State,
    evolve: AggregateEvolver<State, Event>,
  ) {
    const events = await readCompleteStream(eventStore, { streamId });
    const tenantId = events[0]?.tenantId;
    if (events.some((event) => event.tenantId !== tenantId))
      throw new Error("Identity tenant history is inconsistent.");
    const codec = createPassthroughDomainEventCodec<Event>();
    return {
      state: events.reduce((state, event) => evolve(state, codec.decode(event)), initial),
      revision: String(events.at(-1)?.streamVersion ?? 0),
      lastEventId: events.at(-1)?.eventId ?? null,
      tenantId,
      streamId,
    };
  }
  const account = (id: string) =>
    load<typeof initialAccountState, AccountEvent>(`identity.account-${id}`, initialAccountState, evolveAccount);
  const membership = (id: string) =>
    load<typeof initialMembershipState, MembershipEvent>(
      `identity.membership-${id}`,
      initialMembershipState,
      evolveMembership,
    );
  const user = (id: string) =>
    load<typeof initialUserState, UserEvent>(`identity.user-${id}`, initialUserState, evolveUser);
  const apiKey = (id: string) =>
    load<typeof initialApiKeyState, ApiKeyEvent>(`identity.api-key-${id}`, initialApiKeyState, evolveApiKey);

  return {
    account,
    membership,
    user,
    apiKey,
    async validate(operation: ListingAuthorityOperation, context: EventStoreContext) {
      const p = operation.principal;
      if (
        !p ||
        p.tenantId !== operation.tenantId ||
        p.accountId !== operation.accountId ||
        p.userId !== operation.actor.userId
      )
        throw new Error("Identity principal binding mismatch.");
      const a = await account(operation.accountId);
      if (a.tenantId !== p.tenantId || a.state.id !== operation.accountId || a.state.status !== "active")
        throw new Error("Account authority is not active.");
      let deadline = Math.min(Date.parse(operation.prepareBefore), Date.parse(p.validBefore));
      const sourceRevisions = [{ resourceId: `account/${operation.accountId}`, revision: a.revision }];
      const localAppends: AppendToStreamInput[] = [
        { streamId: a.streamId, expectedVersion: Number(a.revision), events: [], context },
      ];
      if (p.kind === "standing-system") {
        if (!p.scopeCeiling.includes("listings.manage"))
          throw new Error("Standing authority does not permit listing management.");
      } else {
        const [u, m] = await Promise.all([user(p.userId), membership(p.membershipId)]);
        if (
          u.tenantId !== p.tenantId ||
          u.state.id !== p.userId ||
          u.state.status !== "active" ||
          m.tenantId !== p.tenantId ||
          m.state.id !== p.membershipId ||
          m.state.userId !== p.userId ||
          m.state.accountId !== p.accountId ||
          m.state.status !== "active" ||
          !m.state.roleKey
        )
          throw new Error("Selected Identity user or membership is not active for this account.");
        const permissions: readonly string[] = ROLE_PERMISSIONS[m.state.roleKey];
        if (!permissions.includes("listings.manage")) throw new Error("Selected membership cannot manage listings.");
        sourceRevisions.push(
          { resourceId: `user/${p.userId}`, revision: u.revision },
          { resourceId: `membership/${p.membershipId}`, revision: m.revision },
          {
            resourceId: `role/${m.state.roleKey}`,
            revision: createHash("sha256").update(JSON.stringify(permissions)).digest("hex"),
          },
        );
        localAppends.push(
          ...[u, m].map((loaded) => ({
            streamId: loaded.streamId,
            expectedVersion: Number(loaded.revision),
            events: [],
            context,
          })),
        );
        if (p.authentication.kind === "api-key") {
          const key = await apiKey(p.authentication.keyId);
          const credential = await credentials?.readApiKey(p.authentication.keyId);
          const scope = key.state.listingScope;
          if (scope) {
            if (
              scope.accountId !== p.accountId ||
              scope.membershipId !== p.membershipId ||
              scope.permissions.length !== 1 ||
              scope.permissions[0] !== "listings.manage"
            )
              throw new Error("Selected API key does not permit this listing account or membership.");
            deadline = Math.min(deadline, Date.parse(scope.expiresAt));
          }
          if (
            key.tenantId !== p.tenantId ||
            key.state.id !== p.authentication.keyId ||
            key.state.status !== "active" ||
            key.state.userId !== p.userId ||
            !credential?.authority_revision ||
            credential.user_id !== p.userId ||
            credential.key_prefix !== key.state.keyPrefix ||
            p.authentication.revision !== `${key.revision}:${credential.authority_revision}`
          )
            throw new Error("Selected API key authority is no longer valid.");
          sourceRevisions.push({
            resourceId: `api-key/${p.authentication.keyId}`,
            revision: p.authentication.revision,
          });
          localAppends.push({ streamId: key.streamId, expectedVersion: Number(key.revision), events: [], context });
        }
        const delegations = [p.authentication.kind === "delegation" ? p.authentication : null, p.delegation].filter(
          (d): d is NonNullable<typeof d> => d !== null,
        );
        for (const selected of delegations) {
          const d = await credentials?.readDelegation(selected.delegationId);
          if (
            !d?.authority_revision ||
            d.authority_revision !== selected.revision ||
            d.user_id !== p.userId ||
            d.account_id !== p.accountId ||
            d.status !== "active" ||
            selected.scopeCeiling.some((scope) => !d.scopes.includes(scope)) ||
            !resolveAgentOAuthScopedPermissions(selected.scopeCeiling, permissions).includes("listings.manage")
          )
            throw new Error("Selected delegation cannot manage listings.");
          deadline = Math.min(deadline, new Date(d.access_token_expires_at).getTime());
          const resourceId = `delegation/${selected.delegationId}`;
          const prior = sourceRevisions.find((r) => r.resourceId === resourceId);
          if (prior && prior.revision !== selected.revision) throw new Error("Conflicting delegation revisions.");
          if (!prior) sourceRevisions.push({ resourceId, revision: selected.revision });
        }
      }
      if (!(Date.now() < deadline)) throw new Error("Identity authority has expired.");
      return {
        value: {
          accountId: operation.accountId,
          accountType: a.state.accountType,
          badges: a.state.badges,
          founderNumber: a.state.founderNumber,
          foundersWindow: a.state.foundersWindow,
        },
        sourceRevisions,
        localAppends,
        validBefore: new Date(deadline).toISOString(),
      };
    },
  };
}
