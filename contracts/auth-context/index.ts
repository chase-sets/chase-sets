import type { EventStoreContext } from "@chase-sets/event-core/storage";

export type ResolvedActor = Readonly<{
  sessionId: string;
  tenantId: string;
  userId: string;
  accountId: string;
  membershipId: string;
  roleKey: string;
  permissions: readonly string[];
}>;

export type AuthenticatedRequestVariables<
  TActor extends ResolvedActor = ResolvedActor,
> = {
  actor: TActor | null;
  context: EventStoreContext | null;
};

export type AuthenticatedApiEnv<
  TActor extends ResolvedActor = ResolvedActor,
> = {
  Variables: AuthenticatedRequestVariables<TActor>;
};
