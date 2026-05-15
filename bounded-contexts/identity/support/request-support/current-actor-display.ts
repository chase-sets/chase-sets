import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";

type AccountDisplaySource = Readonly<{
  account_id: string;
  display_name: string;
  name: string;
}> | null;

type MembershipDisplaySource = Readonly<{
  membership_id: string;
  role_key: string;
}> | null;

type UserDisplaySource = Readonly<{
  user_id: string;
  display_name: string;
  primary_email: string | null;
}> | null;

export type CurrentActorDisplay = Readonly<{
  account: Readonly<{
    account_id: string;
    display_name: string | null;
    name: string | null;
  }>;
  membership: Readonly<{
    membership_id: string;
    role_key: string;
  }>;
  user: Readonly<{
    user_id: string;
    display_name: string | null;
    primary_email: string | null;
  }>;
}>;

export function buildCurrentActorDisplay(
  actor: ResolvedActor,
  facts: Readonly<{
    account: AccountDisplaySource;
    membership: MembershipDisplaySource;
    user: UserDisplaySource;
  }>,
): CurrentActorDisplay {
  return {
    account: {
      account_id: actor.accountId,
      display_name: facts.account?.display_name ?? null,
      name: facts.account?.name ?? null,
    },
    membership: {
      membership_id: facts.membership?.membership_id ?? actor.membershipId,
      role_key: facts.membership?.role_key ?? actor.roleKey,
    },
    user: {
      user_id: actor.userId,
      display_name: facts.user?.display_name ?? null,
      primary_email: facts.user?.primary_email ?? null,
    },
  };
}
