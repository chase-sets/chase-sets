import { ConfigurationEpochError, type ConfigurationConsumer } from "@chase-sets/event-core/configuration-epoch";
import { CONFIGURATION_EPOCH_LOCK_SQL } from "@chase-sets/event-core-postgres";
import type { IdentityMutationPersistence } from "../../account-management/api/fences";
import { validateOwnerHistory } from "../../account-management/api/owners";
import { identityOwnerStream, type IdentityOwnerEpochs } from "./owner-epochs";

export type ListingActivationAuthorityInput = Readonly<{
  tenantId: string;
  accountId: string;
  userId: string;
  membershipId: string;
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
      try {
        const source = await ownerEpochs.source();
        return await persistence.transaction([], async (tx) => {
          for (const key of [...keys].sort()) await tx.db.query(CONFIGURATION_EPOCH_LOCK_SQL, [key]);
          const histories = await Promise.all(keys.map((key) => tx.read(identityOwnerStream(key))));
          const [account, user, membership] = keys.map((key, index) =>
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
          const grants = await Promise.all(
            keys.map((key) => source.captureGrantInTransaction(tx.db, key, input.consumer)),
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
      ].sort())
        await source.registerConsumer(key, input.consumer);
    },
  };
}
