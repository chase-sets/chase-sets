import { randomUUID } from "node:crypto";
import { ConfigurationEpochError, type ConfigurationConsumer } from "@chase-sets/event-core/configuration-epoch";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import {
  createPostgresConfigurationEpochStore,
  withConfigurationEpochTransaction,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { AccountEvent } from "../domain/domain";
import type { UserEvent } from "../../users/domain/domain";
import type { MembershipEvent } from "../../memberships/domain/domain";

export type IdentitySourceTopology = readonly Readonly<{
  identity: ConfigurationConsumer;
  pool: PgTransactionalPool;
}>[];

const prefixes = {
  account: "identity.account-",
  user: "identity.user-",
  membership: "identity.membership-",
} as const;

// The class-C consumed fields are id/status and Membership's exact user/account/role binding.
export const identityAuthorityEventClassification = {
  "identity.account.created": "consumed",
  "identity.account.suspended": "consumed",
  "identity.account.reactivated": "consumed",
  "identity.account.closed": "consumed",
  "identity.account.profile-updated": "unchanged",
  "identity.account.badge-assigned": "unchanged",
  "identity.account.badge-removed": "unchanged",
  "identity.account.founders-window-opened": "unchanged",
  "identity.user.created": "consumed",
  "identity.user.suspended": "consumed",
  "identity.user.reactivated": "consumed",
  "identity.user.profile-updated": "unchanged",
  "identity.user.contact-method-added": "unchanged",
  "identity.user.contact-method-verified": "unchanged",
  "identity.user.auth-method-enabled": "unchanged",
  "identity.user.auth-method-disabled": "unchanged",
  "identity.user.password-credential-attached": "unchanged",
  "identity.user.passkey-registered": "unchanged",
  "identity.user.social-login-linked": "unchanged",
  "identity.membership.granted": "consumed",
  "identity.membership.role-changed": "consumed",
  "identity.membership.revoked": "consumed",
  "identity.membership.reinstated": "consumed",
} satisfies Record<AccountEvent["type"] | UserEvent["type"] | MembershipEvent["type"], "consumed" | "unchanged">;
export const identityAuthorityEvents = new Set(
  Object.entries(identityAuthorityEventClassification)
    .filter(([, effect]) => effect === "consumed")
    .map(([type]) => type),
);

export function identityOwnerKey(streamId: string): string | undefined {
  if (streamId.startsWith("identity.user-preferences-") || streamId.startsWith("identity.account-capability-"))
    return undefined;
  for (const [kind, prefix] of Object.entries(prefixes)) {
    if (streamId.startsWith(prefix) && streamId.length > prefix.length)
      return `${kind}/${streamId.slice(prefix.length)}`;
  }
  return undefined;
}

export function identityOwnerStream(key: string): string {
  const [kind, ...id] = key.split("/");
  const prefix = prefixes[kind as keyof typeof prefixes];
  if (!prefix || !id.join("/")) throw new ConfigurationEpochError("unknown Identity owner key");
  return `${prefix}${id.join("/")}`;
}

export class IdentityClosureRequired extends Error {
  constructor(readonly keys: readonly string[]) {
    super("Identity owner closure required");
  }
}

export function createIdentityOwnerEpochs(pool: PgTransactionalPool, consumers: IdentitySourceTopology = []) {
  async function source(db?: PgQueryable) {
    async function readSource(client: PgQueryable) {
      await client.query(
        "INSERT INTO event_configuration_store_identity (singleton, store_id, incarnation) VALUES (true, 'identity', $1) ON CONFLICT DO NOTHING",
        [randomUUID()],
      );
      const result = await client.query<{ store_id: string; incarnation: string }>(
        "SELECT store_id, incarnation FROM event_configuration_store_identity WHERE singleton = true",
      );
      const identity = result.rows[0];
      if (result.rows.length !== 1 || identity?.store_id !== "identity")
        throw new ConfigurationEpochError("Identity source incarnation unavailable");
      const sourceIncarnation = identity.incarnation;
      return createPostgresConfigurationEpochStore({
        pool,
        sourceIncarnation,
        consumers,
        async readCanonicalCreation(db, key) {
          const rows = await db.query<{ event_type: string; stream_version: number }>(
            "SELECT event_type, stream_version FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version LIMIT 1",
            [identityOwnerStream(key)],
          );
          const first = rows.rows[0];
          const kind = key.split("/")[0];
          if (
            !first ||
            Number(first.stream_version) !== 1 ||
            first.event_type !== `identity.${kind}.${kind === "membership" ? "granted" : "created"}`
          )
            throw new ConfigurationEpochError("Identity canonical creation unavailable");
          return { kind: "CREATED", sourceIncarnation, keyCreationEpoch: 0 };
        },
      });
    }
    return db ? readSource(db) : withConfigurationEpochTransaction(pool, readSource);
  }

  return {
    source,
    async enroll(db: PgQueryable, inputs: readonly AppendToStreamInput[]) {
      const changed = inputs.filter(
        (input) =>
          identityOwnerKey(input.streamId) &&
          input.events.some((event) => identityAuthorityEvents.has(event.eventType)),
      );
      if (!changed.length) return;
      const epochs = await source(db);
      const keys: string[] = [];
      for (const input of [...changed].sort((a, b) => a.streamId.localeCompare(b.streamId))) {
        const existing = await db.query<{ stream_version: number }>(
          "SELECT stream_version FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version LIMIT 1",
          [input.streamId],
        );
        // New owners cannot have an issued grant; their committed creation is their OPEN epoch zero.
        if (!existing.rows.length) continue;
        const key = identityOwnerKey(input.streamId)!;
        const status = await epochs.beginClosureInTransaction(db, key);
        if (status.pendingConsumers.length) keys.push(key);
        else await epochs.installClosureInTransaction(db, key);
      }
      if (keys.length) throw new IdentityClosureRequired(keys);
    },
  };
}

export type IdentityOwnerEpochs = ReturnType<typeof createIdentityOwnerEpochs>;
