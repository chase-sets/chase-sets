import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getAccessHome, getAccountAccessHub, getUserAccountLink } from "../read-model/queries";

export function createAccessHubRuntime(deps: Readonly<{ db: PgQueryable }>) {
  return {
    getHome: (params?: Parameters<typeof getAccessHome>[1]) => getAccessHome(deps.db, params),
    getAccount: (accountId: string) => getAccountAccessHub(deps.db, accountId),
    getUserAccountLink: (userId: string) => getUserAccountLink(deps.db, userId),
  };
}

export type AccessHubServices = ReturnType<typeof createAccessHubRuntime>;
