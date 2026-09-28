import type { ResolvedActor } from "@chase-sets/auth-context";
import type {
  ListingAuthorityPrincipal,
  ListingAuthoritySessionEvidence,
} from "@chase-sets/event-core/listing-authority";
import type { IdentityListingAuthorityServices } from "./listing-authority";

export function createListingRequestPrincipalResolver(
  authority: Pick<IdentityListingAuthorityServices, "principalFromSession" | "authenticateDelegation">,
  sessionEvidence: (request: Request) => Promise<ListingAuthoritySessionEvidence | null>,
) {
  return async (request: Request, actor: ResolvedActor): Promise<ListingAuthorityPrincipal | null> => {
    let principal: ListingAuthorityPrincipal | null;
    if (actor.agentGrant) {
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) return null;
      principal = await authority.authenticateDelegation(authorization.slice(7).trim(), actor.membershipId);
      if (
        principal?.kind !== "user" ||
        principal.authentication.kind !== "delegation" ||
        principal.authentication.delegationId !== actor.agentGrant.grantId
      )
        return null;
    } else {
      const evidence = await sessionEvidence(request);
      if (!evidence || evidence.authentication.sessionId !== actor.sessionId) return null;
      principal = await authority.principalFromSession(evidence, actor.membershipId);
    }
    if (
      principal.tenantId !== actor.tenantId ||
      principal.userId !== actor.userId ||
      principal.accountId !== actor.accountId
    )
      return null;
    return principal;
  };
}
