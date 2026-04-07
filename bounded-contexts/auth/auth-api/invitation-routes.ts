import { createId } from "@chase-sets/primitives/typed-ids";
import { upsertPasswordCredential } from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../services";
import {
  createIdentityMutations,
  createOwnedUserDisplayName,
  getBootstrapContext,
  type AuthApiApp,
} from "./support";

export function registerInvitationRoutes(
  app: AuthApiApp,
  services: AuthServices,
) {
  app.post("/invitations/accept", async (c) => {
    const body = await c.req.json();
    const identityMutations = createIdentityMutations(c);
    const invitation = await services.identity.getInvitation(
      String(body.invitationId ?? ""),
    );
    if (!invitation || invitation.status !== "pending") {
      return c.json({ error: "Invitation is unavailable." }, 404);
    }

    let user = await services.identity.getUserByEmail(invitation.email);
    if (!user) {
      const identity = await identityMutations.createPersonalIdentity({
        email: invitation.email,
        displayName: createOwnedUserDisplayName(invitation.email),
      });
      user = await services.identity.getUser(identity.userId);
    }

    if (body.password) {
      const credentialId = createId("crd");
      await identityMutations.enablePasswordCredential({
        userId: user!.user_id,
        credentialId,
      });
      await upsertPasswordCredential(services.db, {
        credentialId,
        userId: user!.user_id,
        secretHash: services.auth.hashSecret(String(body.password)),
      });
    }

    const membership = await identityMutations.acceptInvitationForUser({
      invitationId: String(body.invitationId ?? ""),
      userId: user!.user_id,
      accountId: invitation.account_id,
      roleKey: invitation.role_key,
    });

    const authResult = await startInteractiveAuth(services, {
      userId: user!.user_id,
      accountId: invitation.account_id,
      authenticationMethod: body.password ? "password" : "magic-link",
      context: getBootstrapContext(c),
    });

    return c.json({
      ...authResult,
      invitationId: String(body.invitationId ?? ""),
      membershipId: membership.membershipId,
    });
  });
}
