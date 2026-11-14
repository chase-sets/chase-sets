import { ConfigurationEpochError, type ConfigurationConsumer } from "@chase-sets/event-core/configuration-epoch";
import { CONFIGURATION_EPOCH_LOCK_SQL, type PgQueryable } from "@chase-sets/event-core-postgres";
import type { IdentityMutationPersistence } from "../../account-management/api/fences";
import { validateOwnerHistory } from "../../account-management/api/owners";
import { identityOwnerStream, type IdentityOwnerEpochs } from "./owner-epochs";
import type { LinkedPlatformAuthorizationRow } from "../../../support/ucp-support/linked-platform-authorizations";

export type ListingActivationAuthorityInput = Readonly<{
  tenantId: string;
  accountId: string;
  userId: string;
  membershipId: string;
  delegationId?: string;
  consumer: ConfigurationConsumer;
}>;
type AuthorityEpochs = Readonly<{
  source: () => Promise<
    Pick<Awaited<ReturnType<IdentityOwnerEpochs["source"]>>, "captureGrantInTransaction" | "registerConsumer">
  >;
}>;

/** Class C: no per-Listing promise or reservation, and no projection/snapshot authority. */
export function createIdentityListingActivationAuthority(
  persistence: IdentityMutationPersistence,
  ownerEpochs: AuthorityEpochs,
) {
  return {
    async capture(input: ListingActivationAuthorityInput) {
      const keys = [`account/${input.accountId}`, `user/${input.userId}`, `membership/${input.membershipId}`];
      if (input.delegationId !== undefined) keys.push(`delegation/${input.delegationId}`);
      try {
        const source = await ownerEpochs.source();
        return await persistence.transaction([], async (tx) => {
          const db: PgQueryable = tx.db;
          for (const key of [...keys].sort()) await db.query(CONFIGURATION_EPOCH_LOCK_SQL, [key]);
          const histories = await Promise.all(keys.slice(0, 3).map((key) => tx.read(identityOwnerStream(key))));
          const [account, user, membership] = keys
            .slice(0, 3)
            .map((key, index) =>
              validateOwnerHistory(
                key.split("/")[0] as "account" | "user" | "membership",
                histories[index],
                input.tenantId,
              ),
            );
          if (
            account.kind !== "account" ||
            user.kind !== "user" ||
            membership.kind !== "membership" ||
            account.state.id !== input.accountId ||
            account.state.status !== "active" ||
            user.state.id !== input.userId ||
            user.state.status !== "active" ||
            membership.state.id !== input.membershipId ||
            membership.state.status !== "active" ||
            membership.state.userId !== input.userId ||
            membership.state.accountId !== input.accountId ||
            (membership.state.roleKey !== "owner" && membership.state.roleKey !== "manager")
          )
            return { kind: "denied", reason: "identity-authority-unavailable" } as const;
          let delegation: LinkedPlatformAuthorizationRow | undefined;
          if (input.delegationId !== undefined) {
            const rows = await db.query<LinkedPlatformAuthorizationRow>(
              `SELECT * FROM identity_linked_platform_authorizations
               WHERE authorization_id = $1 AND account_id = $2 AND user_id = $3 AND status = 'active'
                 AND scopes ? 'listings:write' AND access_token_expires_at > now()
                 AND (absolute_expires_at IS NULL OR absolute_expires_at > now())`,
              [input.delegationId, input.accountId, input.userId],
            );
            delegation = rows.rows[0];
            if (rows.rows.length !== 1) return { kind: "denied", reason: "identity-authority-unavailable" } as const;
          }
          const grants = await Promise.all(
            keys.map((key) =>
              source.captureGrantInTransaction(
                db,
                key,
                input.consumer,
                key.startsWith("delegation/") && delegation
                  ? new Date(
                      Math.min(
                        new Date(delegation.access_token_expires_at).getTime(),
                        delegation.absolute_expires_at ? new Date(delegation.absolute_expires_at).getTime() : Infinity,
                      ),
                    ).toISOString()
                  : undefined,
              ),
            ),
          );
          const seal = (index: number, version: number) => ({
            version,
            storeIncarnation: grants[index].sourceIncarnation,
          });
          return {
            kind: "granted" as const,
            account: { state: account.state, seal: seal(0, histories[0].length) },
            user: { state: user.state, seal: seal(1, histories[1].length) },
            membership: { state: membership.state, seal: seal(2, histories[2].length) },
            delegation: delegation
              ? {
                  state: {
                    id: delegation.authorization_id,
                    userId: delegation.user_id,
                    accountId: delegation.account_id,
                    clientId: delegation.client_id,
                    platformProfileUrl: delegation.platform_profile_url,
                    scopes: delegation.scopes,
                    status: delegation.status,
                    accessTokenExpiresAt: delegation.access_token_expires_at,
                    refreshTokenExpiresAt: delegation.refresh_token_expires_at,
                    absoluteExpiresAt: delegation.absolute_expires_at ?? null,
                  },
                  seal: seal(3, grants[3].epoch),
                }
              : undefined,
            grants,
          };
        });
      } catch (error) {
        if (error instanceof ConfigurationEpochError || (error instanceof Error && error.message === "INDETERMINATE"))
          return { kind: "denied", reason: "identity-authority-unavailable" } as const;
        throw error;
      }
    },
    async registerConsumer(input: Omit<ListingActivationAuthorityInput, "tenantId">) {
      const source = await ownerEpochs.source();
      for (const key of [
        `account/${input.accountId}`,
        `user/${input.userId}`,
        `membership/${input.membershipId}`,
        ...(input.delegationId !== undefined ? [`delegation/${input.delegationId}`] : []),
      ].sort())
        await source.registerConsumer(key, input.consumer);
    },
  };
}
